"""Transactional and restart guarantees, using disposable course databases."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import threading
import unittest

from reviewboard.storage import CourseStore, StoreError


def command(operation_id, changes, revisions, generation=1):
    return {"operationId": operation_id, "actor": "student", "kind": "edit",
            "generation": generation, "changes": changes,
            "expectedRevisions": revisions}


def put(key, value, namespace="notes"):
    return {"namespace": namespace, "key": key, "value": value}


class CourseStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "course.sqlite3"
        self.store = CourseStore(self.path, "digital-logic")
        self.addCleanup(lambda: self.store.close())

    def database_state(self):
        """Observe all persisted tables, including history and dedup records."""
        with closing(sqlite3.connect(self.path)) as db, db:
            return {table: db.execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
                    for table in ("course_metadata", "documents", "events",
                                  "operations", "history")}

    def seed(self):
        return self.store.apply(command(
            "seed", [put("a", {"text": "初始笔记"}), put("b", "untouched")],
            {"notes:a": 0, "notes:b": 0}))

    def test_multi_object_conflict_is_atomic_and_reports_current_state(self):
        self.seed()
        before = self.database_state()
        with self.assertRaises(StoreError) as caught:
            self.store.apply(command(
                "conflict", [put("a", "would overwrite"), put("b", "stale")],
                {"notes:a": 1, "notes:b": 0}))
        self.assertEqual(caught.exception.code, "revision_conflict")
        self.assertEqual(caught.exception.details["conflicts"], [
            {"namespace": "notes", "key": "b", "expectedRevision": 0,
             "value": "untouched", "revision": 1, "deleted": False}])
        self.assertEqual(self.database_state(), before)

    def test_retry_returns_original_commit_even_after_later_edits(self):
        original = command("first", [put("a", {"x": 1, "y": 2})], {"notes:a": 0})
        saved = self.store.apply(original)
        self.store.apply(command("second", [put("a", "newer")], {"notes:a": 1}))
        before = self.database_state()
        reordered = deepcopy(original)
        reordered["changes"][0]["value"] = {"y": 2, "x": 1}
        self.assertEqual(self.store.apply(reordered), saved)
        reused = deepcopy(original)
        reused["changes"][0]["value"] = "different"
        with self.assertRaises(StoreError) as caught:
            self.store.apply(reused)
        self.assertEqual(caught.exception.code, "invalid_parameter")
        self.assertEqual(self.database_state(), before)
        self.assertEqual(self.store.read("notes", "a"), {"value": "newer", "revision": 2})

    def test_shutdown_reopen_and_database_copy_recover_all_save_records(self):
        first = command("first", [put("a", {"text": "可恢复"}),
                                  put("position", {"zoom": 0.5}, "reading")],
                        {"notes:a": 0, "reading:position": 0})
        saved = self.store.apply(first)
        self.store.apply(command("later", [put("a", "modified")], {"notes:a": 1}))
        snapshot = self.store.snapshot()
        events = self.store.events_since(0)
        tables = self.database_state()
        self.store.close()
        # A successful shutdown checkpoints WAL into the main database file.
        copy = Path(self.temporary.name) / "copied.sqlite3"
        shutil.copy2(self.path, copy)
        restored = CourseStore(copy, "digital-logic")
        try:
            self.assertEqual(restored.snapshot(), snapshot)
            self.assertEqual(restored.events_since(0), events)
            self.assertEqual(restored.apply(first), saved)
        finally:
            restored.close()
        self.store = CourseStore(self.path, "digital-logic")
        self.assertEqual(self.store.snapshot(), snapshot)
        self.assertEqual(self.store.events_since(0), events)
        self.assertEqual(self.store.apply(first), saved)
        self.assertEqual(self.database_state(), tables)
        with closing(sqlite3.connect(self.path)) as db, db:
            history = db.execute(
                "SELECT before_json, after_json FROM history WHERE sequence = 2"
            ).fetchone()
        self.assertEqual(json.loads(history[0]),
                         {"value": {"text": "可恢复"}, "revision": 1, "deleted": False})
        self.assertEqual(json.loads(history[1]),
                         {"value": "modified", "revision": 2, "deleted": False})

    def test_deleted_revision_survives_restart_and_prevents_aba(self):
        self.assertEqual(self.store.read("notes", "a"), {"value": None, "revision": 0})
        self.store.apply(command("create", [put("a", None)], {"notes:a": 0}))
        removed = self.store.apply(command(
            "delete", [{"namespace": "notes", "key": "a", "delete": True}],
            {"notes:a": 1}))
        self.assertTrue(removed["changes"][0]["deleted"])
        self.store.close()
        self.store = CourseStore(self.path, "digital-logic")
        tombstone = {"value": None, "revision": 2}
        self.assertEqual(self.store.read("notes", "a"), tombstone)
        self.assertEqual(self.store.list("notes"), {"a": tombstone})
        self.assertEqual(self.store.snapshot()["documents"]["notes"], {"a": tombstone})
        with self.assertRaises(StoreError) as caught:
            self.store.apply(command("stale-create", [put("a", "stale")], {"notes:a": 0}))
        self.assertEqual(caught.exception.code, "revision_conflict")
        recreated = self.store.apply(command("recreate", [put("a", "new")], {"notes:a": 2}))
        self.assertEqual(recreated["revisions"], {"notes:a": 3})
        events = self.store.events_since(0)["events"]
        self.assertFalse(events[0]["changes"][0]["deleted"])  # JSON null is not deletion.
        self.assertTrue(events[1]["changes"][0]["deleted"])

    def test_same_revision_has_one_winner_across_threads_and_connections(self):
        second = CourseStore(self.path, "digital-logic")
        self.addCleanup(second.close)
        for key, stores in (("shared", (self.store, self.store)),
                            ("separate", (self.store, second))):
            with self.subTest(connections=key):
                barrier = threading.Barrier(2)

                def write(index):
                    barrier.wait(timeout=5)
                    try:
                        return stores[index].apply(command(
                            f"{key}-{index}", [put(key, index)], {f"notes:{key}": 0}))
                    except StoreError as exc:
                        return exc.code

                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(write, (0, 1)))
                self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
                self.assertIn("revision_conflict", results)
                self.assertEqual(self.store.read("notes", key)["revision"], 1)
        self.assertEqual(len(self.store.events_since(0)["events"]), 2)

    def test_concurrent_retries_share_exactly_one_commit(self):
        second = CourseStore(self.path, "digital-logic")
        self.addCleanup(second.close)
        barrier = threading.Barrier(2)
        change = command("same-operation", [put("a", "once")], {"notes:a": 0})

        def retry(store):
            barrier.wait(timeout=5)
            return store.apply(change)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(retry, (self.store, second)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(self.store.snapshot()["sequence"], 1)
        self.assertEqual(len(self.store.events_since(0)["events"]), 1)

    def test_actual_sqlite_statement_and_commit_failures_roll_back_every_table(self):
        self.seed()
        for failure in ("statement", "commit"):
            with self.subTest(failure=failure):
                before = self.database_state()
                with closing(sqlite3.connect(self.path)) as db, db:
                    if failure == "statement":
                        body = "SELECT RAISE(ABORT, 'injected late write failure');"
                    else:
                        # FK checking is deferred until COMMIT, after apply has
                        # written documents, events, history, ledger and sequence.
                        body = ("INSERT INTO history VALUES (-1, 0, 'fault', 'fault', "
                                "'{}', '{}');")
                    db.execute("CREATE TRIGGER injected_failure AFTER INSERT ON operations "
                               "WHEN NEW.operation_id = 'retryable' BEGIN " + body + " END")
                change = command("retryable", [put("a", "changed"), put("c", "new")],
                                 {"notes:a": 1, "notes:c": 0})
                with self.assertRaises(StoreError) as caught:
                    self.store.apply(change)
                self.assertEqual(caught.exception.code, "save_failed")
                self.assertIn("injected" if failure == "statement" else "FOREIGN KEY",
                              caught.exception.details["reason"])
                self.assertEqual(self.database_state(), before)
                with closing(sqlite3.connect(self.path)) as db, db:
                    db.execute("DROP TRIGGER injected_failure")
        # A failed operation leaves no dedup entry or consumed event sequence.
        result = self.store.apply(change)
        self.assertTrue(result["saved"])
        self.assertEqual(result["sequence"], 2)
        self.assertEqual(result["revisions"], {"notes:a": 2, "notes:c": 1})

    def test_event_pagination_never_skips_a_commit(self):
        for revision in range(5):
            self.store.apply(command(str(revision), [put("a", revision)], {"notes:a": revision}))
        cursor, sequences = 0, []
        while True:
            page = self.store.events_since(cursor, limit=2)
            sequences.extend(event["sequence"] for event in page["events"])
            cursor = page["sequence"]
            if not page["hasMore"]:
                break
        self.assertEqual(sequences, [1, 2, 3, 4, 5])
        self.assertEqual(self.store.events_since(cursor),
                         {"events": [], "sequence": 5, "hasMore": False})
        with self.assertRaises(StoreError):
            self.store.events_since(6)

    def test_invalid_payloads_cannot_bypass_cas_or_create_partial_state(self):
        base = command("invalid", [put("a", "text")], {"notes:a": 0})
        missing_revision = deepcopy(base)
        missing_revision["expectedRevisions"] = {}
        duplicate = deepcopy(base)
        duplicate["changes"].append(put("a", "duplicate"))
        invalid_values = [float("nan"), float("inf"), (1, 2), {1: "coerced key"}]
        cyclic = []
        cyclic.append(cyclic)
        invalid_values.append(cyclic)
        malformed = [missing_revision, duplicate]
        for value in invalid_values:
            malformed.append(command("invalid", [put("a", value)], {"notes:a": 0}))
        for change in malformed:
            with self.subTest(payload=repr(change)):
                with self.assertRaises(StoreError) as caught:
                    self.store.apply(change)
                self.assertEqual(caught.exception.code, "invalid_parameter")
        self.assertEqual(self.store.snapshot()["sequence"], 0)
        self.assertEqual(self.store.list("notes"), {})
        stale = command("wrong-generation", [put("a", "late task")], {"notes:a": 0}, 2)
        with self.assertRaises(StoreError) as caught:
            self.store.apply(stale)
        self.assertEqual(caught.exception.code, "revision_conflict")

    def test_course_identity_and_sqlite_open_errors(self):
        self.seed()
        before = self.database_state()
        with self.assertRaises(StoreError) as caught:
            CourseStore(self.path, "another-course")
        self.assertEqual(caught.exception.code, "invalid_parameter")
        self.assertEqual(self.database_state(), before)
        with self.assertRaises(StoreError) as caught:
            CourseStore(Path(self.temporary.name) / "missing" / "db", "digital-logic")
        self.assertEqual(caught.exception.code, "save_failed")


if __name__ == "__main__":
    unittest.main()
