"""Real domain validation on generated complete courses, never production JSON."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from reviewboard.content_commands import ContentCommands, entity_hash
from reviewboard.service import CourseService
from reviewboard.storage import StoreError

from reviewboard.paths import APP_ROOT, DEFAULT_COURSE_ROOT

PROJECT = DEFAULT_COURSE_ROOT
REF = {"sourceId": "SRC-T", "pdfPages": [1], "visualStatus": "verified",
       "versionId": "VER-T", "section": "fixture section"}


def fixture(root):
    (root / "source.txt").write_text("Disposable source", encoding="utf-8")
    units = []
    for n in range(1, 4):
        uid = f"KU-{n:03}"
        units.append({"id": uid, "themeId": "TH-001", "kind": "concept", "name": uid,
                      "outcome": "fixture outcome", "summary": "fixture summary", "questionTypes": ["test"],
                      "rating": {"stars": 3, "rationale": "fixture"}, "sourceRefs": [REF],
                      "reading": {"schemaVersion": "review-reading-1", "revision": 1, "status": "draft",
                                  "coverage": [], "blocks": [
                                      {"id": f"RB-{uid}-{b}", "kind": "paragraph", "role": "core",
                                       "payload": {"text": f"paragraph {b}"}, "sourceRefs": [REF]}
                                      for b in (1, 2)]}})
    data = {"schemaVersion": "midterm-map-1", "status": "active", "sources": [
        {"id": "SRC-T", "type": "course-note", "path": "source.txt", "title": "fixture", "totalPages": 1, "versions": [{"id": "VER-T",
         "path": "source.txt", "sha256": __import__("hashlib").sha256(b"Disposable source").hexdigest(),
         "displayName": "fixture source", "totalPages": 1}]}],
        "themes": [{"id": "TH-001", "name": "fixture", "coreOutcome": "fixture",
                    "rating": {"stars": 3, "rationale": "fixture"}}],
        "units": units, "questions": [], "referenceItems": [], "mappings": [],
        "questionCoverage": [], "pageCoverage": [], "relations": [], "requirementGroups": [],
        "retiredUnits": [], "issues": []}
    path = root / "期中/数据/知识地图.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (path.parent / "视图布局.json").write_text('{"nodes":[],"groups":[],"edges":[]}', encoding="utf-8")
    return path


class Crash(BaseException):
    pass


class ContentCommandTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = fixture(self.root)
        self.service = None
        self.start()
        self.addCleanup(self.stop)

    def start(self):
        self.service = CourseService(self.root)
        for namespace in ("annotations", "semanticChanges", "custom"):
            if namespace not in self.service._validators:
                self.service.register_namespace(namespace, lambda key, value: None)
        self.content = ContentCommands(self.service)

    def stop(self):
        if self.service is not None:
            self.service.close()
            self.service = None

    def raw(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def external(self, change):
        data = self.raw()
        change(data)
        self.path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def edit(self, operation="edit", block=0, text="edited", uid="KU-001", actor="agent"):
        read = self.content.get(uid)
        value = deepcopy(read["entity"])
        value["reading"]["blocks"][block]["payload"]["text"] = text
        return {"operationId": operation, "actor": actor, "kind": "edit", "generation": read["generation"],
                "expectedRevisions": {f"knowledge:{uid}": read["revision"]},
                "changes": [{"namespace": "knowledge", "key": uid, "value": value}]}

    def relation(self, rid="REL-T", source="KU-001", target="KU-003", **fields):
        return {"id": rid, "fromUnitId": source, "toUnitId": target, "type": "requires",
                "directed": True, "value": "fixture prerequisite rationale", "status": "approved",
                "view": "main", "sourceRefs": [REF], **fields}

    def rel_command(self, changes, operation="relations"):
        return {"operationId": operation, "actor": "student", "kind": "relation.edit", "generation": 1,
                "expectedRevisions": {f"knowledge:{c['key']}": self.service.store.read("knowledge", c["key"])["revision"]
                                      for c in changes},
                "changes": [{"namespace": "knowledge", **c} for c in changes]}

    def assert_code(self, code, function, *args):
        with self.assertRaises(StoreError) as caught:
            function(*args)
        self.assertEqual(caught.exception.code, code, caught.exception.details)
        return caught.exception

    def test_raw_get_hash_single_authority_and_restart(self):
        initial = self.content.get("KU-001")
        self.assertEqual(initial["hash"], entity_hash(initial["entity"]))
        self.assertEqual(initial["revision"], 1)
        result = self.content.apply(self.edit())
        self.assertEqual(result["operationId"], "edit")
        self.assertEqual(result["knowledgeChanges"], result["changes"])
        current = self.content.get("KU-001")
        self.assertEqual(current["revision"], 2)
        self.assertEqual(current["entity"]["reading"]["revision"], 2)
        self.assertEqual(self.service.store.read("knowledge", "KU-001")["value"], {"hash": current["hash"]})
        self.stop()
        self.start()
        self.assertEqual(self.content.get("KU-001"), current)

    def test_student_substantive_change_prompts_without_changing_mastery_and_retry_does_not_reopen_it(self):
        self.service.apply_command({"operationId":"mastered","actor":"student","kind":"review.edit","generation":1,
            "changes":[{"namespace":"review","key":"KU-001","value":{"status":"mastered"}}],
            "expectedRevisions":{"review:KU-001":0}})
        self.service.apply_command(self.edit("wording",text="clearer wording",actor="student"))
        self.assertFalse(self.service.store.list("reviewPrompts"))
        command=self.edit("important",text="corrected method",actor="student")
        command.update(materialChange=True,materialReason="修正了方法")
        self.service.apply_command(command)
        self.assertEqual(self.service.store.read("review","KU-001")["value"]["status"],"mastered")
        prompts=self.service.store.list("reviewPrompts")
        self.assertEqual(len(prompts),1)
        identifier=next(iter(prompts))
        self.service.agent.resolve_mastery(identifier,"weak")
        self.service.apply_command(command)
        self.assertEqual(self.service.store.read("review","KU-001")["value"]["status"],"weak")
        self.assertTrue(self.service.store.read("reviewPrompts",identifier)["value"]["resolved"])

    def test_external_entity_import_invalidates_cas_and_unrelated_import_survives(self):
        command = self.edit()
        stat = self.path.stat()
        self.external(lambda d: d["units"][0].update(summary="changed summary"))
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.assert_code("revision_conflict", self.content.apply, command)
        self.assertEqual(self.content.get("KU-001")["revision"], 2)
        self.assertEqual(self.raw()["units"][0]["summary"], "changed summary")
        self.assertEqual(self.raw()["units"][0]["reading"]["blocks"][0]["payload"]["text"], "paragraph 1")
        command = self.edit("valid")
        self.external(lambda d: d["units"][1].update(summary="other import"))
        self.content.apply(command)
        self.assertEqual(self.raw()["units"][1]["summary"], "other import")
        self.assertEqual(self.service.store.snapshot()["sequence"], 3)
        self.assertEqual(self.service.store.events_since(0)["events"][0]["actor"], "import")

    def test_concurrent_connections_have_one_winner(self):
        second_service = CourseService(self.root)
        self.addCleanup(second_service.close)
        second = ContentCommands(second_service)
        barrier = threading.Barrier(2)
        commands = [self.edit("one"), self.edit("two", text="second")]
        def write(index):
            barrier.wait(timeout=5)
            try:
                return (self.content, second)[index].apply(commands[index])
            except StoreError as exc:
                return exc.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, (0, 1)))
        self.assertEqual(sum(isinstance(r, dict) for r in results), 1)
        self.assertIn("revision_conflict", results)
        self.assertEqual(self.content.get("KU-001")["revision"], 2)

    def test_duplicate_retry_after_later_edit_and_payload_reuse(self):
        command = self.edit()
        result = self.content.apply(command)
        self.content.apply(self.edit("later", text="later"))
        self.assertEqual(self.content.apply(command), result)
        changed = deepcopy(command)
        changed["actor"] = "student"
        self.assert_code("invalid_parameter", self.content.apply, changed)
        self.assertEqual(self.service.store.snapshot()["sequence"], 2)

    def test_three_way_merge_different_blocks_same_fragment_and_forged_base(self):
        base = self.content.get("KU-001")["entity"]
        agent = self.edit("agent")
        agent["baseValues"] = {"knowledge:KU-001": base}
        self.content.apply(self.edit("student", block=1, text="student latest", actor="student"))
        self.content.apply(agent)
        value = self.content.get("KU-001")["entity"]
        self.assertEqual([b["payload"]["text"] for b in value["reading"]["blocks"]], ["edited", "student latest"])
        self.assertEqual(value["reading"]["revision"], 3)
        bad = self.edit("stale", text="another")
        bad["baseValues"] = {"knowledge:KU-001": deepcopy(value)}
        self.content.apply(self.edit("newer", text="newer"))
        error = self.assert_code("revision_conflict", self.content.apply, bad)
        self.assertEqual(error.details["conflicts"][0]["path"], "/reading/blocks/@RB-KU-001-1/payload/text")
        forged = deepcopy(agent)
        forged["operationId"] = "forged"
        forged["baseValues"]["knowledge:KU-001"]["summary"] = "forged"
        self.assert_code("revision_conflict", self.content.apply, forged)

    def test_undo_preserves_later_personal_and_compatible_block_then_redo(self):
        self.content.apply(self.edit("agent"))
        note = {"noteId": "NOTE-1", "objectId": "KU-001", "text": "later note", "anchor": {"objectId": "KU-001"}}
        personal = {"operationId": "personal", "actor": "student", "kind": "annotate", "generation": 1,
                    "changes": [{"namespace": "notes", "key": "NOTE-1", "value": note},
                                {"namespace": "annotations", "key": "DRAW-1", "value": {"drawingId": "DRAW-1", "objectId": "KU-001", "tool": "line",
                                  "anchor": {"objectId": "KU-001"}}}],
                    "expectedRevisions": {"notes:NOTE-1": 0, "annotations:DRAW-1": 0}}
        self.service.apply_command(personal)
        self.content.apply(self.edit("student", block=1, text="later student", actor="student"))
        undo = self.content.undo("agent")
        self.assertEqual(self.content.undo("agent"), undo)
        blocks = self.content.get("KU-001")["entity"]["reading"]["blocks"]
        self.assertEqual([b["payload"]["text"] for b in blocks], ["paragraph 1", "later student"])
        self.assertEqual(self.service.store.read("notes", "NOTE-1")["value"], note)
        self.assertEqual(self.service.store.read("annotations", "DRAW-1")["revision"], 1)
        self.content.undo(undo["operationId"])
        self.assertEqual(self.content.get("KU-001")["entity"]["reading"]["blocks"][0]["payload"]["text"], "edited")

    def test_undo_same_fragment_is_precise_and_atomic(self):
        self.content.apply(self.edit("agent"))
        self.content.apply(self.edit("student", text="student latest", actor="student"))
        before = self.raw()
        error = self.assert_code("revision_conflict", self.content.undo, "agent")
        self.assertEqual(error.details["conflicts"][0]["path"], "/reading/blocks/@RB-KU-001-1/payload/text")
        self.assertEqual(self.raw(), before)

    def test_personal_undo_existing_history_exact_cas_and_redo(self):
        cmd = {"operationId": "personal", "actor": "student", "kind": "edit", "generation": 1,
               "expectedRevisions": {"custom:x": 0},
               "changes": [{"namespace": "custom", "key": "x", "value": {"x": 1}}]}
        self.service.apply_command(cmd)
        undo = self.content.undo("personal")
        self.assertIsNone(self.service.store.read("custom", "x")["value"])
        self.content.undo(undo["operationId"])
        self.assertEqual(self.service.store.read("custom", "x")["value"], {"x": 1})
        self.assert_code("revision_conflict", self.content.undo, "personal",
                         {"operationId": "again", "actor": "student", "generation": 1})

    def test_mixed_semantic_metadata_atomic_and_failure_does_not_touch_knowledge(self):
        command = self.edit()
        command["changes"].append({"namespace": "semanticChanges", "key": "KU-001", "value": {"reason": "formula changed", "status": "needs-review"}})
        command["expectedRevisions"]["semanticChanges:KU-001"] = 0
        result = self.content.apply(command)
        self.assertEqual(len(result["changes"]), 2)
        self.assertEqual(len(result["knowledgeChanges"]), 1)
        self.assertEqual(self.service.store.read("semanticChanges", "KU-001")["revision"], 1)
        invalid = self.edit("invalid")
        invalid["changes"].append({"namespace": "notes", "key": "NOTE-invalid", "value": {"text": "bad"}})
        invalid["expectedRevisions"]["notes:NOTE-invalid"] = 0
        before = self.raw()
        self.assert_code("invalid_content", self.content.apply, invalid)
        self.assertEqual(self.raw(), before)

    def test_relations_sources_values_cycles_and_or_groups(self):
        for bad in (self.relation(sourceRefs=[]), self.relation(value=""), self.relation(toUnitId="KU-999"),
                    self.relation(extraValue=""), self.relation(directed=False)):
            self.assert_code("invalid_content", self.content.apply,
                             self.rel_command([{"key": "REL-T", "value": bad}]))
        group = {"id": "G1", "targetUnitId": "KU-003", "mode": "any", "unitIds": ["KU-001", "KU-002"],
                 "relationIds": ["REL-A", "REL-B"], "value": "alternative routes", "sourceRefs": [REF]}
        self.content.apply(self.rel_command([
            {"key": "REL-A", "value": self.relation("REL-A", requirementGroupId="G1")},
            {"key": "REL-B", "value": self.relation("REL-B", source="KU-002", requirementGroupId="G1")},
            {"key": "G1", "value": group}]))
        self.assertEqual(self.service.catalog.store().groups["G1"]["mode"], "any")
        self.assert_code("invalid_content", self.content.apply,
                         self.rel_command([{"key": "REL-A", "delete": True}], "delete-in-or"))
        self.assert_code("invalid_content", self.content.apply,
                         self.rel_command([{"key": "REL-C", "value": self.relation("REL-C", source="KU-003", target="KU-001")}], "cycle"))
        self.content.undo("relations")
        self.assertEqual(self.raw()["relations"], [])
        self.assertEqual(self.raw()["requirementGroups"], [])

    def test_endpoint_guard_revisions_and_hashes(self):
        command = self.rel_command([{"key": "REL-T", "value": self.relation()}])
        read = self.content.get("KU-001")
        command["expectedRevisions"]["knowledge:KU-001"] = read["revision"]
        self.content.apply(self.edit("endpoint"))
        self.assert_code("revision_conflict", self.content.apply, command)
        command["expectedRevisions"]["knowledge:KU-001"] = 2
        command["expectedHashes"] = {"knowledge:KU-001": read["hash"]}
        self.assert_code("revision_conflict", self.content.apply, command)

    def test_restore_generation_revisions_facts_late_task_and_dedup(self):
        command = self.edit("agent")
        first = self.content.apply(command)
        late = self.edit("late")
        self.service.store.apply({"operationId": "task", "actor": "agent", "kind": "task", "generation": 1,
                                  "expectedRevisions": {"tasks:T": 0},
                                  "changes": [{"namespace": "tasks", "key": "T", "value": {"status": "running"}}]})
        restore = {"operationId": "restore", "actor": "student", "generation": 1}
        result = self.content.restore(0, restore)
        self.assertEqual(result["generation"], 2)
        restored = self.content.get("KU-001")
        self.assertGreater(restored["revision"], 2)
        self.assertGreater(restored["entity"]["reading"]["revision"], 2)
        self.assertEqual(restored["entity"]["reading"]["blocks"][0]["payload"]["text"], "paragraph 1")
        self.assertEqual(self.service.store.read("tasks", "T")["value"], {"status": "running"})
        self.assert_code("revision_conflict", self.content.apply, late)
        self.assertEqual(self.content.apply(command), first)
        self.assertEqual(self.content.restore(0, restore), result)
        self.assertTrue(any(v["label"] == "before_restore" for v in self.content.versions()))
        self.assertEqual([e["sequence"] for e in self.service.store.events_since(0)["events"]], [1, 2, 3])

    def test_file_and_actual_sqlite_commit_failures_are_retryable(self):
        command = self.edit("retryable")
        before = self.raw()
        with patch.object(self.content, "_write", side_effect=OSError("disk full")):
            self.assert_code("save_failed", self.content.apply, command)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.service.store.snapshot()["sequence"], 0)
        with self.service.store._transaction(write=True) as db:
            db.execute("CREATE TRIGGER fail_commit AFTER INSERT ON operations "
                       "WHEN NEW.operation_id='retryable' BEGIN "
                       "INSERT INTO history VALUES (-1,0,'fault','fault','{}','{}'); END")
        self.assert_code("save_failed", self.content.apply, command)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.service.store.snapshot()["sequence"], 0)
        with self.service.store._transaction(write=True) as db:
            db.execute("DROP TRIGGER fail_commit")
        self.assertTrue(self.content.apply(command)["saved"])
        self.assertEqual(self.service.store.snapshot()["sequence"], 1)

    def test_process_death_at_all_journal_boundaries_recovers_complete_state(self):
        self.stop()
        script = '''import os,sys
from pathlib import Path
from reviewboard.service import CourseService
from reviewboard.content_commands import ContentCommands
s=CourseService(Path(sys.argv[1])); c=ContentCommands(s); r=c.get('KU-001')
v=r['entity']; v['summary']=sys.argv[2]
cmd={'operationId':sys.argv[2],'actor':'agent','kind':'edit','generation':r['generation'],
     'expectedRevisions':{'knowledge:KU-001':r['revision']},
     'changes':[{'namespace':'knowledge','key':'KU-001','value':v}]}
c._fault=lambda stage: os._exit(73) if stage==sys.argv[2] else None
c.apply(cmd)
'''
        for stage in ("after_journal", "before_replace", "after_replace", "before_sqlite_commit", "after_sqlite_commit"):
            with self.subTest(stage=stage):
                before = self.raw()
                env = {**os.environ, "PYTHONPATH": str(APP_ROOT), "PYTHONDONTWRITEBYTECODE": "1"}
                process = subprocess.run([sys.executable, "-c", script, str(self.root), stage], env=env,
                                         capture_output=True, text=True, timeout=20)
                self.assertEqual(process.returncode, 73, process.stderr)
                self.start()
                if stage == "after_sqlite_commit":
                    self.assertEqual(self.content.get("KU-001")["entity"]["summary"], stage)
                    self.assertEqual(self.service.store.snapshot()["sequence"], 1)
                else:
                    self.assertEqual(self.raw(), before)
                    self.assertEqual(self.service.store.snapshot()["sequence"], 0)
                with self.service.store._transaction() as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM content_journal").fetchone()[0], 0)
                self.stop()
        self.start()

    def test_recovery_keeps_external_other_block_and_blocks_same_fragment(self):
        def crash(stage):
            if stage == "after_replace":
                raise Crash()
        self.content._fault = crash
        with self.assertRaises(Crash):
            self.content.apply(self.edit())
        self.external(lambda d: d["units"][1].update(summary="external after crash"))
        self.content._fault = lambda stage: None
        self.content.get("KU-001")
        self.assertEqual(self.raw()["units"][1]["summary"], "external after crash")
        self.assertEqual(self.raw()["units"][0]["reading"]["blocks"][0]["payload"]["text"], "paragraph 1")
        self.content._fault = crash
        with self.assertRaises(Crash):
            self.content.apply(self.edit("another"))
        self.external(lambda d: d["units"][0]["reading"]["blocks"][0]["payload"].update(text="external collision"))
        error = self.assert_code("save_failed", self.content.get, "KU-001")
        self.assertIn("/units/@KU-001/reading/blocks/@RB-KU-001-1/payload/text", error.details["paths"])
        self.assertEqual(self.raw()["units"][0]["reading"]["blocks"][0]["payload"]["text"], "external collision")

    def test_external_race_before_replace_is_not_overwritten(self):
        command = self.edit()
        def change(stage):
            if stage == "before_replace":
                self.external(lambda d: d["units"][0].update(summary="racing importer"))
        self.content._fault = change
        self.assert_code("revision_conflict", self.content.apply, command)
        self.assertEqual(self.raw()["units"][0]["summary"], "racing importer")
        self.assertEqual(self.service.store.snapshot()["sequence"], 0)
        self.assertEqual(self.content.get("KU-001")["revision"], 2)

    def test_restore_recreates_formal_question_namespace_after_external_import(self):
        question = {"id": "Q-T", "kind": "homework", "sourceRefs": [REF], "stem": "fixture question"}
        self.external(lambda data: data["questions"].append(question))
        imported = self.content.get("Q-T")
        self.assertEqual(imported["entity"], question)
        self.content.restore(0)
        self.assertTrue(self.content.get("Q-T")["deleted"])
        self.content.restore(1)
        self.assertEqual(self.content.get("Q-T")["entity"], question)
        self.assertGreater(self.content.get("Q-T")["revision"], imported["revision"])

    def test_writer_lock_is_reentrant_for_importers_and_history_api_shape(self):
        command = self.edit()
        with self.content.writer_lock():
            result = self.content.apply(command)
            record = self.content.get("KU-001")
        self.assertTrue(result["saved"])
        self.assertEqual(record["revision"], 2)
        self.assertEqual(self.content.history(), {"versions": self.content.versions()})

    def test_invalid_null_entity_and_task_fact_writes_rejected(self):
        command = self.edit()
        command["changes"][0]["value"] = None
        self.assert_code("invalid_content", self.content.apply, command)
        command = {"operationId": "task", "actor": "student", "kind": "edit", "generation": 1,
                   "changes": [{"namespace": "tasks", "key": "T", "value": {"status": "stopped"}}],
                   "expectedRevisions": {"tasks:T": 0}}
        self.assert_code("invalid_parameter", self.content.apply, command)
        self.assertEqual(self.service.store.snapshot()["sequence"], 0)

    def test_formula_and_interactive_edits_are_authoritative_and_undoable(self):
        command = self.edit()
        blocks = command["changes"][0]["value"]["reading"]["blocks"]
        blocks[0].update(kind="formula", payload={"latex": "Y=A+B"})
        blocks[1].update(kind="interactive", payload={"component": "mux", "config": {
            "selectBits": ["S"], "dataSignals": ["A", "B"]}, "inputs": {"S": 0, "A": 1, "B": 0}})
        self.content.apply(command)
        actual = self.content.get("KU-001")["entity"]["reading"]["blocks"]
        self.assertEqual(actual, blocks)
        self.content.undo(command["operationId"])
        self.assertTrue(all(b["kind"] == "paragraph" for b in self.content.get("KU-001")["entity"]["reading"]["blocks"]))

    def test_deleted_identity_and_orphan_personal_keep_history_and_undo(self):
        self.content.apply(self.edit("first"))
        old = self.content.get("KU-001")
        note = {"noteId": "NOTE-orphan", "objectId": "KU-001", "text": "orphan note", "anchor": {"objectId": "KU-001"}}
        self.service.apply_command({"operationId": "note", "actor": "student", "kind": "note", "generation": 1,
            "changes": [{"namespace": "notes", "key": "NOTE-orphan", "value": note}],
            "expectedRevisions": {"notes:NOTE-orphan": 0}})
        command = self.rel_command([{"key": "KU-001", "delete": True}], "delete")
        self.content.apply(command)
        self.assertTrue(self.content.get("KU-001")["deleted"])
        self.assertEqual(self.service.store.read("notes", "NOTE-orphan")["value"], note)
        # Existing orphan edits exercise a validator that reads CourseStore.
        note["text"] = "retained orphan edit"
        self.content.apply({"operationId": "orphan-edit", "actor": "student", "kind": "note", "generation": 1,
            "changes": [{"namespace": "notes", "key": "NOTE-orphan", "value": note}],
            "expectedRevisions": {"notes:NOTE-orphan": 1}})
        recreate = self.rel_command([{"key": "KU-001", "value": old["entity"]}], "reallocate")
        self.assert_code("invalid_content", self.content.apply, recreate)
        self.content.undo("delete")
        current = self.content.get("KU-001")
        self.assertGreater(current["entity"]["reading"]["revision"], old["entity"]["reading"]["revision"])
        self.assertEqual(self.service.store.read("notes", "NOTE-orphan")["value"], note)

    def test_restore_personal_only_sequence_keeps_task_facts_and_saves_recovery_point(self):
        for operation, value, revision in (("a", "first", 0), ("b", "second", 1)):
            self.service.apply_command({"operationId": operation, "actor": "student", "kind": "note", "generation": 1,
                "changes": [{"namespace": "notes", "key": "NOTE-1", "value": {"noteId": "NOTE-1", "objectId": "KU-001",
                    "text": value, "anchor": {"objectId": "KU-001"}}}], "expectedRevisions": {"notes:NOTE-1": revision}})
        self.content.restore(1)
        note = self.service.store.read("notes", "NOTE-1")
        self.assertEqual(note["value"]["text"], "first")
        self.assertEqual(note["revision"], 3)
        self.content.restore(2)
        self.assertEqual(self.service.store.read("notes", "NOTE-1")["value"]["text"], "second")
        self.assertEqual(self.service.store.snapshot()["generation"], 3)
        self.assertIn("versions", self.content.history())

    def test_restore_commit_failure_restores_file_generation_and_same_id_retry(self):
        self.content.apply(self.edit())
        before = self.raw()
        with self.service.store._transaction(write=True) as db:
            db.execute("CREATE TRIGGER restore_failure AFTER INSERT ON operations "
                       "WHEN NEW.operation_id='restore-failed' BEGIN "
                       "INSERT INTO history VALUES (-1,0,'fault','fault','{}','{}'); END")
        command = {"operationId": "restore-failed", "actor": "student", "generation": 1}
        self.assert_code("save_failed", self.content.restore, 0, command)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.service.store.snapshot()["generation"], 1)
        self.assertEqual(self.service.store.snapshot()["sequence"], 1)
        with self.service.store._transaction(write=True) as db:
            db.execute("DROP TRIGGER restore_failure")
        result = self.content.restore(0, command)
        self.assertEqual(result["generation"], 2)
        self.assertEqual(self.content.restore(0, command), result)

    def test_failed_rename_and_directory_fsync_leave_retryable_complete_state(self):
        command = self.edit()
        before = self.raw()
        with patch("reviewboard.content_commands.os.replace", side_effect=OSError("rename failed")):
            self.assert_code("save_failed", self.content.apply, command)
        self.assertEqual(self.raw(), before)
        self.assertEqual(list(self.path.parent.glob(".content-*")), [])
        actual = self.content._fsync_directory
        calls = []
        def fsync():
            calls.append(True)
            if len(calls) == 1:
                raise OSError("directory fsync failed after rename")
            actual()
        with patch.object(self.content, "_fsync_directory", side_effect=fsync):
            self.assert_code("save_failed", self.content.apply, command)
        self.assertEqual(self.raw(), before)
        self.assertEqual(self.service.store.snapshot()["sequence"], 0)
        self.assertTrue(self.content.apply(command)["saved"])

    def test_callback_runs_after_unlock_and_delivery_failure_is_not_a_save_failure(self):
        seen = []
        def changed(result):
            def read():
                with self.service._command_lock:
                    return self.service.store.snapshot()["sequence"]
            with ThreadPoolExecutor(max_workers=1) as pool:
                seen.append(pool.submit(read).result(timeout=2))
            raise RuntimeError("notify failed")
        self.content.changed = changed
        result = self.content.apply(self.edit())
        self.assertEqual(seen, [1])
        self.assertTrue(result["saved"])
        self.assertIn("notificationError", result)

    def figure_package(self, identifier="PKG-figure"):
        entity = self.raw()["units"][0]
        reading = deepcopy(entity["reading"])
        target = f"期中/资源/{identifier}/figure.png"
        reading["blocks"][0] = {"id": "RB-import-figure", "kind": "figure", "role": "core",
                                 "payload": {"asset": target, "alt": "fixture image"}, "sourceRefs": [REF]}
        package = {"schemaVersion": "review-content-package-1", "packageId": identifier, "ticketId": "02",
                   "baseSourceHash": entity_hash(self.raw()), "baseEntityHashes": {entity["id"]: entity_hash(entity)},
                   "unitIds": [entity["id"]], "units": [{"unitId": entity["id"], "reading": reading}],
                   "questionUpdates": [], "sourceProposals": [], "assets": [], "evidence": {}}
        directory = self.root / "packages" / identifier
        directory.mkdir(parents=True)
        return package, directory / "package.json", target

    def test_figure_import_stages_verified_resource_and_survives_reopen(self):
        from hashlib import sha256
        from reviewboard.content_imports import import_content_package
        package, path, target = self.figure_package()
        payload = b"new figure bytes"
        (path.parent / "figure.png").write_bytes(payload)
        package["assets"] = [{"path": "figure.png", "target": target, "sha256": sha256(payload).hexdigest()}]
        path.write_text(json.dumps(package), encoding="utf-8")
        self.assertFalse((self.root / target).exists())
        result = import_content_package(self.service, path)
        self.assertTrue(result["saved"])
        self.assertEqual((self.root / target).read_bytes(), payload)
        committed = self.raw()["units"][0]["reading"]
        self.assertEqual(committed["blocks"], package["units"][0]["reading"]["blocks"])
        self.stop()
        self.start()
        self.assertEqual(import_content_package(self.service, path), result)
        self.assertEqual(self.content.get("KU-001")["entity"]["reading"], committed)

    def test_figure_import_rejects_missing_escaping_and_conflicting_resources_atomically(self):
        from hashlib import sha256
        from reviewboard.content_imports import import_content_package
        cases = {"undeclared": "source_unavailable", "missing": "source_unavailable",
                 "sha": "invalid_content", "escape": "invalid_parameter", "conflict": "revision_conflict"}
        for case, code in cases.items():
            with self.subTest(case=case):
                package, path, target = self.figure_package("PKG-figure-" + case)
                payload = b"proposed image"
                (path.parent / "figure.png").write_bytes(payload)
                if case != "undeclared":
                    package["assets"] = [{"path": "figure.png", "target": target, "sha256": sha256(payload).hexdigest()}]
                if case == "missing":
                    package["assets"][0]["path"] = "missing.png"
                elif case == "sha":
                    package["assets"][0]["sha256"] = "0" * 64
                elif case == "escape":
                    package["assets"][0]["target"] = "期中/资源/PKG-figure-escape/../../outside.png"
                elif case == "conflict":
                    (self.root / target).parent.mkdir(parents=True)
                    (self.root / target).write_bytes(b"keep existing")
                path.write_text(json.dumps(package), encoding="utf-8")
                before = self.path.read_bytes()
                snapshot = self.service.store.snapshot()
                self.assert_code(code, import_content_package, self.service, path)
                self.assertEqual(self.path.read_bytes(), before)
                self.assertEqual(self.service.store.snapshot(), snapshot)
                self.assertEqual(self.service.store.read("contentImports", package["packageId"])["revision"], 0)
                if case == "conflict":
                    self.assertEqual((self.root / target).read_bytes(), b"keep existing")
                else:
                    self.assertFalse((self.root / target).exists())


if __name__ == "__main__":
    unittest.main()
