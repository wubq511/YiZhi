"""Focused package/CLI tests on generated temporary courses only."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_content_commands import fixture, REF
from reviewboard.content_commands import entity_hash
from reviewboard.content_imports import import_content_package, register_imports
from reviewboard.service import CourseService
from reviewboard.storage import StoreError
from start import CourseLock
from reviewboard.paths import DEFAULT_COURSE_ROOT

CLI = Path(__file__).resolve().parents[1] / "import_content.py"


class ImportTests(unittest.TestCase):
    def test_cli_default_and_explicit_course_selection(self):
        from import_content import main
        from contextlib import redirect_stdout
        from io import StringIO
        for arguments, expected in ((["package.json"], DEFAULT_COURSE_ROOT),
                                    (["package.json", "--course", "other-course"], Path("other-course"))):
            with self.subTest(arguments=arguments), patch("import_content.import_course", return_value={"saved": True}) as run, redirect_stdout(StringIO()):
                self.assertEqual(main(arguments), 0)
                run.assert_called_once_with(expected, Path("package.json"))

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.knowledge = fixture(self.root)
        data = self.raw()
        data["questions"] = [{"id": "Q-T", "kind": "homework", "sourceRefs": [REF], "stem": "old"}]
        self.knowledge.write_text(json.dumps(data), encoding="utf-8")
        self.service = CourseService(self.root)
        self.addCleanup(lambda: self.service.close())

    def raw(self):
        return json.loads(self.knowledge.read_text(encoding="utf-8"))

    def package(self, identifier="PKG-a", index=0):
        data = self.raw()
        entity = data["units"][index]
        reading = deepcopy(entity["reading"])
        reading["blocks"][0]["payload"]["text"] = identifier
        package = {"schemaVersion": "review-content-package-1", "packageId": identifier,
                   "ticketId": "02", "baseSourceHash": entity_hash(data),
                   "baseEntityHashes": {entity["id"]: entity_hash(entity), "Q-T": entity_hash(data["questions"][0])},
                   "unitIds": [entity["id"]], "units": [{"unitId": entity["id"], "reading": reading}],
                   "questionUpdates": [], "sourceProposals": [], "assets": [], "evidence": {}}
        path = self.root / "packages" / identifier / "package.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        return package, path

    def save(self, package, path):
        path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")

    def error(self, code, fn, *args, **kwargs):
        with self.assertRaises(StoreError) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, caught.exception.details)

    def test_entity_diff_question_idempotence_and_collision(self):
        package, path = self.package()
        package["questionUpdates"] = [{"questionId": "Q-T", "stem": "shared updated"}]
        self.save(package, path)
        with patch.object(self.service.content, "apply", wraps=self.service.content.apply) as apply:
            first = import_content_package(self.service, path.relative_to(self.root))
            self.assertEqual(apply.call_count, 1)
        self.assertEqual({c["key"] for c in first["knowledgeChanges"]}, {"KU-001", "Q-T"})
        self.assertEqual(first["operationId"], "OP-IMPORT-PKG-a")
        self.assertEqual(self.raw()["questions"][0]["stem"], "shared updated")
        current = self.service.content.get("KU-001")
        self.service.content.apply({"operationId": "later", "actor": "student", "kind": "edit", "generation": 1,
            "changes": [{"namespace": "knowledge", "key": "KU-001", "value": {**current["entity"], "summary": "later manual edit"}}],
            "expectedRevisions": {"knowledge:KU-001": current["revision"]}})
        self.assertEqual(import_content_package(self.service, path), first)
        self.assertEqual(self.raw()["units"][0]["summary"], "later manual edit")
        package["evidence"] = {"changed": True}
        self.save(package, path)
        self.error("invalid_parameter", import_content_package, self.service, path)

    def test_noop_receipt_and_undo_after_reopen_registration(self):
        package, path = self.package()
        package["units"][0]["reading"] = self.raw()["units"][0]["reading"]
        self.save(package, path)
        first = import_content_package(self.service, path)
        self.assertEqual(first["knowledgeChanges"], [])
        self.assertEqual(first["status"], "unchanged")
        self.service.close()
        self.service = CourseService(self.root)
        register_imports(self.service)
        self.assertTrue(self.service.content.undo(first["operationId"])["saved"])
        self.assertEqual(import_content_package(self.service, path), first)

    def test_conflicting_question_is_atomic_and_wrong_course_rejected(self):
        package, path = self.package()
        package["questionUpdates"] = [{"questionId": "Q-T", "stem": "proposal"}]
        self.save(package, path)
        self.error("invalid_parameter", import_content_package, self.service, path, course_id="wrong")
        data = self.raw()
        data["questions"][0]["stem"] = "later question"
        self.knowledge.write_text(json.dumps(data), encoding="utf-8")
        before = self.raw()
        self.error("revision_conflict", import_content_package, self.service, path)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.service.store.read("contentImports", "PKG-a")["revision"], 0)

    def test_disjoint_concurrent_packages_preserve_both(self):
        a, pa = self.package("PKG-a", 0)
        b, pb = self.package("PKG-b", 1)
        self.save(a, pa)
        self.save(b, pb)
        other = CourseService(self.root)
        self.addCleanup(other.close)
        barrier = threading.Barrier(2)
        def run(pair):
            barrier.wait(timeout=5)
            return import_content_package(*pair)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, [(self.service, pa), (other, pb)]))
        self.assertTrue(all(r["saved"] for r in results))
        self.assertEqual([u["reading"]["blocks"][0]["payload"]["text"] for u in self.raw()["units"][:2]], ["PKG-a", "PKG-b"])

    def test_staged_asset_new_source_in_one_commit(self):
        package, path = self.package()
        payload = b"immutable source"
        (path.parent / "new.txt").write_bytes(payload)
        digest = hashlib.sha256(payload).hexdigest()
        target = "期中/资源/PKG-a/new.txt"
        package["assets"] = [{"path": "new.txt", "target": target, "sha256": digest}]
        package["sourceProposals"] = [{"source": {"id": "SRC-NEW", "type": "course-note", "title": "new",
            "path": target, "totalPages": 0, "version": "v1"}, "version": {"id": "VER-NEW", "path": target,
            "sha256": digest, "displayName": "new", "totalPages": 0}}]
        package["units"][0]["reading"]["blocks"][0]["sourceRefs"] = [{"sourceId": "SRC-NEW", "versionId": "VER-NEW", "section": "section"}]
        self.save(package, path)
        result = import_content_package(self.service, path)
        self.assertEqual({c["key"] for c in result["knowledgeChanges"]}, {"KU-001", "SRC-NEW"})
        self.assertEqual((self.root / target).read_bytes(), payload)
        self.assertEqual(import_content_package(self.service, path), result)

    def test_staged_asset_directory_failure_is_retried_before_body_commit(self):
        package, path = self.package()
        payload = b"immutable figure"
        (path.parent / "figure.bin").write_bytes(payload)
        target = self.root / "期中/资源/PKG-a/figure.bin"
        package["assets"] = [{"path": "figure.bin", "target": str(target.relative_to(self.root)),
                              "sha256": hashlib.sha256(payload).hexdigest()}]
        self.save(package, path)
        before = self.raw()
        from reviewboard import content_imports
        actual = content_imports._fsync_directory
        failed = []
        def sync(directory):
            if target.exists() and directory == target.parent.resolve() and not failed:
                failed.append(True)
                raise OSError("staged directory not yet durable")
            return actual(directory)
        with patch.object(content_imports, "_fsync_directory", side_effect=sync):
            self.error("save_failed", import_content_package, self.service, path)
        self.assertEqual(self.raw(), before)
        self.assertEqual(target.read_bytes(), payload)
        flushed = []
        with patch.object(content_imports, "_fsync_directory", side_effect=lambda directory: flushed.append(directory)):
            result = import_content_package(self.service, path)
        self.assertTrue(result["saved"])
        self.assertIn(target.parent.resolve(), flushed)

    def test_actual_commit_failure_retries_same_package(self):
        package, path = self.package()
        self.save(package, path)
        self.service.content.get("KU-001")
        before = self.raw()
        with self.service.store._transaction(write=True) as db:
            db.execute("CREATE TRIGGER import_failure AFTER INSERT ON operations "
                       "WHEN NEW.operation_id='OP-IMPORT-PKG-a' BEGIN "
                       "INSERT INTO history VALUES (-1,0,'fault','fault','{}','{}'); END")
        self.error("save_failed", import_content_package, self.service, path)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.service.store.read("contentImports", "PKG-a")["revision"], 0)
        with self.service.store._transaction(write=True) as db:
            db.execute("DROP TRIGGER import_failure")
        self.assertTrue(import_content_package(self.service, path)["saved"])

    def test_cli_live_forward_offline_retry_and_no_fallback_after_http_error(self):
        package, path = self.package()
        self.save(package, path)
        service, requests, fail = self.service, [], []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def send_json(self, value, status=200):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def do_GET(self):
                self.send_json({"status": "running", "instanceId": "test-instance", "courseId": service.manifest["courseId"]})
            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(request)
                if fail:
                    return self.send_json({"error": {"code": "capability_unavailable", "message": "not registered", "details": {}}}, 501)
                self.send_json(import_content_package(service, request["packagePath"], course_id=request["courseId"]))
        lock = CourseLock(self.root / ".review-board/service.lock")
        self.assertTrue(lock.acquire())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        thread.start()
        (self.root / ".review-board/runtime.json").write_text(json.dumps({"url": f"http://127.0.0.1:{server.server_port}/",
            "instanceId": "test-instance", "courseId": service.manifest["courseId"]}), encoding="utf-8")
        def cli():
            return subprocess.run([sys.executable, str(CLI), "--course", str(self.root), str(path.relative_to(self.root))],
                                  cwd=self.root, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                                  capture_output=True, text=True, timeout=15)
        try:
            process = cli()
            self.assertEqual(process.returncode, 0, process.stderr)
            original = json.loads(process.stdout)
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]["packagePath"], str(path.resolve()))
            fail.append(True)
            before = service.store.snapshot()["sequence"]
            rejected = cli()
            self.assertEqual(rejected.returncode, 1)
            self.assertEqual(json.loads(rejected.stderr)["error"]["code"], "capability_unavailable")
            self.assertEqual(service.store.snapshot()["sequence"], before)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            lock.close()
        self.service.close()
        offline = cli()
        self.assertEqual(offline.returncode, 0, offline.stderr)
        self.assertEqual(json.loads(offline.stdout), original)
        fresh_package, fresh_path = self.package("PKG-offline", 1)
        self.save(fresh_package, fresh_path)
        fresh = subprocess.run([sys.executable, str(CLI), "--course", str(self.root), str(fresh_path)],
                               env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                               capture_output=True, text=True, timeout=15)
        self.assertEqual(fresh.returncode, 0, fresh.stderr)
        self.assertEqual(self.raw()["units"][1]["reading"]["blocks"][0]["payload"]["text"], "PKG-offline")
        probe = CourseLock(self.root / ".review-board/service.lock")
        try:
            self.assertTrue(probe.acquire())
        finally:
            probe.close()


if __name__ == "__main__":
    unittest.main()
