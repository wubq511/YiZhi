from copy import deepcopy
import http.client
import json
from pathlib import Path
import shutil
import tempfile
import threading
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from reviewboard.http import CourseHTTPServer
from reviewboard.service import CourseService

from reviewboard.paths import DEFAULT_COURSE_ROOT

ROOT = DEFAULT_COURSE_ROOT


class FixtureMapError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class SourceFixtureCatalog:
    module = SimpleNamespace(MapError=FixtureMapError)

    def __init__(self):
        data = json.loads((ROOT / "期中/数据/知识地图.json").read_text(encoding="utf-8"))
        self.source = next(item for item in data["sources"] if item["id"] == "SRC-C05")
        self.store_data = SimpleNamespace(sources={"SRC-C05": self.source}, themes={},
                                          units={}, questions={}, hash="fixture-source-hash")

    def get(self, identifier):
        if identifier != "SRC-C05":
            raise FixtureMapError("not_found", "Unknown fixture source")
        return deepcopy(self.source)

    def store(self):
        return self.store_data

    def unit_ids(self):
        return set()


class ContentHTTPTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "course"
        self.root.mkdir()
        catalog = SourceFixtureCatalog()
        relative = catalog.source["path"]
        (self.root / relative).parent.mkdir(parents=True)
        shutil.copyfile(ROOT / relative, self.root / relative)
        self.service = CourseService(self.root, catalog=catalog)
        self.server = CourseHTTPServer(("127.0.0.1", 0), self.service,
                                       self.root, "content-http-test")
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.client = build_opener(ProxyHandler({}))
        self.version = catalog.source["versions"][0]["id"]

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.service.close()

    def request(self, path, *, payload=None, parse_json=True):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json", "Origin": self.origin} if body else {}
        request = Request(self.origin + path, data=body, headers=headers)
        try:
            response = self.client.open(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            data = response.read()
            return response.status, json.loads(data) if parse_json else data

    def test_source_resolution_rendering_selection_and_search(self):
        status, resolved = self.request(
            f"/api/v1/sources/resolve?sourceId=SRC-C05&versionId={self.version}&pdfPage=38")
        self.assertEqual(status, 200, resolved)
        self.assertEqual(resolved["location"]["pdfPage"], 38)
        self.assertIn("74LS138", resolved["text"])
        status, image = self.request(f"/source-pages/SRC-C05/{self.version}/38.png",
                                     parse_json=False)
        self.assertEqual(status, 200)

        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        status, selected = self.request("/api/v1/source-selections", payload={
            "sourceId": "SRC-C05", "versionId": self.version,
            "location": {"pdfPage": 38}, "text": "74LS138",
        })
        self.assertEqual(status, 200, selected)
        self.assertEqual(selected["contentKind"], "text")
        status, found = self.request("/api/v1/search?q=74LS138&scopes=sources")
        self.assertEqual(status, 200, found)
        self.assertTrue(found["items"])
        self.assertEqual({item["scope"] for item in found["items"]}, {"sources"})
        assets = self.root / "期中/资源/CP-test"
        assets.mkdir(parents=True)
        (assets / "note.txt").write_text("course-asset", encoding="utf-8")
        status, content = self.request("/course-assets/CP-test/note.txt", parse_json=False)
        self.assertEqual((status, content), (200, b"course-asset"))

    def test_agent_request_shapes_return_json_errors_and_keep_server_usable(self):
        for endpoint,payload in [
            ('agent/conversations',{'conversationId':[]}),
            ('agent/control',{'taskId':[],'action':'stop'}),
            ('agent/prompts',{'promptId':[],'status':'weak'}),
            ('agent/material-updates',{'updateId':[],'action':'later'}),
            ('agent/requests',{'requestId':'REQ-invalid','instruction':'hello','target':[]}),
        ]:
            with self.subTest(endpoint=endpoint):
                status,body=self.request('/api/v1/'+endpoint,payload=payload)
                self.assertEqual(status,400,body)
                self.assertEqual(body['error']['code'],'invalid_parameter')
        status,body=self.request('/api/v1/health')
        self.assertEqual(status,200,body)


if __name__ == "__main__":
    unittest.main()
