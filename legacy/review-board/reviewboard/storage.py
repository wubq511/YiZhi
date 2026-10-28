"""SQLite persistence for one course; no knowledge-domain rules live here.

Deleted documents remain visible as ``{value: None, revision: n}`` in reads,
lists and snapshots. Events distinguish deletion from a stored JSON null.
``events_since().sequence`` is the delivered cursor, so paged consumers can
use it directly for their next request without skipping committed events.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import sqlite3
import threading
import uuid
from .directory_authority import course_root,writer_admission


class StoreError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = {} if details is None else details


def _invalid(message, **details):
    raise StoreError("invalid_parameter", message, details)


def _string(value, field):
    if not isinstance(value, str) or not value.strip():
        _invalid(f"{field} must be a nonempty string", field=field)


def _integer(value, field, minimum=0):
    if type(value) is not int or value < minimum:
        _invalid(f"{field} must be an integer >= {minimum}", field=field)


def _json(value):
    """Reject Python coercions (tuple, nonstring keys, NaN) before encoding."""
    def check(item, active):
        kind = type(item)
        if item is None or kind in (str, bool, int):
            return
        if kind is float and math.isfinite(item):
            return
        if kind not in (dict, list):
            raise ValueError("Only JSON values are supported")
        if id(item) in active:
            raise ValueError("Circular JSON value")
        active.add(id(item))
        try:
            if kind is dict:
                if any(type(key) is not str for key in item):
                    raise ValueError("JSON object keys must be strings")
                for child in item.values():
                    check(child, active)
            else:
                for child in item:
                    check(child, active)
        finally:
            active.remove(id(item))

    try:
        check(value, set())
        return json.dumps(value, ensure_ascii=True, allow_nan=False,
                          sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError, OverflowError) as exc:
        raise StoreError("invalid_parameter", "Payload must be strict JSON",
                         {"reason": str(exc)}) from exc


class CourseStore:
    def __init__(self, db_path, course_id):
        self._course_root=course_root(db_path)
        with writer_admission(self._course_root):
            self._initialize(db_path,course_id)

    def _initialize(self, db_path, course_id):
        _string(course_id, "courseId")
        self.course_id = course_id
        self._lock = threading.RLock()
        self._connection = None
        try:
            self._connection = sqlite3.connect(
                db_path, timeout=30, isolation_level=None, check_same_thread=False)
            self._connection.execute("PRAGMA busy_timeout = 30000")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._connection.execute("PRAGMA foreign_keys = ON")
            with self._transaction(write=True) as db:
                for statement in (
                    """CREATE TABLE IF NOT EXISTS course_metadata (
                        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                        course_id TEXT NOT NULL, generation INTEGER NOT NULL,
                        sequence INTEGER NOT NULL)""",
                    """CREATE TABLE IF NOT EXISTS documents (
                        namespace TEXT NOT NULL, key TEXT NOT NULL,
                        value_json TEXT NOT NULL, revision INTEGER NOT NULL,
                        deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
                        PRIMARY KEY(namespace, key))""",
                    """CREATE TABLE IF NOT EXISTS events (
                        sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL)""",
                    """CREATE TABLE IF NOT EXISTS operations (
                        operation_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
                        result_json TEXT NOT NULL)""",
                    """CREATE TABLE IF NOT EXISTS history (
                        sequence INTEGER NOT NULL REFERENCES events(sequence)
                            DEFERRABLE INITIALLY DEFERRED,
                        ordinal INTEGER NOT NULL, namespace TEXT NOT NULL,
                        key TEXT NOT NULL, before_json TEXT NOT NULL,
                        after_json TEXT NOT NULL, PRIMARY KEY(sequence, ordinal))""",
                ):
                    db.execute(statement)
                db.execute("INSERT OR IGNORE INTO course_metadata VALUES (1, ?, 1, 0)",
                           (course_id,))
                actual = db.execute(
                    "SELECT course_id FROM course_metadata WHERE singleton = 1"
                ).fetchone()[0]
                if actual != course_id:
                    _invalid("Database belongs to another course",
                             courseId=course_id, actualCourseId=actual)
        except BaseException as exc:
            if self._connection is not None:
                self._connection.close()
                self._connection = None
            if isinstance(exc, sqlite3.Error):
                raise self._save_error(exc) from exc
            raise

    @staticmethod
    def _save_error(exc):
        return StoreError("save_failed", "SQLite operation failed",
                          {"reason": str(exc)})

    @contextmanager
    def _transaction(self, write=False):
        if write:
            with writer_admission(self._course_root):
                with self._unchecked_transaction(write=True) as db:
                    yield db
        else:
            with self._unchecked_transaction() as db:
                yield db

    @contextmanager
    def _unchecked_transaction(self, write=False):
        with self._lock:
            if self._connection is None:
                raise StoreError("save_failed", "Course store is closed")
            db = self._connection
            try:
                db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield db
                db.commit()
            except BaseException as exc:
                if db.in_transaction:
                    try:
                        db.rollback()
                    except sqlite3.Error:
                        # An unusable connection must never be reused for a save.
                        db.close()
                        self._connection = None
                if isinstance(exc, sqlite3.Error):
                    raise self._save_error(exc) from exc
                raise

    @staticmethod
    def _read(db, namespace, key):
        row = db.execute(
            "SELECT value_json, revision, deleted FROM documents "
            "WHERE namespace = ? AND key = ?", (namespace, key)
        ).fetchone()
        if row is None:
            return {"value": None, "revision": 0, "deleted": True}
        return {"value": json.loads(row[0]), "revision": row[1],
                "deleted": bool(row[2])}

    def read(self, namespace, key):
        _string(namespace, "namespace")
        _string(key, "key")
        with self._transaction() as db:
            state = self._read(db, namespace, key)
            return {"value": state["value"], "revision": state["revision"]}

    def list(self, namespace):
        _string(namespace, "namespace")
        with self._transaction() as db:
            return {key: {"value": json.loads(value), "revision": revision}
                    for key, value, revision in db.execute(
                        "SELECT key, value_json, revision FROM documents "
                        "WHERE namespace = ? ORDER BY key", (namespace,))}

    def snapshot(self):
        with self._transaction() as db:
            generation, sequence = db.execute(
                "SELECT generation, sequence FROM course_metadata WHERE singleton = 1"
            ).fetchone()
            documents = {}
            for namespace, key, value, revision in db.execute(
                "SELECT namespace, key, value_json, revision FROM documents "
                "ORDER BY namespace, key"
            ):
                documents.setdefault(namespace, {})[key] = {
                    "value": json.loads(value), "revision": revision}
            return {"courseId": self.course_id, "generation": generation,
                    "sequence": sequence, "documents": documents}

    @staticmethod
    def _command(command):
        payload = _json(command)
        command = json.loads(payload)  # Freeze caller-owned mutable objects.
        if not isinstance(command, dict):
            _invalid("command must be an object")
        for field in ("operationId", "actor", "kind", "generation", "changes",
                      "expectedRevisions"):
            if field not in command:
                _invalid("Missing command field", field=field)
        _string(command["operationId"], "operationId")
        _string(command["kind"], "kind")
        _integer(command["generation"], "generation", 1)
        changes = command["changes"]
        expected = command["expectedRevisions"]
        if not isinstance(changes, list) or not changes:
            _invalid("changes must be a nonempty array")
        if not isinstance(expected, dict):
            _invalid("expectedRevisions must be an object")
        for target, revision in expected.items():
            _string(target, "expectedRevisions key")
            _integer(revision, f"expectedRevisions[{target}]")
        seen = set()
        for change in changes:
            if not isinstance(change, dict):
                _invalid("Each change must be an object")
            namespace, key = change.get("namespace"), change.get("key")
            _string(namespace, "namespace")
            _string(key, "key")
            if (namespace, key) in seen:
                _invalid("Duplicate change target", namespace=namespace, key=key)
            seen.add((namespace, key))
            if "delete" in change and type(change["delete"]) is not bool:
                _invalid("delete must be a boolean", namespace=namespace, key=key)
            deleted = change.get("delete", False)
            if deleted == ("value" in change):
                _invalid("A change needs either value or delete:true",
                         namespace=namespace, key=key)
            if f"{namespace}:{key}" not in expected:
                _invalid("Missing expected revision", namespace=namespace, key=key)
        return command, payload

    def apply(self, command):
        command, payload = self._command(command)
        with self._transaction(write=True) as db:
            result = self._apply_in_transaction(db, command, payload)
        return result

    def _apply_in_transaction(self, db, command, payload, *, persisted_values=None,
                              before_values=None, bump_generation=False):
        """Shared commit machinery for the content journal coordinator.

        Caller owns a write transaction. Knowledge documents persist only hashes;
        events/history still carry the real committed entities. ``payload`` is
        the original request for deduplication, even after a compatible merge.
        This method never commits and must not be exposed as a request API.
        """
        previous = db.execute(
            "SELECT payload_json, result_json FROM operations WHERE operation_id = ?",
            (command["operationId"],)
        ).fetchone()
        if previous is not None:
            if previous[0] != payload:
                _invalid("operationId already used for a different payload",
                         operationId=command["operationId"])
            result = json.loads(previous[1])
        else:
            generation, sequence = db.execute(
                "SELECT generation, sequence FROM course_metadata WHERE singleton = 1"
            ).fetchone()
            if command["generation"] != generation:
                raise StoreError("revision_conflict", "Course generation changed",
                                 {"expectedGeneration": command["generation"],
                                  "generation": generation})
            before = []
            conflicts = []
            for change in command["changes"]:
                namespace, key = change["namespace"], change["key"]
                state = self._read(db, namespace, key)
                before.append(state)
                expected = command["expectedRevisions"][f"{namespace}:{key}"]
                if state["revision"] != expected:
                    conflicts.append({"namespace": namespace, "key": key,
                                      "expectedRevision": expected, **state})
            targets = {(change["namespace"], change["key"]) for change in command["changes"]}
            for token, expected in command["expectedRevisions"].items():
                if ":" not in token:
                    _invalid("Expected revision key must contain namespace:key", target=token)
                namespace, key = token.split(":", 1)
                if (namespace, key) not in targets:
                    state = self._read(db, namespace, key)
                    if state["revision"] != expected:
                        conflicts.append({"namespace": namespace, "key": key,
                                          "expectedRevision": expected, **state})
            if conflicts:
                raise StoreError("revision_conflict", "Document revision changed",
                                 {"conflicts": conflicts})
            if bump_generation:
                generation += 1
            sequence += 1
            changes = []
            revisions = {}
            for change, state in zip(command["changes"], before):
                namespace, key = change["namespace"], change["key"]
                deleted = change.get("delete", False)
                value = None if deleted else change["value"]
                revision = state["revision"] + 1
                persisted = (persisted_values or {}).get((namespace, key), value)
                db.execute(
                    "INSERT INTO documents VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(namespace, key) DO UPDATE SET "
                    "value_json = excluded.value_json, revision = excluded.revision, "
                    "deleted = excluded.deleted",
                    (namespace, key, _json(persisted), revision, int(deleted)))
                changes.append({"namespace": namespace, "key": key, "value": value,
                                "revision": revision, "deleted": deleted})
                revisions[f"{namespace}:{key}"] = revision
            result = {"operationId": command["operationId"],
                      "commitId": str(uuid.uuid4()), "courseId": self.course_id,
                      "generation": generation, "sequence": sequence, "saved": True,
                      "revisions": revisions, "changes": changes,
                      "savedAt": datetime.now(timezone.utc).isoformat()}
            event = {**result, "actor": command["actor"], "kind": command["kind"]}
            db.execute("INSERT INTO events VALUES (?, ?)", (sequence, _json(event)))
            for ordinal, (change, state) in enumerate(zip(changes, before)):
                state = (before_values or {}).get((change["namespace"], change["key"]), state)
                after = {field: change[field] for field in ("value", "revision", "deleted")}
                db.execute("INSERT INTO history VALUES (?, ?, ?, ?, ?, ?)",
                           (sequence, ordinal, change["namespace"], change["key"],
                            _json(state), _json(after)))
            db.execute("INSERT INTO operations VALUES (?, ?, ?)",
                       (command["operationId"], payload, _json(result)))
            db.execute("UPDATE course_metadata SET sequence = ?, generation = ? WHERE singleton = 1",
                       (sequence, generation))
        return result

    def events_since(self, after, limit=200):
        _integer(after, "after")
        _integer(limit, "limit", 1)
        with self._transaction() as db:
            latest = db.execute(
                "SELECT sequence FROM course_metadata WHERE singleton = 1"
            ).fetchone()[0]
            if after > latest:
                _invalid("Event cursor is ahead of this course", after=after, sequence=latest)
            rows = db.execute("SELECT event_json FROM events WHERE sequence > ? "
                              "ORDER BY sequence LIMIT ?", (after, limit)).fetchall()
            events = [json.loads(row[0]) for row in rows]
            cursor = events[-1]["sequence"] if events else after
            return {"events": events, "sequence": cursor, "hasMore": cursor < latest}

    def close(self):
        with self._lock:
            if self._connection is None:
                return
            db = self._connection
            try:
                busy, _, _ = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if busy:
                    raise StoreError("save_failed", "WAL checkpoint is busy")
            except sqlite3.Error as exc:
                raise self._save_error(exc) from exc
            finally:
                try:
                    db.close()
                except sqlite3.Error as exc:
                    raise self._save_error(exc) from exc
                finally:
                    self._connection = None
