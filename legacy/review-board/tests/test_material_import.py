"""Actual course commands, immutable uploads and import/retry failure boundaries."""
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from reviewboard.content_commands import entity_hash
from reviewboard.material_import import MaterialImporter, MAX_BYTES
from reviewboard.service import CourseService
from reviewboard.storage import StoreError
from test_content_commands import fixture


def pdf_bytes(pages=2):
    """A real minimal PDF, including offsets/xref; pdfinfo reads its actual pages."""
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               f"<< /Type /Pages /Count {pages} /Kids [".encode()
               + b" ".join(f"{n + 3} 0 R".encode() for n in range(pages)) + b"] >>"]
    objects.extend(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>" for _ in range(pages))
    data, offsets = b"%PDF-1.4\n", [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
    start = len(data)
    data += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    return data + f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()


class MaterialImportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="material-import-test-")
        self.addCleanup(directory.cleanup)
        original_path = sys.path[:]
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), original_path))
        self.root = Path(directory.name)
        self.path = fixture(self.root)
        data = self.raw()
        data["sources"][0]["version"] = "原始课程笔记"
        # Keep the fixture's original heading-free bytes and version digest.
        data["sources"][0]["totalPages"] = 0
        data["sources"][0]["versions"][0]["totalPages"] = 0
        self.path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        self.service = CourseService(self.root)
        self.service.content.get("SRC-T")
        self.importer = MaterialImporter(self.service)
        self.addCleanup(lambda: self.service.close())
        self.serial = 0

    def raw(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def source(self, identifier):
        return self.service.content.get(identifier)["entity"]

    def request(self, content="开头未加标题的资料。\n\n可核对的说明。\n", **fields):
        self.serial += 1
        if isinstance(content, str):
            content = content.encode("utf-8")
        return {"operationId": f"OP-UPLOAD-{self.serial}", "sourceId": None,
                "title": "补充资料", "name": "notes.md", "contentBase64": base64.b64encode(content).decode("ascii"),
                **fields}

    def files(self):
        directory = self.root / ".review-board/materials"
        return sorted(directory.iterdir()) if directory.exists() else []

    def assert_code(self, code, request):
        with self.assertRaises(StoreError) as caught:
            self.importer.add(request)
        self.assertEqual(caught.exception.code, code, caught.exception.details)

    def sql(self, statement):
        with closing(sqlite3.connect(self.root / self.service.manifest["state"])) as db, db:
            db.execute(statement)

    def reopen(self):
        self.service.close()
        self.service = CourseService(self.root)
        self.importer = MaterialImporter(self.service)

    def test_new_utf8_text_and_pending_prompt_share_the_durable_receipt(self):
        for name in ("notes.MD", "notes.txt"):
            with self.subTest(name=name):
                request = self.request(name=name, affectedUnitIds=["KU-002", "KU-001", "KU-002"])
                receipt = self.importer.add(request)
                self.assertTrue(receipt["saved"])
                self.assertEqual(receipt["operationId"], request["operationId"])
                self.assertFalse(receipt["alreadyExists"])
                self.assertTrue(receipt["sourceId"].startswith("SRC-USER-"))
                source = self.source(receipt["sourceId"])
                self.assertEqual(set(source), {"id", "type", "title", "path", "totalPages", "version", "versions"})
                self.assertEqual(source["type"], "course-note")
                self.assertEqual(source["totalPages"], 0)
                version = source["versions"][0]
                self.assertEqual(version["id"], receipt["versionId"])
                self.assertEqual(version["totalPages"], 0)
                self.assertEqual(version["displayName"], name)
                content = base64.b64decode(request["contentBase64"])
                self.assertEqual((self.root / source["path"]).read_bytes(), content)
                self.assertEqual(source["path"], f".review-board/materials/{hashlib.sha256(content).hexdigest()}{Path(name).suffix.lower()}")
                resolved = self.service.sources.resolve(source["id"], version["id"], {"section": "全文"})
                self.assertEqual(resolved["text"], content.decode("utf-8"))
                self.assertEqual(resolved["location"], {"section": "全文"})
                prompt_id = "UPDATE-" + entity_hash([source["id"], version["id"]])
                changes = {c["namespace"]: c for c in receipt["changes"]}
                self.assertEqual(changes["materialUpdates"]["value"]["status"], "pending")
                self.assertEqual(changes["materialUpdates"]["value"]["affectedUnitIds"], ["KU-001", "KU-002"])
                self.assertEqual(self.service.store.read("materialUpdates", prompt_id)["revision"], 1)
                event = self.service.store.events_since(receipt["sequence"] - 1)["events"][0]
                self.assertEqual((event["actor"], event["kind"]), ("import", "source.add"))
                self.reopen()
                self.assertEqual(self.importer.add(request), receipt)

    def test_append_preserves_old_metadata_versions_resources_and_every_old_reference(self):
        before = self.raw()
        original = deepcopy(before["sources"][0])
        old_file = (self.root / original["path"]).read_bytes()
        receipt = self.importer.add(self.request(sourceId="SRC-T", title="不得覆盖旧标题"))
        updated = self.source("SRC-T")
        self.assertEqual({k: v for k, v in updated.items() if k != "versions"},
                         {k: v for k, v in original.items() if k != "versions"})
        self.assertEqual(updated["versions"][:-1], original["versions"])
        self.assertEqual(updated["versions"][-1]["id"], receipt["versionId"])
        self.assertEqual((self.root / original["path"]).read_bytes(), old_file)
        self.assertEqual(self.raw()["units"], before["units"])
        prompt = next(c["value"] for c in receipt["changes"] if c["namespace"] == "materialUpdates")
        self.assertEqual(prompt["affectedUnitIds"], ["KU-001", "KU-002", "KU-003"])
        self.assertEqual(self.service.store.events_since(receipt["sequence"] - 1)["events"][0]["kind"], "source.version")

    def test_same_source_hash_returns_existing_version_and_never_resets_later_decision(self):
        first_request = self.request(sourceId="SRC-T")
        first = self.importer.add(first_request)
        prompt_id = "UPDATE-" + entity_hash([first["sourceId"], first["versionId"]])
        # Exercise the actual runtime decision/observation API, without starting any CLI.
        self.service.agent.material_decision(prompt_id, "later")
        before = self.source("SRC-T")
        duplicate = self.importer.add({**first_request, "operationId": "OP-DUPLICATE", "name": "renamed.txt"})
        self.assertTrue(duplicate["alreadyExists"])
        self.assertEqual(duplicate["versionId"], first["versionId"])
        self.assertEqual(self.source("SRC-T"), before)
        self.assertEqual(len(self.files()), 1)
        self.assertEqual(self.service.agent.state()["sourceUpdates"], [])
        self.assertEqual(self.service.store.read("materialUpdates", prompt_id)["value"]["status"], "later")
        self.assertEqual(self.importer.add(first_request), first)
        self.assertEqual(self.service.store.read("materialUpdates", prompt_id)["value"]["status"], "later")

    def test_operation_id_reuse_rejects_changed_payload_without_writing(self):
        request = self.request()
        receipt = self.importer.add(request)
        before, files = self.raw(), self.files()
        for changes in ({"title": "different"}, {"name": "another.md"},
                        {"sourceId": receipt["sourceId"]}, {"affectedUnitIds": ["KU-001"]},
                        {"contentBase64": base64.b64encode(b"other text").decode()}):
            with self.subTest(changes=list(changes)):
                self.assert_code("invalid_parameter", {**request, **changes})
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.files(), files)

    def test_import_does_not_hide_other_unobserved_versions_of_the_same_source(self):
        self.service.agent.state()  # Observer knows only the initial source version.
        external = self.root / "external.txt"
        external.write_text("另一条内容线先导入的版本", encoding="utf-8")
        record = self.service.content.get("SRC-T")
        source = deepcopy(record["entity"])
        source["versions"].append({"id": "VER-EXTERNAL", "path": "external.txt", "displayName": "external.txt",
                                   "sha256": hashlib.sha256(external.read_bytes()).hexdigest(), "totalPages": 0})
        self.service.content.apply({"operationId": "OP-EXTERNAL", "actor": "import", "kind": "source.version",
            "generation": record["generation"], "expectedRevisions": {"knowledge:SRC-T": record["revision"]},
            "changes": [{"namespace": "knowledge", "key": "SRC-T", "value": source}]})
        uploaded = self.importer.add(self.request(sourceId="SRC-T"))
        prompts = self.service.agent.state()["sourceUpdates"]
        self.assertEqual({p["versionId"] for p in prompts}, {"VER-EXTERNAL", uploaded["versionId"]})

    def test_duplicate_after_history_restore_keeps_version_and_existing_later_decision(self):
        request = self.request(sourceId="SRC-T")
        first = self.importer.add(request)
        prompt_id = "UPDATE-" + entity_hash([first["sourceId"], first["versionId"]])
        self.service.agent.material_decision(prompt_id, "later")
        self.service.content.restore(0)
        self.assertEqual(len(self.source("SRC-T")["versions"]), 2)
        restored = self.importer.add({**request, "operationId": "OP-REIMPORT"})
        self.assertEqual(restored["versionId"], first["versionId"])
        self.assertTrue(restored["alreadyExists"])
        self.assertEqual(len(self.source("SRC-T")["versions"]), 2)
        self.assertEqual(self.service.store.read("materialUpdates", prompt_id)["value"]["status"], "later")
        self.assertEqual(len(self.files()), 1)

    def test_restore_initial_sequence_restores_body_and_keeps_new_and_old_sources_resolvable(self):
        initial = self.service.store.snapshot()
        unit_before = self.service.content.get("KU-001")
        old_version = self.source("SRC-T")["versions"][0]["id"]
        appended_text = "新版资料正文。\n不添加 Markdown 标题。\n"
        added_text = "后来新增的独立资料。\n保留原始结尾换行。\n"
        appended = self.importer.add(self.request(appended_text, sourceId="SRC-T", name="revised.txt"))
        added = self.importer.add(self.request(added_text, name="extra.md"))
        source_after_import = self.source("SRC-T")
        new_source_after_import = self.source(added["sourceId"])
        edited = deepcopy(unit_before["entity"])
        edited["summary"] = "恢复前的临时改写"
        edited["reading"]["blocks"][0]["payload"]["text"] = "恢复前已修改的学习正文"
        self.service.content.apply({"operationId": "OP-BODY-AFTER-IMPORT", "actor": "student", "kind": "knowledge.edit",
            "generation": initial["generation"], "expectedRevisions": {"knowledge:KU-001": unit_before["revision"]},
            "changes": [{"namespace": "knowledge", "key": "KU-001", "value": edited}]})
        self.assertEqual(self.service.content.get("KU-001")["entity"]["summary"], "恢复前的临时改写")
        restored = self.service.content.restore(initial["sequence"])
        self.assertGreater(restored["generation"], initial["generation"])
        # Check both immediately and after reopening the actual JSON/SQLite course.
        for reopened in (False, True):
            with self.subTest(reopened=reopened):
                if reopened:
                    self.reopen()
                current = self.service.content.get("KU-001")["entity"]
                self.assertEqual(current["summary"], unit_before["entity"]["summary"])
                self.assertEqual(current["reading"]["blocks"], unit_before["entity"]["reading"]["blocks"])
                self.assertGreater(current["reading"]["revision"], unit_before["entity"]["reading"]["revision"])
                self.assertEqual(self.source("SRC-T"), source_after_import)
                self.assertEqual(self.source(added["sourceId"]), new_source_after_import)
                old = self.service.sources.resolve("SRC-T", old_version, {"section": "全文"})
                new = self.service.sources.resolve("SRC-T", appended["versionId"], {"section": "全文"})
                extra = self.service.sources.resolve(added["sourceId"], added["versionId"], {"section": "全文"})
                self.assertEqual(old["text"], "Disposable source")
                self.assertEqual(new["text"], appended_text)
                self.assertEqual(extra["text"], added_text)
                for resolved in (old, new, extra):
                    self.assertEqual(resolved["location"], {"section": "全文"})

    def test_operation_id_collision_with_non_import_command_is_rejected(self):
        self.service.apply_command({"operationId": "OP-USED", "actor": "student", "kind": "reading",
            "generation": 1, "expectedRevisions": {"reading:default": 0},
            "changes": [{"namespace": "reading", "key": "default", "value": {"mode": "overview"}}]})
        self.assert_code("invalid_parameter", self.request(operationId="OP-USED"))
        self.assertEqual(self.files(), [])

    def test_sqlite_commit_failure_rolls_back_source_prompt_and_cleans_new_file(self):
        before = self.raw()
        request = self.request()
        self.sql("CREATE TRIGGER fail_import BEFORE INSERT ON operations "
                 "WHEN NEW.operation_id='OP-UPLOAD-1' BEGIN SELECT RAISE(ABORT,'disk full'); END")
        try:
            self.assert_code("save_failed", request)
        finally:
            self.sql("DROP TRIGGER fail_import")
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.service.store.list("materialUpdates"), {})
        self.assertEqual(self.service.store.list("materialImports"), {})
        self.assertTrue(self.importer.add(request)["saved"])
        self.assertEqual(len(self.files()), 1)

    def test_failed_import_does_not_delete_preexisting_shared_resource(self):
        first = self.importer.add(self.request())
        path = self.root / self.source(first["sourceId"])["path"]
        original = path.read_bytes()
        self.sql("CREATE TRIGGER fail_import BEFORE INSERT ON operations "
                 "WHEN NEW.operation_id='OP-UPLOAD-2' BEGIN SELECT RAISE(ABORT,'disk full'); END")
        try:
            self.assert_code("save_failed", self.request(title="another source, same bytes"))
        finally:
            self.sql("DROP TRIGGER fail_import")
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(self.raw()["sources"]), 2)

    def test_after_commit_exception_and_lost_response_retry_keep_original_receipt_and_file(self):
        request = self.request()
        def fail_after_commit(stage):
            if stage == "after_sqlite_commit":
                raise OSError("response lost after durable commit")
        self.service.content._fault = fail_after_commit
        try:
            receipt = self.importer.add(request)
        finally:
            self.service.content._fault = lambda stage: None
        self.assertTrue(receipt["saved"])
        path = self.root / self.source(receipt["sourceId"])["path"]
        self.assertTrue(path.is_file())
        self.reopen()
        # Recreate the HTTP retry after deliberately discarding the first response.
        self.assertEqual(self.importer.add(request), receipt)
        self.assertEqual(len(self.source(receipt["sourceId"])["versions"]), 1)
        self.assertEqual(self.files(), [path])
        events = self.service.store.events_since(0)["events"]
        self.assertEqual(sum(e["operationId"] == request["operationId"] for e in events), 1)

    def test_invalid_base64_extension_utf8_empty_and_unknown_association_leave_no_file(self):
        before = self.raw()
        for code, request in (
            ("invalid_parameter", self.request(contentBase64="%%%")),
            ("invalid_parameter", self.request(contentBase64="aGVsbG8=\n")),
            ("invalid_parameter", self.request(name="file.exe")),
            ("invalid_parameter", self.request(contentBase64="")),
            ("invalid_content", self.request(b"\xff\xfe", name="binary.txt")),
            ("not_found", self.request(affectedUnitIds=["KU-999"])),
            ("not_found", self.request(sourceId="SRC-MISSING")),
        ):
            with self.subTest(code=code, name=request["name"]):
                self.assert_code(code, request)
        self.assertEqual(self.files(), [])
        self.assertEqual(self.raw(), before)

    def test_decoded_size_limit_checks_padding_boundary_at_40_mib(self):
        # MAX_BYTES and MAX_BYTES+1 have the same Base64 length: only checking
        # the encoded length would incorrectly admit the oversized payload.
        oversized = self.request(b"x" * (MAX_BYTES + 1), name="large.txt")
        self.assert_code("invalid_parameter", oversized)
        self.assertEqual(self.files(), [])
        del oversized
        valid = self.importer.add(self.request(b"x" * MAX_BYTES, name="limit.txt"))
        self.assertEqual((self.root / self.source(valid["sourceId"])["path"]).stat().st_size, MAX_BYTES)

    def test_pdf_uses_real_page_count_supplementary_type_and_preserves_old_pdf_version(self):
        if not shutil.which("pdfinfo"):
            self.skipTest("pdfinfo is required for the real PDF integration")
        first = self.importer.add(self.request(pdf_bytes(2), name="slides.PDF", totalPages=999))
        original = self.source(first["sourceId"])
        self.assertEqual(original["type"], "supplementary")
        self.assertEqual(original["totalPages"], 2)
        self.assertEqual(original["versions"][0]["totalPages"], 2)
        next_version = self.importer.add(self.request(pdf_bytes(3), sourceId=first["sourceId"], name="revised.pdf", totalPages=0))
        source = self.source(first["sourceId"])
        self.assertEqual(source["path"], original["path"])
        self.assertEqual(source["totalPages"], 2)
        self.assertEqual(source["versions"][0], original["versions"][0])
        self.assertEqual(source["versions"][1]["totalPages"], 3)
        self.assertEqual(source["versions"][1]["id"], next_version["versionId"])
        self.assert_code("invalid_content", self.request(sourceId=first["sourceId"]))

    def test_pdf_text_incompatibility_is_rejected_before_publishing(self):
        self.assert_code("invalid_content", self.request(pdf_bytes(), sourceId="SRC-T", name="notes.pdf"))
        self.assertEqual(self.files(), [])
        self.assertEqual(len(self.source("SRC-T")["versions"]), 1)

    def test_invalid_pdf_and_invalid_pdfinfo_page_count_are_not_saved(self):
        if shutil.which("pdfinfo"):
            self.assert_code("invalid_content", self.request(b"not a PDF", name="fake.pdf"))
        for output in ("Pages: 0\n", "Pages: -1\n", "no page count\n"):
            with self.subTest(output=output), patch("reviewboard.material_import.subprocess.run", return_value=
                    subprocess.CompletedProcess(["pdfinfo"], 0, stdout=output, stderr="")):
                self.assert_code("invalid_content", self.request(pdf_bytes(), name="bad.pdf"))
        with patch("reviewboard.material_import.subprocess.run", side_effect=FileNotFoundError("pdfinfo")):
            self.assert_code("source_unavailable", self.request(pdf_bytes(), name="missing.pdf"))
        self.assertEqual(self.files(), [])

    def test_existing_digest_path_is_never_replaced_if_its_bytes_are_wrong(self):
        request = self.request()
        content = base64.b64decode(request["contentBase64"])
        directory = self.root / ".review-board/materials"
        directory.mkdir(parents=True)
        path = directory / (hashlib.sha256(content).hexdigest() + ".md")
        path.write_bytes(b"preexisting contents must not be replaced")
        self.assert_code("save_failed", request)
        self.assertEqual(path.read_bytes(), b"preexisting contents must not be replaced")
        self.assertEqual(self.files(), [path])

    def test_simultaneous_same_request_across_two_services_is_one_import(self):
        other = CourseService(self.root)
        self.addCleanup(other.close)
        other_importer = MaterialImporter(other)
        request = self.request()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.importer.add, request)
            second = pool.submit(other_importer.add, deepcopy(request))
            a, b = first.result(timeout=10), second.result(timeout=10)
        self.assertEqual(a, b)
        self.assertEqual(len(self.raw()["sources"]), 2)
        self.assertEqual(len(self.files()), 1)
        self.assertEqual(len(self.service.store.list("materialUpdates")), 1)


if __name__ == "__main__":
    unittest.main()
