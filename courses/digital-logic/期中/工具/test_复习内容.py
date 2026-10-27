import json
import os
import copy
import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


SCRIPT = Path(__file__).with_name("知识地图.py")
CANONICAL = SCRIPT.parents[1] / "数据/知识地图.json"


class ReadingValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data_path = Path(self.tmp.name) / "map.json"
        canonical = json.loads(CANONICAL.read_text(encoding="utf-8"))
        self.c03_version = next(item for item in canonical["sources"] if item["id"] == "SRC-C03")["versions"][0]["id"]
        self.data_path.write_bytes(CANONICAL.read_bytes())
        self.env = os.environ.copy()
        self.env["MIDTERM_MAP_FILE"] = str(self.data_path)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env,
                              text=True, capture_output=True)

    def update_unit(self, unit_id, reading):
        data = json.loads(self.data_path.read_text(encoding="utf-8"))
        unit = next(item for item in data["units"] if item["id"] == unit_id)
        unit["reading"] = reading
        self.data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def test_reading_block_requires_stable_id(self):
        self.update_unit("KU-035", {
            "schemaVersion": "review-reading-1",
            "revision": 1,
            "status": "draft",
            "blocks": [{
                "kind": "paragraph",
                "role": "core",
                "payload": {"text": "卡诺图按相邻格合并。"},
                "sourceRefs": [],
            }],
            "coverage": [],
        })
        result = self.run_cli("check", "--source-only")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        error = json.loads(result.stdout)["error"]
        self.assertEqual(error["code"], "validation_failed")
        self.assertIn("KU-035", str(error["details"]))
        self.assertIn("ID", str(error["details"]))

    def test_complete_reading_contract_through_cli(self):
        ref = {"sourceId": "SRC-C03", "versionId": self.c03_version,
               "pdfPages": [7], "visualStatus": "verified"}
        valid = {
            "schemaVersion": "review-reading-1",
            "revision": 1,
            "status": "complete",
            "blocks": [
                {"id": "RB-KU-035-core", "kind": "paragraph", "role": "core",
                 "payload": {"text": "相邻格只有一个变量不同，可以合并。"}, "sourceRefs": [ref]},
                {"id": "RB-KU-035-ref", "kind": "knowledge-reference", "role": "core",
                 "payload": {"targetUnitId": "KU-034", "intent": "先回看相邻规则"},
                 "sourceRefs": []},
                {"id": "RB-KU-035-example", "kind": "example", "role": "material",
                 "payload": {"title": "跨边合并", "problem": "化简给定函数。",
                             "answerNature": "derived-solution"},
                 "children": [{"id": "RB-KU-035-example-steps", "kind": "steps",
                               "role": "material", "payload": {"items": ["填图。", "圈组并写出结果。"]},
                               "sourceRefs": [ref]}],
                 "sourceRefs": [ref]},
                {"id": "RB-KU-035-exercise", "kind": "exercise", "role": "material",
                 "payload": {"title": "自测", "problem": "化简另一个函数。", "hint": "先找相邻格。",
                             "answerNature": "self-test"},
                 "children": [{"id": "RB-KU-035-answer", "kind": "paragraph", "role": "material",
                               "payload": {"text": "完整答案与理由。"}, "sourceRefs": []}],
                 "sourceRefs": []},
            ],
            "coverage": [{
                "goal": "能按相邻规则完成圈组化简。",
                "coreBlockIds": ["RB-KU-035-core"],
                "materials": [
                    {"kind": "method", "status": "verified", "blockIds": ["RB-KU-035-example"]},
                    {"kind": "exercise", "status": "verified", "blockIds": ["RB-KU-035-exercise"]},
                ],
                "sourceRefs": [ref],
                "visualStatus": "verified",
                "readingStatus": "passed",
                "note": "已核对原页并沿正式读取路径读完。",
            }],
        }
        self.update_unit("KU-035", valid)
        result = self.run_cli("check", "--source-only")
        self.assertEqual(result.returncode, 0, result.stdout)
        loaded = json.loads(self.run_cli("get", "KU-035").stdout)
        self.assertEqual(loaded["reading"]["schemaVersion"], "review-reading-1")

        for case in ("unknown-kind", "duplicate-id", "dangling-reference",
                     "missing-solution", "missing-coverage", "wrong-version"):
            with self.subTest(case=case):
                reading = json.loads(json.dumps(valid, ensure_ascii=False))
                if case == "unknown-kind":
                    reading["blocks"][0]["kind"] = "rich-html"
                elif case == "duplicate-id":
                    reading["blocks"][3]["id"] = "RB-KU-035-core"
                elif case == "dangling-reference":
                    reading["blocks"][1]["payload"]["targetUnitId"] = "KU-999"
                elif case == "missing-solution":
                    reading["blocks"][2]["children"] = []
                elif case == "wrong-version":
                    reading["blocks"][0]["sourceRefs"][0]["versionId"] = "VER-other-source-version"
                else:
                    reading["coverage"] = []
                self.update_unit("KU-035", reading)
                result = self.run_cli("check", "--source-only")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                error = json.loads(result.stdout)["error"]
                self.assertEqual(error["code"], "validation_failed")
                self.assertIn("KU-035", str(error["details"]))


class ContentPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data_path = self.root / "map.json"
        self.data_path.write_bytes(CANONICAL.read_bytes())

    @staticmethod
    def entity_hash(value):
        from hashlib import sha256
        payload = json.dumps(value, sort_keys=True, ensure_ascii=False,
                             separators=(",", ":"), allow_nan=False).encode("utf-8")
        return sha256(payload).hexdigest()

    def copy_resources(self, data):
        # A copied course owns its resources; links escaping its root are invalid.
        paths = {v["path"] for source in data["sources"] for v in source["versions"]}
        def collect(blocks):
            for block in blocks:
                asset = block.get("payload", {}).get("asset", "")
                if asset.startswith("期中/资源/"):
                    paths.add(asset)
                collect(block.get("children", []))
        for unit in data["units"]:
            collect(unit.get("reading", {}).get("blocks", []))
        for relative in paths:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(CANONICAL.parents[2] / relative, destination)
            except OSError:
                shutil.copyfile(CANONICAL.parents[2] / relative, destination)

    def test_import_preserves_changes_outside_package_scope(self):
        original = json.loads(self.data_path.read_text(encoding="utf-8"))
        target = next(item for item in original["units"] if item["id"] == "KU-035")
        package = {
            "schemaVersion": "review-content-package-1",
            "packageId": "CP-TH-08-v1",
            "ticketId": "02",
            "baseSourceHash": self.entity_hash(original),
            "baseEntityHashes": {"KU-035": self.entity_hash(target)},
            "unitIds": ["KU-035"],
            "units": [{"unitId": "KU-035", "reading": {
                "schemaVersion": "review-reading-1", "revision": 1, "status": "draft",
                "blocks": [{"id": "RB-KU-035-package", "kind": "paragraph", "role": "core",
                            "payload": {"text": "内容包中的真实正文。"}, "sourceRefs": []}],
                "coverage": [],
            }}],
            "questionUpdates": [],
            "sourceProposals": [],
            "assets": [],
            "evidence": {"KU-035": {"owner": "TH-08-test"}},
        }
        package_path = self.root / "package.json"
        package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
        original["units"][0]["summary"] = "另一章节已经合入的新摘要，必须保留。"
        self.data_path.write_text(json.dumps(original, ensure_ascii=False, indent=2), encoding="utf-8")
        result = subprocess.run([
            sys.executable, str(SCRIPT.with_name("复习内容.py")), "import",
            "--map", str(self.data_path), "--package", str(package_path),
        ], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        imported = json.loads(self.data_path.read_text(encoding="utf-8"))
        self.assertEqual(imported["units"][0]["summary"], "另一章节已经合入的新摘要，必须保留。")
        unit = next(item for item in imported["units"] if item["id"] == "KU-035")
        self.assertEqual(unit["reading"]["blocks"][0]["payload"]["text"], "内容包中的真实正文。")

    def test_target_conflict_leaves_original_file_untouched(self):
        original = json.loads(self.data_path.read_text(encoding="utf-8"))
        target = next(item for item in original["units"] if item["id"] == "KU-035")
        package = {
            "schemaVersion": "review-content-package-1", "packageId": "CP-conflict",
            "ticketId": "02", "baseSourceHash": self.entity_hash(original),
            "baseEntityHashes": {"KU-035": self.entity_hash(target)}, "unitIds": ["KU-035"],
            "units": [{"unitId": "KU-035", "reading": {
                "schemaVersion": "review-reading-1", "revision": 1, "status": "draft",
                "blocks": [], "coverage": [],
            }}],
            "questionUpdates": [], "sourceProposals": [], "assets": [], "evidence": {},
        }
        package_path = self.root / "conflict.json"
        package_path.write_text(json.dumps(package), encoding="utf-8")
        target["summary"] = "集成期间另一作者更新了同一单元。"
        self.data_path.write_text(json.dumps(original, ensure_ascii=False, indent=2), encoding="utf-8")
        before = self.data_path.read_bytes()
        result = subprocess.run([
            sys.executable, str(SCRIPT.with_name("复习内容.py")), "import",
            "--map", str(self.data_path), "--package", str(package_path),
        ], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "revision_conflict")
        self.assertEqual(self.data_path.read_bytes(), before)

    def test_shared_question_update_is_preserved_and_repeat_is_idempotent(self):
        original = json.loads(self.data_path.read_text(encoding="utf-8"))
        target = next(item for item in original["units"] if item["id"] == "KU-035")
        question = next(item for item in original["questions"] if item["id"] == "Q-109")
        package = {
            "schemaVersion": "review-content-package-1", "packageId": "CP-question",
            "ticketId": "02", "baseSourceHash": self.entity_hash(original),
            "baseEntityHashes": {"KU-035": self.entity_hash(target),
                                 "Q-109": self.entity_hash(question)},
            "unitIds": ["KU-035"],
            "units": [{"unitId": "KU-035", "reading": {
                "schemaVersion": "review-reading-1", "revision": 1, "status": "draft",
                "blocks": [], "coverage": [],
            }}],
            "questionUpdates": [{
                "questionId": "Q-109", "stem": "完整题干", "solution": "完整官方解答",
                "answerNature": "official-solution",
            }],
            "sourceProposals": [], "assets": [], "evidence": {},
        }
        package_path = self.root / "question.json"
        package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
        command = [sys.executable, str(SCRIPT.with_name("复习内容.py")), "import",
                   "--map", str(self.data_path), "--package", str(package_path)]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        imported = json.loads(self.data_path.read_text(encoding="utf-8"))
        updated = next(item for item in imported["questions"] if item["id"] == "Q-109")
        self.assertEqual(updated["label"], question["label"])
        self.assertEqual(updated["stem"], "完整题干")
        self.assertEqual(updated["solution"], "完整官方解答")
        before = self.data_path.read_bytes()
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "unchanged")
        self.assertEqual(self.data_path.read_bytes(), before)

    def test_source_proposal_appends_version_and_is_idempotent(self):
        note = self.root / "notes/test-note.md"
        note.parent.mkdir()
        note.write_text("# 课程笔记\n\n## 卡诺图\n真实小节内容。\n", encoding="utf-8")
        original = json.loads(self.data_path.read_text(encoding="utf-8"))
        self.copy_resources(original)
        target = next(item for item in original["units"] if item["id"] == "KU-035")
        from hashlib import sha256
        digest = sha256(note.read_bytes()).hexdigest()
        package = {
            "schemaVersion": "review-content-package-1", "packageId": "CP-source-note",
            "ticketId": "02", "baseSourceHash": self.entity_hash(original),
            "baseEntityHashes": {"KU-035": self.entity_hash(target)}, "unitIds": ["KU-035"],
            "units": [{"unitId": "KU-035", "reading": {
                "schemaVersion": "review-reading-1", "revision": 1, "status": "draft",
                "blocks": [], "coverage": [],
            }}],
            "questionUpdates": [],
            "sourceProposals": [{
                "source": {"id": "SRC-NTEST", "type": "course-note", "title": "测试课程笔记",
                           "path": "notes/test-note.md", "totalPages": 0, "version": "测试版本"},
                "version": {"id": "VER-SRC-NTEST-test", "sha256": digest,
                            "path": "notes/test-note.md", "displayName": "测试版本", "totalPages": 0},
            }],
            "assets": [], "evidence": {},
        }
        package_path = self.root / "source.json"
        package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
        command = [sys.executable, str(SCRIPT.with_name("复习内容.py")), "import",
                   "--map", str(self.data_path), "--package", str(package_path),
                   "--course-root", str(self.root)]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        imported = json.loads(self.data_path.read_text(encoding="utf-8"))
        self.assertEqual(len(imported["sources"]), len(original["sources"]) + 1)
        added = next(item for item in imported["sources"] if item["id"] == "SRC-NTEST")
        self.assertEqual(added["versions"], [package["sourceProposals"][0]["version"]])
        for source in imported["sources"][:-1]:
            self.assertIn(source, original["sources"])
        before = self.data_path.read_bytes()
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "unchanged")
        self.assertEqual(self.data_path.read_bytes(), before)

    def test_assets_are_namespaced_atomic_and_idempotent(self):
        original = json.loads(self.data_path.read_text(encoding="utf-8"))
        self.copy_resources(original)
        target = next(item for item in original["units"] if item["id"] == "KU-035")
        asset = self.root / "assets/pixel.png"
        asset.parent.mkdir()
        payload = b"\x89PNG\r\n\x1a\nasset-test"
        asset.write_bytes(payload)
        from hashlib import sha256
        package = {
            "schemaVersion": "review-content-package-1", "packageId": "CP-assets",
            "ticketId": "02", "baseSourceHash": self.entity_hash(original),
            "baseEntityHashes": {"KU-035": self.entity_hash(target)}, "unitIds": ["KU-035"],
            "units": [{"unitId": "KU-035", "reading": {
                "schemaVersion": "review-reading-1", "revision": 1, "status": "draft",
                "blocks": [], "coverage": [],
            }}],
            "questionUpdates": [], "sourceProposals": [],
            "assets": [{"path": "assets/pixel.png", "target": "期中/资源/CP-assets/pixel.png",
                        "sha256": sha256(payload).hexdigest()}], "evidence": {},
        }
        package_path = self.root / "assets.json"
        package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
        command = [sys.executable, str(SCRIPT.with_name("复习内容.py")), "import",
                   "--map", str(self.data_path), "--package", str(package_path),
                   "--course-root", str(self.root)]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "期中/资源/CP-assets/pixel.png").read_bytes(), payload)
        before = self.data_path.read_bytes()
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "unchanged")
        self.assertEqual(self.data_path.read_bytes(), before)
        package["assets"][0]["path"] = "assets/missing.png"
        package["assets"][0]["target"] = "期中/资源/CP-assets/missing.png"
        package_path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "source_unavailable")
        self.assertEqual(self.data_path.read_bytes(), before)
        self.assertFalse((self.root / "期中/资源/CP-assets/missing.png").exists())

    def test_duplicate_unit_or_question_proposals_are_rejected(self):
        original = json.loads(self.data_path.read_text(encoding="utf-8"))
        target = next(item for item in original["units"] if item["id"] == "KU-035")
        question = next(item for item in original["questions"] if item["id"] == "Q-109")
        reading = {"schemaVersion": "review-reading-1", "revision": 1,
                   "status": "draft", "blocks": [], "coverage": []}
        for case in ("units", "questions"):
            with self.subTest(case=case):
                package = {
                    "schemaVersion": "review-content-package-1", "packageId": f"CP-duplicate-{case}",
                    "ticketId": "02", "baseSourceHash": self.entity_hash(original),
                    "baseEntityHashes": {"KU-035": self.entity_hash(target),
                                         "Q-109": self.entity_hash(question)},
                    "unitIds": ["KU-035"],
                    "units": [{"unitId": "KU-035", "reading": reading}] * (2 if case == "units" else 1),
                    "questionUpdates": [{"questionId": "Q-109", "stem": "版本一"},
                                        *([{"questionId": "Q-109", "stem": "版本二"}] if case == "questions" else [])],
                    "sourceProposals": [], "assets": [], "evidence": {},
                }
                if case == "units":
                    package["questionUpdates"] = []
                path = self.root / f"duplicate-{case}.json"
                path.write_text(json.dumps(package, ensure_ascii=False), encoding="utf-8")
                before = self.data_path.read_bytes()
                result = subprocess.run([
                    sys.executable, str(SCRIPT.with_name("复习内容.py")), "import",
                    "--map", str(self.data_path), "--package", str(path),
                ], text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(json.loads(result.stdout)["error"]["code"], "invalid_content")
                self.assertEqual(self.data_path.read_bytes(), before)


class FigureAssetImportTests(unittest.TestCase):
    """Exercise both pure package preflight and the real atomic file importer."""

    def setUp(self):
        import 复习内容
        self.content = 复习内容
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "course"
        self.root.mkdir()
        self.package_root = Path(self.tmp.name) / "package"
        self.package_root.mkdir()
        source = self.root / "source.pdf"
        source.write_bytes(b"source fixture")
        self.ref = {"sourceId": "SRC-T", "versionId": "VER-T", "pdfPages": [1], "visualStatus": "verified"}
        self.data = {
            "schemaVersion": "midterm-map-1", "status": "active",
            "sources": [{"id": "SRC-T", "type": "supplementary", "title": "fixture", "path": "source.pdf",
                         "totalPages": 1, "versions": [{"id": "VER-T", "path": "source.pdf",
                         "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "displayName": "fixture", "totalPages": 1}]}],
            "themes": [{"id": "TH-001", "name": "fixture", "coreOutcome": "fixture",
                        "rating": {"stars": 3, "rationale": "fixture"}}],
            "units": [{"id": "KU-001", "themeId": "TH-001", "kind": "concept", "name": "fixture",
                       "outcome": "fixture", "summary": "fixture", "questionTypes": ["test"],
                       "rating": {"stars": 3, "rationale": "fixture"}, "sourceRefs": [self.ref]}],
            **{key: [] for key in ("questions", "referenceItems", "mappings", "questionCoverage",
                                  "pageCoverage", "relations", "requirementGroups", "retiredUnits", "issues")},
        }
        self.map_path = self.root / "map.json"
        self.map_path.write_text(json.dumps(self.data), encoding="utf-8")
        self.target = "期中/资源/PKG-figures/new.png"
        self.figure = {"id": "RB-figure", "kind": "figure", "role": "core",
                       "payload": {"asset": self.target, "alt": "fixture figure"}, "sourceRefs": [self.ref]}
        self.package = {
            "schemaVersion": "review-content-package-1", "packageId": "PKG-figures", "ticketId": "02",
            "baseSourceHash": self.content.entity_hash(self.data),
            "baseEntityHashes": {"KU-001": self.content.entity_hash(self.data["units"][0])},
            "unitIds": ["KU-001"], "units": [{"unitId": "KU-001", "reading": {
                "schemaVersion": "review-reading-1", "revision": 1, "status": "draft", "coverage": [],
                "blocks": [{"id": "RB-example", "kind": "example", "role": "material",
                            "payload": {"title": "fixture", "problem": "fixture", "answerNature": "authored-example"},
                            "sourceRefs": [self.ref], "children": [self.figure]}]}}],
            "questionUpdates": [], "sourceProposals": [], "assets": [], "evidence": {},
        }

    def declare_asset(self, name="new.png", payload=b"image fixture"):
        (self.package_root / name).write_bytes(payload)
        target = "期中/资源/PKG-figures/" + name
        self.package["assets"].append({"path": name, "target": target,
                                       "sha256": hashlib.sha256(payload).hexdigest()})
        return target

    def preflight(self):
        return self.content.apply_package(self.data, self.package, self.root, package_root=self.package_root)

    def import_package(self):
        path = self.package_root / "package.json"
        path.write_text(json.dumps(self.package), encoding="utf-8")
        return self.content.import_package(self.map_path, path, self.root)

    def assert_rejected(self, code):
        before = self.map_path.read_bytes()
        original = copy.deepcopy(self.data)
        for action in (self.preflight, self.import_package):
            with self.assertRaises(self.content.ContentError) as caught:
                action()
            self.assertEqual(caught.exception.code, code, caught.exception.details)
        self.assertEqual(self.map_path.read_bytes(), before)
        self.assertEqual(self.data, original)

    def test_missing_nested_figure_without_manifest_fails_from_apply(self):
        with self.assertRaises(self.content.ContentError) as caught:
            self.content.apply_package(self.data, self.package, self.root)
        self.assertEqual(caught.exception.details["blockId"], "RB-figure")
        self.assert_rejected("source_unavailable")

    def test_existing_course_resource_imports_without_manifest(self):
        target = self.root / self.target
        target.parent.mkdir(parents=True)
        target.write_bytes(b"existing image")
        self.assertEqual(self.import_package()["status"], "imported")
        self.assertEqual(self.import_package()["status"], "unchanged")
        self.assertEqual(target.read_bytes(), b"existing image")

    def test_verified_incoming_asset_can_be_missing_until_atomic_import(self):
        self.declare_asset()
        candidate = self.preflight()
        self.assertFalse((self.root / self.target).exists(), "preflight must not stage files")
        self.assertNotIn("reading", self.data["units"][0])
        errors = []
        self.content.validate_reading(candidate, errors)
        self.assertEqual(errors, [], "in-memory schema validation must remain usable")
        self.assertEqual(self.import_package()["status"], "imported")
        self.assertEqual((self.root / self.target).read_bytes(), b"image fixture")
        self.assertEqual(json.loads(self.map_path.read_text())["units"][0]["reading"], candidate["units"][0]["reading"])
        self.assertEqual(self.import_package()["status"], "unchanged")

    def test_manifest_missing_file_bad_hash_and_conflicting_target_are_atomic(self):
        self.declare_asset("first.png")
        self.declare_asset()
        manifest = self.package["assets"][-1]
        for case, code in (("missing", "source_unavailable"), ("hash", "invalid_content"),
                           ("conflict", "revision_conflict")):
            with self.subTest(case=case):
                original = manifest.copy()
                target = self.root / self.target
                if case == "missing":
                    manifest["path"] = "absent.png"
                elif case == "hash":
                    manifest["sha256"] = "0" * 64
                else:
                    target.parent.mkdir(parents=True)
                    target.write_bytes(b"keep existing")
                self.assert_rejected(code)
                self.assertFalse((self.root / "期中/资源/PKG-figures/first.png").exists())
                if case == "conflict":
                    self.assertEqual(target.read_bytes(), b"keep existing")
                else:
                    self.assertFalse(target.exists())
                manifest.update(original)

    def test_invalid_paths_and_symlink_escape_cannot_be_authorized_by_manifest(self):
        outside = Path(self.tmp.name) / "outside.png"
        outside.write_bytes(b"outside")
        link = self.root / "期中/资源/escape.png"
        link.parent.mkdir(parents=True)
        link.symlink_to(outside)
        for asset in (str(outside), "../outside.png", "期中/资源/PKG-figures/../escape.png",
                      "期中\\资源\\escape.png", "期中/资源/escape.png"):
            with self.subTest(asset=asset):
                self.figure["payload"]["asset"] = asset
                self.assert_rejected("invalid_parameter")
        self.figure["payload"]["asset"] = self.target
        self.declare_asset()
        self.package["assets"][0]["target"] = "期中/资源/PKG-figures/../../escape.png"
        self.assert_rejected("invalid_parameter")
        self.package["assets"][0]["target"] = self.target
        self.package["assets"][0]["path"] = "../outside.png"
        self.assert_rejected("invalid_parameter")
        self.assertEqual(outside.read_bytes(), b"outside")

    def test_directory_is_not_an_existing_image(self):
        (self.root / self.target).mkdir(parents=True)
        self.assert_rejected("source_unavailable")

    def test_map_write_failure_removes_new_assets_and_preserves_old_map(self):
        self.declare_asset()
        before = self.map_path.read_bytes()
        with patch.object(self.content.os, "replace", side_effect=OSError("map rename failed")):
            with self.assertRaises(self.content.ContentError) as caught:
                self.import_package()
        self.assertEqual(caught.exception.code, "save_failed")
        self.assertEqual(self.map_path.read_bytes(), before)
        self.assertFalse((self.root / self.target).exists())
        self.assertEqual(list(self.root.glob("map.json.*")), [])

    def test_versioned_page_images_validate_without_cached_png(self):
        self.figure["payload"]["asset"] = "/source-pages/SRC-T/VER-T/1.png"
        self.preflight()
        for asset, code in (("/source-pages/SRC-T/VER-missing/1.png", "source_unavailable"),
                            ("/source-pages/SRC-T/VER-T/2.png", "invalid_content"),
                            ("/source-pages/SRC-T/VER-T/0.png", "invalid_content")):
            self.figure["payload"]["asset"] = asset
            self.assert_rejected(code)
        self.figure["payload"]["asset"] = "/source-pages/SRC-T/VER-T/1.png"
        (self.root / "source.pdf").unlink()
        self.assert_rejected("source_unavailable")

    def test_all_readings_checked_not_just_target_unit(self):
        other = copy.deepcopy(self.data["units"][0])
        other["id"] = "KU-002"
        other["reading"] = copy.deepcopy(self.package["units"][0]["reading"])
        self.data["units"].append(other)
        self.map_path.write_text(json.dumps(self.data), encoding="utf-8")
        self.package["units"][0]["reading"]["blocks"] = []
        self.assert_rejected("source_unavailable")

    def test_resource_check_preserves_schema_error_reporting(self):
        reading = self.package["units"][0]["reading"]
        for blocks in (None, [None], [{**self.figure, "payload": None}]):
            with self.subTest(blocks=blocks):
                reading["blocks"] = blocks
                before = self.map_path.read_bytes()
                with self.assertRaises(self.content.ContentError) as caught:
                    self.import_package()
                self.assertEqual(caught.exception.code, "invalid_content")
                self.assertEqual(self.map_path.read_bytes(), before)


class SourceVersionTests(unittest.TestCase):
    def test_pin_sources_binds_existing_references_to_real_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_path = Path(temporary) / "map.json"
            data_path.write_bytes(CANONICAL.read_bytes())
            command = [sys.executable, str(SCRIPT.with_name("复习内容.py")),
                       "pin-sources", "--map", str(data_path)]
            result = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            data = json.loads(data_path.read_text(encoding="utf-8"))
            versions = {source["id"]: source["versions"] for source in data["sources"]}
            self.assertTrue(all(len(items) == 1 for items in versions.values()))
            for source in data["sources"]:
                version = source["versions"][0]
                self.assertTrue(version["id"].startswith("VER-"))
                self.assertEqual(len(version["sha256"]), 64)
                self.assertEqual(version["path"], source["path"])
            for unit in data["units"]:
                for ref in unit["sourceRefs"]:
                    self.assertEqual(ref["versionId"], versions[ref["sourceId"]][0]["id"])
            before = data_path.read_bytes()
            result = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(data_path.read_bytes(), before)

    def test_legacy_refs_remain_readable_but_explicit_wrong_versions_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_path = Path(temporary) / "map.json"
            data_path.write_bytes(CANONICAL.read_bytes())
            data = json.loads(data_path.read_text(encoding="utf-8"))
            ref = data["units"][0]["sourceRefs"][0]
            ref["versionId"] = "VER-not-the-source-version"
            data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            env = os.environ.copy()
            env["MIDTERM_MAP_FILE"] = str(data_path)
            result = subprocess.run([sys.executable, str(SCRIPT), "check", "--source-only"],
                                    env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn("版本不匹配", result.stdout)
            del ref["versionId"]
            data_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            result = subprocess.run([sys.executable, str(SCRIPT), "check", "--source-only"],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
