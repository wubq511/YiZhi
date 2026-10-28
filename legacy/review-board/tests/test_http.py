"""Exercise the real HTTP/service/store boundary on disposable course roots.

Knowledge semantics are deliberately a fixture; real knowledge queries are
covered by the integrator. No production server, course or assets are touched.
"""

from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import http.client
import json
from pathlib import Path
import sqlite3
import socket
import tempfile
import threading
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from reviewboard.http import CourseHTTPServer
from reviewboard.service import CourseService


class FixtureMapError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class FixtureCatalog:
    # HTTP's exception handler resolves this even when handling another error.
    module = SimpleNamespace(MapError=FixtureMapError)
    unit = {"id": "KU-035", "themeId": "TH-001", "title": "Fixture unit"}

    def unit_ids(self):
        return {self.unit["id"]}

    def get(self, identifier):
        if identifier != self.unit["id"]:
            raise FixtureMapError("not_found", "Fixture entity not found", {"id": identifier})
        return deepcopy(self.unit)

    def graph(self, view="main"):
        if view not in {"main", "auxiliary", "all"}:
            raise FixtureMapError("invalid_parameter", "Unknown fixture graph view")
        return {"sourceHash": "fixture-only", "counts": {"units": 1},
                "groups": [], "nodes": [deepcopy(self.unit)], "edges": []}

    def view(self):
        return {"sourceHash": "fixture-only", "catalogCounts": {"units": 1},
                "primaryIds": [self.unit["id"]], "units": [deepcopy(self.unit)],
                "themes": [], "sources": [], "edges": []}


class CourseHTTPTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "course"
        self.root.mkdir()
        self.app_root = Path(temporary.name) / "app"
        (self.app_root / "web").mkdir(parents=True)
        (self.app_root / "web/index.html").write_text("<p>fixture app</p>", encoding="utf-8")
        (self.app_root / "private.txt").write_text("PRIVATE-APP-MARKER", encoding="utf-8")
        self.secret = self.root / "private.txt"
        self.secret.write_text("PRIVATE-COURSE-MARKER", encoding="utf-8")
        # Do not inherit HTTP_PROXY settings when testing the loopback listener.
        self.client = build_opener(ProxyHandler({}))
        self.server = self.service = self.thread = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.service = CourseService(self.root, catalog=FixtureCatalog())
        self.server = CourseHTTPServer(("127.0.0.1", 0), self.service,
                                       self.app_root, "http-test-instance")
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=3)
            self.server = None
        if self.service is not None:
            self.service.close()
            self.service = None

    def request(self, path, *, command=None, origin=None, body=None,
                content_type="application/json", parse_json=True):
        headers = {}
        if command is not None:
            body = json.dumps(command, ensure_ascii=False).encode("utf-8")
        if body is not None:
            headers["Content-Type"] = content_type
            headers["Origin"] = self.origin if origin is None else origin
        request = Request(self.origin + path, data=body, headers=headers)
        try:
            response = self.client.open(request, timeout=5)
        except HTTPError as exc:
            response = exc
        with response:
            data = response.read()
            if parse_json:
                self.assertIn("application/json", response.headers.get("Content-Type", ""))
            return response.status, json.loads(data) if parse_json else data

    def get_json(self, path):
        status, payload = self.request(path)
        self.assertEqual(status, 200, payload)
        return payload

    def post(self, command, **kwargs):
        return self.request("/api/v1/commands", command=command, **kwargs)

    def assert_error(self, response, status, code):
        actual_status, payload = response
        self.assertEqual(actual_status, status, payload)
        self.assertEqual(payload["error"]["code"], code)
        self.assertIsInstance(payload["error"]["message"], str)
        self.assertIsInstance(payload["error"]["details"], dict)
        self.assertNotIn("saved", payload)

    @staticmethod
    def edit(operation_id="save-all"):
        return {
            "operationId": operation_id, "actor": "student", "kind": "edit", "generation": 1,
            "changes": [
                {"namespace": "notes", "key": "NOTE-1", "value": {
                    "noteId": "NOTE-1", "objectId": "KU-035", "text": "对象笔记 α",
                    "anchor": {"objectId": "KU-035", "quote": "保留原引用"}}},
                {"namespace": "review", "key": "KU-035", "value": {"status": "weak"}},
                {"namespace": "reading", "key": "default", "value": {
                    "selected": "KU-035", "mode": "detail",
                    "camera": {"x": 12, "y": -34, "scale": 0.75},
                    "expanded": ["BLOCK-1"], "revealed": ["EX-1"],
                    "history": ["KU-035"], "panels": {"notes": True}}},
            ],
            "expectedRevisions": {"notes:NOTE-1": 0, "review:KU-035": 0, "reading:default": 0},
        }

    def test_save_retry_conflict_and_server_restart_keep_state_and_event_cursor(self):
        course = self.get_json("/api/v1/course")
        self.assertEqual(course["state"], self.get_json("/api/v1/state"))
        self.assertEqual(course["state"]["documents"], {})
        self.assertEqual(course["state"]["courseId"], course["course"]["courseId"])
        self.assertEqual(self.get_json("/api/v1/entities/KU-035")["id"], "KU-035")
        self.assertEqual(len(self.get_json("/api/v1/graph?view=all")["nodes"]), 1)
        self.assert_error(self.request("/api/v1/entities/KU-missing"), 404, "not_found")

        change = self.edit()
        status, saved = self.post(change)
        self.assertEqual(status, 200, saved)
        self.assertIs(saved["saved"], True)
        self.assertEqual(saved["revisions"],
                         {"notes:NOTE-1": 1, "review:KU-035": 1, "reading:default": 1})
        snapshot = self.get_json("/api/v1/state")
        self.assertEqual(snapshot["documents"], {
            item["namespace"]: {item["key"]: {"value": item["value"], "revision": 1}}
            for item in change["changes"]})
        first_events = self.get_json("/api/v1/events?after=0")
        self.assertEqual([event["operationId"] for event in first_events["events"]], ["save-all"])
        self.assertEqual(first_events["events"][0]["changes"], saved["changes"])
        self.assertEqual(self.post(deepcopy(change)), (200, saved))

        conflict = self.edit("conflict")
        conflict["expectedRevisions"] = dict(saved["revisions"])
        conflict["expectedRevisions"]["reading:default"] = 0
        conflict["changes"][0]["value"]["text"] = "must not partly save"
        conflict["changes"][1]["value"]["status"] = "mastered"
        self.assert_error(self.post(conflict), 409, "revision_conflict")
        reused_id = deepcopy(change)
        reused_id["changes"][0]["value"]["text"] = "same ID, different payload"
        self.assert_error(self.post(reused_id), 400, "invalid_parameter")
        self.assertEqual(self.get_json("/api/v1/state"), snapshot)
        self.assertEqual(self.get_json("/api/v1/events?after=0"), first_events)

        later = self.edit("second")
        later["expectedRevisions"] = dict(saved["revisions"])
        later["changes"][0]["value"]["text"] = "newer persisted note"
        status, second = self.post(later)
        self.assertEqual(status, 200, second)
        self.assertEqual(second["sequence"], saved["sequence"] + 1)
        snapshot = self.get_json("/api/v1/state")
        cursor = first_events["sequence"]
        resumed = self.get_json(f"/api/v1/events?after={cursor}")
        self.assertEqual([event["operationId"] for event in resumed["events"]], ["second"])

        self.stop()
        self.start()  # Same course folder, a new service/store and random HTTP port.
        self.assertEqual(self.get_json("/api/v1/course")["state"], snapshot)
        self.assertEqual(self.get_json("/api/v1/state"), snapshot)
        self.assertEqual(self.post(change), (200, saved))  # Original stale CAS still deduplicates.
        self.assertEqual(self.get_json(f"/api/v1/events?after={cursor}"), resumed)
        self.assertEqual(self.get_json(f"/api/v1/events?after={second['sequence']}"),
                         {"events": [], "sequence": second["sequence"], "hasMore": False})
        self.assertEqual([event["sequence"] for event in
                          self.get_json("/api/v1/events?after=0")["events"]], [1, 2])

    def test_rejected_domain_and_http_requests_leave_no_saved_state(self):
        before = self.get_json("/api/v1/state")
        unknown_namespace = self.edit("unsupported")
        unknown_namespace["changes"][1]["namespace"] = "knowledge"
        invalid_status = self.edit("invalid-status")
        invalid_status["changes"][1]["value"]["status"] = "done"
        invalid_anchor = self.edit("invalid-anchor")
        invalid_anchor["changes"][0]["value"]["anchor"]["objectId"] = "KU-missing"
        invalid_camera = self.edit("invalid-camera")
        invalid_camera["changes"][2]["value"]["camera"]["scale"] = -0.004
        for command, status, code in (
            (unknown_namespace, 501, "capability_unavailable"),
            (invalid_status, 400, "invalid_content"),
            (invalid_anchor, 400, "invalid_content"),
            (invalid_camera, 400, "invalid_content"),
        ):
            with self.subTest(operation=command["operationId"]):
                result = self.post(command)
                self.assert_error(result, status, code)
                if command is invalid_camera:
                    self.assertEqual(result[1]["error"]["details"], {
                        "namespace": "reading", "key": "default", "field": "camera",
                        "operationId": "invalid-camera", "rejectedBeforeCommit": True})
        self.assert_error(self.request("/api/v1/not-a-route", command=self.edit()), 404, "not_found")
        self.assert_error(self.request("/api/v1/commands", body=b'{"operationId":'),
                          400, "invalid_parameter")
        self.assert_error(self.request("/api/v1/commands", command=self.edit(),
                                       content_type="text/plain"), 400, "invalid_parameter")
        self.assert_error(self.request("/api/v1/events?after=invalid"), 400, "invalid_parameter")
        self.assertEqual(self.get_json("/api/v1/state"), before)
        self.assertEqual(self.get_json("/api/v1/events?after=0"),
                         {"events": [], "sequence": 0, "hasMore": False})

    def test_origin_checks_and_static_paths_cannot_escape_allowed_roots(self):
        self.assert_error(self.post(self.edit(), origin="https://other.example"),
                          400, "invalid_parameter")
        self.assertEqual(self.get_json("/api/v1/state")["sequence"], 0)
        self.assertEqual(self.post(self.edit(), origin=self.origin)[0], 200)
        self.assertEqual(self.request("/", parse_json=False), (200, b"<p>fixture app</p>"))
        # urllib sends these exact encoded traversal paths; no browser normalization.
        for path in ("/web/%2e%2e/private.txt", "/assets/prototype/%2e%2e/private.txt",
                     "/sources/%2e%2e/%2e%2e/private.txt"):
            with self.subTest(path=path):
                self.assert_error(self.request(path), 400, "invalid_parameter")
        (self.app_root / "web/linked.txt").symlink_to(self.secret)
        self.assert_error(self.request("/web/linked.txt"), 400, "invalid_parameter")

    def test_real_sqlite_abort_returns_503_without_partial_state_or_event(self):
        self.assertEqual(self.post(self.edit())[0], 200)
        before = self.get_json("/api/v1/state")
        events = self.get_json("/api/v1/events?after=0")
        db_path = self.root / self.service.manifest["state"]
        with closing(sqlite3.connect(db_path)) as db, db:
            db.execute("CREATE TRIGGER http_injected_abort AFTER INSERT ON operations "
                       "WHEN NEW.operation_id = 'sqlite-failure' BEGIN "
                       "SELECT RAISE(ABORT, 'HTTP test injected SQLite failure'); END")
        failed = self.edit("sqlite-failure")
        failed["expectedRevisions"] = {key: 1 for key in failed["expectedRevisions"]}
        failed["changes"][0]["value"]["text"] = "must roll back"
        self.assert_error(self.post(failed), 503, "save_failed")
        self.assertEqual(self.get_json("/api/v1/state"), before)
        self.assertEqual(self.get_json("/api/v1/events?after=0"), events)
        with closing(sqlite3.connect(db_path)) as db, db:
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM history WHERE sequence > 1").fetchone()[0], 0)
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM operations WHERE operation_id = ?",
                (failed["operationId"],)).fetchone()[0], 0)
            db.execute("DROP TRIGGER http_injected_abort")
        status, result = self.post(failed)
        self.assertEqual(status, 200, result)
        self.assertIs(result["saved"], True)
        self.assertEqual(result["sequence"], before["sequence"] + 1)

    def test_json_container_in_namespace_returns_error_instead_of_disconnect(self):
        """Malformed JSON shapes must still receive the documented HTTP error."""
        before = self.get_json("/api/v1/state")
        malformed = self.edit("wrong-shape")
        malformed["changes"][0]["namespace"] = ["notes"]
        try:
            response = self.post(malformed)
        except (http.client.RemoteDisconnected, ConnectionResetError) as exc:
            self.fail(f"Malformed command disconnected instead of returning a JSON error: {exc}")
        self.assert_error(response, 400, "invalid_parameter")
        self.assertEqual(self.get_json("/api/v1/state"), before)
        self.assertEqual(self.get_json("/api/v1/events?after=0")["events"], [])


class HTTPConnectionBurstTests(unittest.TestCase):
    def test_course_open_accepts_a_burst_before_request_dispatch(self):
        # Opening a full course starts content, state and image requests together.
        # Pause dispatch so this exercises the actual socket backlog, independent
        # of PDF rendering speed or the scheduler running accept() between calls.
        server = CourseHTTPServer(("127.0.0.1", 0), None,
                                  Path(__file__).parents[1], "burst-fixture")
        self.addCleanup(server.server_close)
        barrier = threading.Barrier(12)

        def connect(_):
            barrier.wait(timeout=3)
            try:
                return socket.create_connection(server.server_address, timeout=.5)
            except OSError as exc:
                return exc

        with ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(connect, range(12)))
        try:
            errors = [str(item) for item in results if isinstance(item, OSError)]
            self.assertEqual(errors, [], "Course-open requests overflowed the HTTP backlog")
        finally:
            for item in results:
                if isinstance(item, socket.socket):
                    item.close()


if __name__ == "__main__":
    unittest.main()
