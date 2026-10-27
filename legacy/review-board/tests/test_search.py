import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from reviewboard.knowledge import KnowledgeCatalog
from reviewboard.search import CourseSearch
from reviewboard.sources import SourceLibrary
from reviewboard.storage import StoreError

from course_fixture import copy_course


class CourseSearchTests(unittest.TestCase):
    def setUp(self):
        self.root = copy_course(self)
        self.catalog = KnowledgeCatalog(self.root, self.root / "期中/数据/知识地图.json")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = SourceLibrary(self.root, self.catalog, Path(self.tmp.name))
        self.snapshot = {
            "sequence": 7,
            "documents": {
                "notes": {"NOTE-1": {"value": {
                    "noteId": "NOTE-1", "objectId": "KU-063",
                    "text": "74LS138 的使能条件笔记", "anchor": {"objectId": "KU-063"},
                }, "revision": 2}},
                "conversations": {"CONV-1": {"value": {
                    "conversationId": "CONV-1", "draft": "尚未发送",
                    "messages": [{"messageId": "MSG-1", "role": "user",
                                  "text": "怎样判断 74LS138 是否使能？"}],
                }, "revision": 1}},
            },
        }
        self.search = CourseSearch(self.catalog, self.library, lambda: self.snapshot)

    def test_default_search_covers_all_four_scopes_and_can_filter(self):
        result = self.search.search("74LS138")
        scopes = {item["scope"] for item in result["items"]}
        self.assertEqual(scopes, {"knowledge", "notes", "conversations", "sources"})
        self.assertEqual(result["index"]["sequence"], 7)
        self.assertEqual(result["index"]["status"], "ready")
        for item in result["items"]:
            self.assertTrue(item["id"])
            self.assertTrue(item["location"])
            self.assertIn("74LS138", item["snippet"])
        only_knowledge = self.search.search("74LS138", scopes=["knowledge"])
        self.assertTrue(only_knowledge["items"])
        self.assertEqual({item["scope"] for item in only_knowledge["items"]}, {"knowledge"})
        empty = self.search.search("绝不可能存在的课程字符串-XYZ")
        self.assertEqual(empty["count"], 0)
        self.assertEqual(empty["items"], [])

    def test_queries_and_committed_changes_do_not_use_stale_hits(self):
        first = self.search.search("74LS138", scopes=["knowledge"])
        self.assertTrue(first["items"])
        second = self.search.search("卡诺图", scopes=["knowledge"])
        self.assertTrue(second["items"])
        self.assertIn("KU-035", {item["id"] for item in second["items"]})
        question = self.search.search("Q-109", scopes=["knowledge"])
        self.assertEqual(next(item for item in question["items"] if item["id"] == "Q-109")["location"]["unitId"], "KU-035")
        self.snapshot["sequence"] = 8
        self.snapshot["documents"]["notes"]["NOTE-1"]["value"]["text"] = "新的独特标记词"
        self.snapshot["documents"]["notes"]["NOTE-1"]["revision"] = 3
        updated = self.search.search("独特标记词", scopes=["notes"])
        self.assertEqual(updated["index"]["sequence"], 8)
        self.assertEqual([item["id"] for item in updated["items"]], ["NOTE-1"])
        self.assertEqual(updated["items"][0]["version"], "3")


class SearchRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paths = [self.root / name for name in ("old.md", "new.md")]
        self.payloads = ["# 小节\n共同关键词，旧版内容。", "# 小节\n共同关键词，新版内容。"]
        versions = []
        for index, (path, text) in enumerate(zip(self.paths, self.payloads)):
            path.write_text(text, encoding="utf-8")
            versions.append({"id": f"VER-{index}", "path": path.name,
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                             "totalPages": 0, "displayName": path.name})
        self.source = {"id": "SRC-NOTE", "title": "课程笔记", "type": "course-note",
                       "totalPages": 0, "versions": versions}
        self.store = SimpleNamespace(hash="map-v1", themes={}, questions={},
                                     units={"KU-001": {"id": "KU-001", "name": "共同关键词知识"}},
                                     sources={self.source["id"]: self.source})
        self.catalog = SimpleNamespace(store=lambda: self.store,
                                       get=lambda key: self.store.sources[key])
        self.snapshot = {"sequence": 7, "documents": {"conversations": {
            "CONV-1": {"revision": 3, "value": {
                "conversationId": "CONV-1", "title": "标题专用词", "draft": "草稿专用词",
                "messages": [
                    {"messageId": "USER-1", "role": "user", "text": "共同关键词：用户消息"},
                    {"messageId": "MSG-1", "role": "assistant", "text": "共同关键词：助手消息"},
                ]}},
        }}}
        self.library = SourceLibrary(self.root, self.catalog, self.root / "cache")
        self.search = CourseSearch(self.catalog, self.library, lambda: self.snapshot)

    def test_nested_messages_keep_real_identity_and_exclude_unsent_drafts(self):
        result = self.search.search("共同关键词", scopes=["conversations"])
        self.assertEqual({item["id"] for item in result["items"]}, {"USER-1", "MSG-1"})
        for item in result["items"]:
            self.assertEqual(item["location"], {"conversationId": "CONV-1", "messageId": item["id"]})
            self.assertEqual(item["entityType"], "message")
            self.assertEqual(item["version"], "3")
            self.assertNotIn("专用词", item["snippet"])
        for query in ("草稿专用词", "标题专用词", "USER-1", "CONV-1"):
            self.assertEqual(self.search.search(query, scopes=["conversations"])["items"], [])
        value = self.snapshot["documents"]["conversations"]["CONV-1"]
        value["value"]["messages"][0]["text"] = "已提交的新消息词"
        value["revision"] = 4
        self.snapshot["sequence"] += 1
        updated = self.search.search("新消息词", scopes=["conversations"])["items"]
        self.assertEqual([(item["id"], item["version"]) for item in updated], [("USER-1", "4")])

    def test_missing_version_does_not_block_knowledge_or_other_versions(self):
        self.paths[0].unlink()
        knowledge = self.search.search("共同关键词", scopes=["knowledge"])
        self.assertEqual([item["id"] for item in knowledge["items"]], ["KU-001"])
        self.assertEqual(knowledge["sourceWarnings"], [])
        all_scopes = self.search.search("共同关键词")
        self.assertEqual(len(all_scopes["sourceWarnings"]), 1)
        warning = all_scopes["sourceWarnings"][0]
        self.assertEqual((warning["sourceId"], warning["versionId"]), ("SRC-NOTE", "VER-0"))
        self.assertEqual(warning["title"], "课程笔记")
        self.assertEqual(warning["code"], "source_unavailable")
        self.assertEqual(warning["details"]["path"], "old.md")
        self.assertTrue(warning["message"])
        self.assertEqual({item["scope"] for item in all_scopes["items"]},
                         {"knowledge", "conversations", "sources"})
        self.assertEqual([item["version"] for item in all_scopes["items"] if item["scope"] == "sources"], ["VER-1"])

    def test_empty_results_preserve_specific_source_diagnostics_including_cached_queries(self):
        self.paths[0].unlink()
        for query in ("不存在的关键词", "另一不存在的关键词"):
            result = self.search.search(query)
            self.assertEqual(result["count"], 0)
            self.assertEqual(result["items"], [])
            warning, = result["sourceWarnings"]
            self.assertEqual((warning["sourceId"], warning["versionId"], warning["title"]),
                             ("SRC-NOTE", "VER-0", "课程笔记"))
            self.assertEqual(warning["code"], "source_unavailable")
            self.assertTrue(warning["message"])
            self.assertEqual(warning["details"]["path"], "old.md")

    def test_unreadable_pages_have_the_same_displayable_diagnostic_contract(self):
        def pages(source_id, version_id):
            return [{"location": {"pdfPage": 1}, "text": "", "textStatus": "unavailable"}]

        with patch.object(self.library, "text_pages", side_effect=pages):
            result = self.search.search("不存在的关键词", scopes=["sources"])
        self.assertEqual(result["items"], [])
        self.assertEqual(len(result["sourceWarnings"]), 2)
        for warning in result["sourceWarnings"]:
            self.assertEqual(warning["sourceId"], "SRC-NOTE")
            self.assertEqual(warning["title"], "课程笔记")
            self.assertEqual(warning["code"], "source_unavailable")
            self.assertIn("没有可用文本", warning["message"])
            self.assertEqual(warning["unavailablePages"], 1)
            self.assertEqual(warning["location"], {"pdfPages": [1]})

    def test_warnings_are_scoped_and_do_not_accumulate_across_cached_queries_or_rebuilds(self):
        def pages(source_id, version_id):
            return [{"location": {"pdfPage": page}, "text": "", "textStatus": "unavailable"}
                    for page in (3, 1, 3)]

        with patch.object(self.library, "text_pages", side_effect=pages):
            expected = self.search.search("不存在的关键词", scopes=["sources"])["sourceWarnings"]
            self.assertEqual(len(expected), 2)
            for warning in expected:
                self.assertEqual(warning["location"], {"pdfPages": [1, 3]})
                self.assertEqual(warning["unavailablePages"], 2)
            for _ in range(3):
                for scopes in (["knowledge"], ["notes"], ["conversations"], ["knowledge", "notes"]):
                    self.assertEqual(self.search.search("共同关键词", scopes=scopes)["sourceWarnings"], [])
                self.assertEqual(self.search.search("另一个关键词")["sourceWarnings"], expected)
                self.snapshot["sequence"] += 1
                self.assertEqual(self.search.search("不存在的关键词", scopes=["sources"])["sourceWarnings"], expected)
            # Responses must not expose mutable index state to in-process callers.
            response = self.search.search("不存在的关键词")
            response["sourceWarnings"][0]["location"]["pdfPages"].clear()
            self.assertEqual(self.search.search("不存在的关键词")["sourceWarnings"], expected)

    def test_unreadable_note_sections_are_locatable_and_deduplicated(self):
        def pages(source_id, version_id):
            sections = ["小节一"] if version_id == "VER-0" else ["小节二", "小节一", "小节二"]
            return [{"location": {"section": section}, "text": "", "textStatus": "unavailable"}
                    for section in sections]

        with patch.object(self.library, "text_pages", side_effect=pages):
            result = self.search.search("不存在的关键词", scopes=["sources"])
        self.assertEqual(len(result["sourceWarnings"]), 2)
        by_version = {warning["versionId"]: warning for warning in result["sourceWarnings"]}
        self.assertEqual(by_version["VER-0"]["location"], {"section": "小节一"})
        self.assertEqual(by_version["VER-1"]["location"], {"sections": ["小节一", "小节二"]})
        for warning in result["sourceWarnings"]:
            self.assertNotIn("unavailablePages", warning)

    def test_version_error_preserves_known_page_location(self):
        error = StoreError("source_unavailable", "无法读取指定原页", {"pdfPage": 2})
        with patch.object(self.library, "text_pages", side_effect=error):
            result = self.search.search("不存在的关键词", scopes=["sources"])
        self.assertEqual(len(result["sourceWarnings"]), 2)
        for warning in result["sourceWarnings"]:
            self.assertEqual(warning["location"], {"pdfPages": [2]})
            self.assertEqual(warning["message"], "无法读取指定原页")

    def test_missing_source_recovers_without_map_or_sequence_change(self):
        self.paths[0].unlink()
        missing = self.search.search("旧版内容", scopes=["sources"])
        self.assertEqual(missing["items"], [])
        self.paths[0].write_text(self.payloads[0], encoding="utf-8")
        recovered = self.search.search("旧版内容", scopes=["sources"])
        self.assertEqual([item["version"] for item in recovered["items"]], ["VER-0"])
        self.assertEqual(recovered["sourceWarnings"], [])
        self.assertEqual(recovered["index"], missing["index"])

    def test_primed_index_detects_same_size_hash_mismatch_and_repair(self):
        self.assertTrue(self.search.search("旧版内容", scopes=["sources"])["items"])
        path = self.paths[0]
        original, stamp = path.read_bytes(), path.stat()
        path.write_bytes(original.replace("旧版".encode(), "伪造".encode()))
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        broken = self.search.search("旧版内容", scopes=["sources"])
        self.assertEqual(broken["items"], [])
        self.assertEqual(broken["sourceWarnings"][0]["code"], "source_unavailable")
        self.assertIn("摘要不匹配", broken["sourceWarnings"][0]["message"])
        path.write_bytes(original)
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        repaired = self.search.search("旧版内容", scopes=["sources"])
        self.assertEqual([item["version"] for item in repaired["items"]], ["VER-0"])
        self.assertEqual(repaired["sourceWarnings"], [])

    def test_changed_version_digest_invalidates_extracted_pdf_text(self):
        self.source["type"] = "supplementary"
        self.source["totalPages"] = 1
        for version in self.source["versions"]:
            version["totalPages"] = 1

        def extract(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, stdout=Path(args[-2]).read_bytes() + b"\f")

        with patch("reviewboard.sources.subprocess.run", side_effect=extract) as run:
            self.assertTrue(self.search.search("旧版内容", scopes=["sources"])["items"])
            self.search.search("旧版内容", scopes=["sources"])
            self.assertEqual(run.call_count, 2, "unchanged versions should reuse their extracted text")
            path = self.paths[0]
            path.write_text("替换后的版本正文", encoding="utf-8")
            self.source["versions"][0]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            self.store.hash = "map-v2"
            result = self.search.search("替换后的版本正文", scopes=["sources"])
            self.assertEqual([item["version"] for item in result["items"]], ["VER-0"])
            self.assertEqual(result["index"]["sourceHash"], "map-v2")
            self.assertEqual(self.search.search("旧版内容", scopes=["sources"])["items"], [])
            self.assertEqual(run.call_count, 3)


if __name__ == "__main__":
    unittest.main()
