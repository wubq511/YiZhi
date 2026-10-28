"""Authoritative JSON commands coordinated with the course's SQLite history.

Only this module writes the knowledge file. SQLite documents contain hashes,
not a second editable body. A durable intent precedes the JSON rename; the
operation ledger decides rollback/rollforward after interruption. All callers
(including importers) must share ``writer_lock`` for strict single-writer use.
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import uuid

from .storage import CourseStore, StoreError, _json


_MISSING = object()
_WRITER_STATE = threading.local()
_COLLECTIONS = ("units", "relations", "requirementGroups", "themes", "sources",
                "questions", "referenceItems", "mappings")
_PERSONAL = frozenset({"notes", "annotations", "review", "reading", "layout", "semanticChanges"})


def entity_hash(value):
    # Same canonical encoding as the content-package importer.
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _copy(value):
    return value if value is _MISSING else deepcopy(value)


def _merge(base, current, desired, path="", conflicts=None):
    """Three-way field merge, with identity-aware block lists and exact paths.

    Lists without stable IDs are one fragment. Strings are intentionally atomic:
    guessing a character merge could change formula/interactive semantics.
    """
    conflicts = [] if conflicts is None else conflicts
    if base == desired:
        return _copy(current)
    if current == base or current == desired:
        return _copy(desired)
    if all(isinstance(x, dict) for x in (base, current, desired)):
        result = {}
        for key in sorted(base.keys() | current.keys() | desired.keys()):
            # Reading revision is allocated by the coordinator, not the author.
            if path.endswith("/reading") and key == "revision":
                result[key] = current.get(key, 0)
                continue
            value = _merge(base.get(key, _MISSING), current.get(key, _MISSING),
                           desired.get(key, _MISSING), f"{path}/{key}", conflicts)
            if value is not _MISSING:
                result[key] = value
        return result
    if all(isinstance(x, list) for x in (base, current, desired)) and all(
            isinstance(v, dict) and isinstance(v.get("id"), str)
            for values in (base, current, desired) for v in values):
        indexes = [{v["id"]: v for v in values} for values in (base, current, desired)]
        if any(len(index) != len(values) for index, values in zip(indexes, (base, current, desired))):
            conflicts.append(path)
            return _copy(current)
        b, c, d = indexes
        result = {key: _merge(b.get(key, _MISSING), c.get(key, _MISSING),
                              d.get(key, _MISSING), f"{path}/@{key}", conflicts)
                  for key in sorted(b.keys() | c.keys() | d.keys())}
        common = b.keys() & c.keys() & d.keys()
        orders = [[v["id"] for v in values if v["id"] in common]
                  for values in (base, current, desired)]
        if orders[1] != orders[0] and orders[2] != orders[0] and orders[1] != orders[2]:
            conflicts.append(path + "/$order")
        primary, secondary = (desired, current) if orders[2] != orders[0] else (current, desired)
        order = [v["id"] for v in primary if result[v["id"]] is not _MISSING]
        previous = None
        for item in secondary:
            key = item["id"]
            if result[key] is _MISSING:
                continue
            if key not in order:
                order.insert(order.index(previous) + 1 if previous in order else 0, key)
            previous = key
        return [result[key] for key in order]
    conflicts.append(path or "/")
    return _copy(current)


from .directory_authority import writer_admission

class ContentCommands:
    def __init__(self, service, *, changed=None, initialize=True):
        self.service = service
        self.store = service.store
        self.path = Path(getattr(service.catalog, "path", service.root / service.manifest["knowledge"]))
        self.lock_path = self.path.with_name(self.path.name + ".content.lock")
        self.changed = changed
        with self.writer_lock():
            with self.store._transaction(write=True) as db:
                db.execute("""CREATE TABLE IF NOT EXISTS content_journal (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    operation_id TEXT NOT NULL, before_json TEXT NOT NULL,
                    after_json TEXT NOT NULL)""")
                db.execute("""CREATE TABLE IF NOT EXISTS content_versions (
                    version_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
                    generation INTEGER NOT NULL, label TEXT NOT NULL,
                    knowledge_json TEXT NOT NULL, personal_json TEXT NOT NULL)""")
                db.execute("""CREATE TABLE IF NOT EXISTS content_head (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    version_id TEXT NOT NULL)""")
            self._recover()
            if initialize:
                self._sync()

    @contextmanager
    def writer_lock(self):
        with writer_admission(self.service.root):
            with self._writer_lock():
                yield

    @contextmanager
    def _writer_lock(self):
        """Integration lock: service -> advisory file -> store; never notify here.

        POSIX flock and Windows byte-range locks serialize independent service
        instances. Generic CourseStore writers serialize through SQLite as well.
        The lock file is persistent coordination state, not a temporary artifact.
        """
        with self.service._command_lock:
            # flock on a second file descriptor can block even in this process.
            # Reuse the current thread's path lock when an importer wraps apply.
            held = getattr(_WRITER_STATE, "held", None)
            if held is None:
                held = _WRITER_STATE.held = set()
            lock_key = str(self.lock_path.resolve())
            if lock_key in held:
                yield
                return
            with self.lock_path.open("a+b") as handle:
                if os.name == "nt":
                    import msvcrt
                    handle.seek(0, 2)
                    if not handle.tell():
                        handle.write(b"\0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                held.add(lock_key)
                try:
                    yield
                finally:
                    held.remove(lock_key)
                    if os.name == "nt":
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            _json(data)
            return data
        except (OSError, ValueError) as exc:
            raise StoreError("save_failed", "无法读取权威知识文件", {"reason": str(exc)}) from exc

    def _write(self, data):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent,
                                            prefix=".content-", delete=False) as handle:
                temporary = Path(handle.name)
                json.dump(data, handle, ensure_ascii=False, indent=2, allow_nan=False)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            self._fsync_directory()
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self.service.catalog._stamp = None

    def _fsync_directory(self):
        if os.name != "nt":
            descriptor = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def _fault(self, stage):
        """Fault-injection seam; production does nothing."""

    @staticmethod
    def _entities(data):
        result = {}
        for collection in _COLLECTIONS:
            for entity in data.get(collection, []):
                key = entity["id"]
                if key in result:
                    raise StoreError("invalid_content", "实体身份重复", {"id": key})
                result[key] = (collection, entity)
        return result

    @staticmethod
    def _personal(db):
        return {f"{namespace}:{key}": {"value": json.loads(value), "deleted": bool(deleted)}
                for namespace, key, value, deleted in db.execute(
                    "SELECT namespace,key,value_json,deleted FROM documents")
                if namespace in _PERSONAL}

    def _checkpoint(self, db, data, label, version_id=None):
        generation, sequence = db.execute(
            "SELECT generation,sequence FROM course_metadata WHERE singleton=1").fetchone()
        version_id = version_id or str(uuid.uuid4())
        db.execute("INSERT INTO content_versions VALUES (?,?,?,?,?,?)",
                   (version_id, sequence, generation, label, _json(data), _json(self._personal(db))))
        db.execute("INSERT INTO content_head VALUES (1,?) ON CONFLICT(singleton) "
                   "DO UPDATE SET version_id=excluded.version_id", (version_id,))
        return version_id

    def _recover(self):
        with self.store._transaction(write=True) as db:
            journal = db.execute("SELECT operation_id,before_json,after_json FROM content_journal").fetchone()
            if journal is None:
                return
            operation_id, before, after = journal
            before, after = json.loads(before), json.loads(after)
            committed = db.execute("SELECT 1 FROM operations WHERE operation_id=?", (operation_id,)).fetchone()
            current = self._load()
            expected, target = (before, after) if committed else (after, before)
            conflicts = []
            recovered = _merge(expected, current, target, conflicts=conflicts)
            if conflicts:
                raise StoreError("save_failed", "恢复期间检测到外部修改，保留 journal 待核对",
                                 {"operationId": operation_id, "paths": conflicts})
            if recovered != current:
                self._write(recovered)
            else:
                # Also retry a directory fsync that failed after rename.
                self._fsync_directory()
            db.execute("DELETE FROM content_journal")

    def _validate(self, candidate):
        try:
            self.service.catalog.module.Store(candidate, root=self.service.root).validate()
            entities = self._entities(candidate)
            units = {item["id"] for item in candidate["units"]}
            groups = {item["id"]: item for item in candidate["requirementGroups"]}
            relations = {item["id"]: item for item in candidate["relations"]}
            for key, (collection, entity) in entities.items():
                prefixes = {"units": r"KU-\d+", "relations": r"REL-[A-Za-z0-9_-]+"}
                if collection in prefixes and not re.fullmatch(prefixes[collection], key):
                    raise ValueError(f"实体命名空间非法：{key}")
            for relation in relations.values():
                rid = relation["id"]
                if not isinstance(relation.get("value"), str) or not relation["value"].strip():
                    raise ValueError(f"关系缺少额外价值 value：{rid}")
                if not relation.get("sourceRefs"):
                    raise ValueError(f"关系缺少来源：{rid}")
                if "extraValue" in relation and (not isinstance(relation["extraValue"], str)
                                                   or not relation["extraValue"].strip()):
                    raise ValueError(f"关系 extraValue 不能为空：{rid}")
                gid = relation.get("requirementGroupId")
                if gid is not None:
                    group = groups.get(gid)
                    if (relation["type"] != "requires" or group is None
                            or rid not in group["relationIds"]
                            or group["targetUnitId"] != relation["toUnitId"]
                            or relation["fromUnitId"] not in group["unitIds"]):
                        raise ValueError(f"关系路线组不一致：{rid}")
                if relation["type"] == "requires" and relation.get("directed") is not True:
                    raise ValueError(f"前置关系必须有方向：{rid}")
            for group in groups.values():
                edges = [relations[rid] for rid in group["relationIds"]]
                if (not edges or len(set(group["relationIds"])) != len(edges)
                        or len(set(group["unitIds"])) != len(group["unitIds"])
                        or {edge["fromUnitId"] for edge in edges} != set(group["unitIds"])
                        or any(edge["type"] != "requires" or edge.get("requirementGroupId") != group["id"]
                               or edge["toUnitId"] != group["targetUnitId"] for edge in edges)
                        or not set(group["unitIds"]) <= units):
                    raise ValueError(f"路线组 AND/OR 记录不一致：{group['id']}")
        except StoreError:
            raise
        except Exception as exc:
            raise StoreError("invalid_content", "知识内容校验失败",
                             {"reason": str(exc), **getattr(exc, "details", {})}) from exc

    def _sync(self):
        """Detect external imports by content, even if mtime and size match."""
        data = self._load()
        with self.store._transaction(write=True) as db:
            head = db.execute("SELECT v.knowledge_json FROM content_head h JOIN content_versions v "
                              "ON v.version_id=h.version_id WHERE h.singleton=1").fetchone()
            if head is None:
                self._validate(data)
                for key, (_, value) in self._entities(data).items():
                    db.execute("INSERT INTO documents VALUES ('knowledge',?,?,1,0)",
                               (key, _json({"hash": entity_hash(value)})))
                self._checkpoint(db, data, "initial")
                return data
            before = json.loads(head[0])
            if before == data:
                return data
            self._validate(data)
            old, new = self._entities(before), self._entities(data)
            changes, expected, previous = [], {}, {}
            for key in sorted(old.keys() | new.keys()):
                bv = old.get(key, (None, None))[1]
                av = new.get(key, (None, None))[1]
                if bv == av:
                    continue
                state = self.store._read(db, "knowledge", key)
                changes.append({"namespace": "knowledge", "key": key,
                                **({"delete": True} if av is None else {"value": av})})
                expected[f"knowledge:{key}"] = state["revision"]
                previous[("knowledge", key)] = {**state, "value": bv}
            if not changes:
                changes = [{"namespace": "contentMeta", "key": "source", "value": entity_hash(data)}]
                expected = {"contentMeta:source": self.store._read(db, "contentMeta", "source")["revision"]}
            generation = db.execute("SELECT generation FROM course_metadata").fetchone()[0]
            command = {"operationId": "external:" + str(uuid.uuid4()), "actor": "import",
                       "kind": "external_import", "generation": generation,
                       "changes": changes, "expectedRevisions": expected}
            persisted = {("knowledge", c["key"]): {"hash": entity_hash(c["value"])}
                         for c in changes if c["namespace"] == "knowledge" and "value" in c}
            result = self.store._apply_in_transaction(db, command, _json(command),
                                                      persisted_values=persisted, before_values=previous)
            self._checkpoint(db, data, "external_import", result["commitId"])
        self.service.catalog._stamp = None
        return data

    def get(self, identifier):
        if not isinstance(identifier, str) or not identifier:
            raise StoreError("invalid_parameter", "实体 ID 必须是字符串")
        with self.writer_lock():
            self._recover()
            data = self._sync()
            entities = self._entities(data)
            with self.store._transaction() as db:
                state = self.store._read(db, "knowledge", identifier)
                generation = db.execute("SELECT generation FROM course_metadata").fetchone()[0]
            value = entities.get(identifier, (None, None))[1]
            if value is None and not state["revision"]:
                raise StoreError("not_found", "找不到知识实体", {"id": identifier})
            return {"id": identifier, "entity": deepcopy(value),
                    "hash": entity_hash(value) if value is not None else None,
                    "revision": state["revision"], "generation": generation,
                    "deleted": value is None}

    def read(self, identifier):
        result = self.get(identifier)
        return {**result, "value": result["entity"]}

    @staticmethod
    def _prior_result(db, operation_id, payload):
        row = db.execute("SELECT payload_json,result_json FROM operations WHERE operation_id=?",
                         (operation_id,)).fetchone()
        if row:
            if row[0] != payload:
                raise StoreError("invalid_parameter", "operationId 已用于其他请求",
                                 {"operationId": operation_id})
            return json.loads(row[1])
        return None

    @staticmethod
    def _decorate(result):
        return {**result, "knowledgeChanges": [c for c in result["changes"] if c["namespace"] == "knowledge"]}

    def _base(self, db, key, revision):
        if revision == 0:
            return None
        rows = db.execute("SELECT before_json,after_json FROM history WHERE namespace='knowledge' "
                          "AND key=? ORDER BY sequence DESC", (key,))
        for row in rows:
            for raw in row:
                state = json.loads(raw)
                if state["revision"] == revision:
                    return state["value"]
        if revision == 1:
            initial = db.execute("SELECT knowledge_json FROM content_versions WHERE label='initial' LIMIT 1").fetchone()
            if initial:
                return self._entities(json.loads(initial[0])).get(key, (None, None))[1]
        raise StoreError("revision_conflict", "找不到可核验的基础版本", {"id": key, "revision": revision})

    @staticmethod
    def _reading_clock(db, key, current):
        revision = (current or {}).get("reading", {}).get("revision", 0)
        for before, after in db.execute(
                "SELECT before_json,after_json FROM history WHERE namespace='knowledge' AND key=?", (key,)):
            for raw in (before, after):
                value = json.loads(raw)["value"]
                if isinstance(value, dict):
                    revision = max(revision, value.get("reading", {}).get("revision", 0))
        return revision

    def _prepare(self, db, command, data, *, restoring=False, inverse=False):
        candidate = deepcopy(data)
        entities = self._entities(candidate)
        effective = deepcopy(command)
        persisted, previous, conflicts = {}, {}, []
        retired = {item["id"] for item in data.get("retiredUnits", [])}
        for change in effective["changes"]:
            namespace, key = change["namespace"], change["key"]
            token = f"{namespace}:{key}"
            state = self.store._read(db, namespace, key)
            if namespace != "knowledge":
                validator = self.service._validators.get(namespace)
                if validator is None:
                    raise StoreError("capability_unavailable", "未注册内容类型", {"namespace": namespace})
                if state["revision"] != command["expectedRevisions"][token]:
                    conflicts.append({"namespace": namespace, "key": key, **state})
                continue
            old = entities.get(key, (None, None))[1]
            desired = change.get("value")
            previous[(namespace, key)] = {**state, "value": deepcopy(old)}
            expected_revision = command["expectedRevisions"][token]
            expected_hash = command.get("expectedHashes", {}).get(token, _MISSING)
            if expected_hash is not _MISSING and expected_hash != (entity_hash(old) if old is not None else None):
                conflicts.append({"namespace": namespace, "key": key, "path": "/", "reason": "hash_changed",
                                  "entity": old, "revision": state["revision"]})
                continue
            if state["revision"] != expected_revision:
                base = command.get("baseValues", {}).get(token, _MISSING)
                paths = []
                if base is not _MISSING and base == self._base(db, key, expected_revision):
                    desired = _merge(base, old, desired, conflicts=paths)
                else:
                    paths.append("/")
                if paths:
                    conflicts.extend({"namespace": namespace, "key": key, "path": path,
                                      "entity": old, "revision": state["revision"],
                                      "expectedRevision": expected_revision} for path in paths)
                    continue
                effective["expectedRevisions"][token] = state["revision"]
            if desired is not None:
                if not isinstance(desired, dict) or desired.get("id") != key:
                    raise StoreError("invalid_content", "实体身份不一致", {"id": key})
                if key in retired and not restoring:
                    raise StoreError("invalid_content", "退休 ID 不得重新分配", {"id": key})
                if old is None and state["revision"] and not restoring and not inverse:
                    raise StoreError("invalid_content", "已删除 ID 不得重新分配；请使用撤回", {"id": key})
                collection = entities.get(key, (None, None))[0]
                if collection is None and (restoring or inverse):
                    # Only trusted history can recreate other domain namespaces.
                    prefixes = {"KU-": "units", "REL-": "relations", "RG-": "requirementGroups",
                                "TH-": "themes", "SRC-": "sources", "Q-": "questions",
                                "REF-": "referenceItems", "MAP-": "mappings"}
                    collection = next((name for prefix, name in prefixes.items() if key.startswith(prefix)), None)
                if collection is None:
                    if key.startswith("KU-"):
                        collection = "units"
                    elif key.startswith("REL-"):
                        collection = "relations"
                    elif key.startswith("SRC-") and command["actor"] == "import":
                        collection = "sources"
                    elif re.fullmatch(r"(?:RG-|G)[A-Za-z0-9_-]+", key):
                        collection = "requirementGroups"
                    else:
                        raise StoreError("invalid_parameter", "不支持创建该命名空间", {"id": key})
                if not restoring and collection == "units" and isinstance(desired.get("reading"), dict):
                    if not inverse and command["actor"] != "import":
                        from .semantic_components import validate_changed_components
                        validate_changed_components(old, desired)
                    old_reading = (old or {}).get("reading", {})
                    new_reading = desired["reading"]
                    comparable = lambda r: {k: v for k, v in r.items() if k != "revision"}
                    if comparable(new_reading) != comparable(old_reading):
                        new_reading["revision"] = self._reading_clock(db, key, old) + 1
                    else:
                        new_reading["revision"] = old_reading.get("revision", new_reading.get("revision", 1))
                change.pop("delete", None)
                change["value"] = desired
                persisted[(namespace, key)] = {"hash": entity_hash(desired)}
            else:
                collection = entities.get(key, (None, None))[0]
                change.pop("value", None)
                change["delete"] = True
            if old is not None:
                candidate[collection] = [desired if item["id"] == key else item
                                         for item in candidate[collection]
                                         if item["id"] != key or desired is not None]
            elif desired is not None:
                candidate[collection].append(desired)
        targets = {f"{c['namespace']}:{c['key']}" for c in command["changes"]}
        for token, expected_hash in command.get("expectedHashes", {}).items():
            if token in targets:
                continue
            if not token.startswith("knowledge:"):
                raise StoreError("invalid_parameter", "expectedHashes 仅适用于 knowledge")
            key = token.split(":", 1)[1]
            value = entities.get(key, (None, None))[1]
            if expected_hash != (entity_hash(value) if value is not None else None):
                conflicts.append({"namespace": "knowledge", "key": key, "path": "/",
                                  "reason": "hash_changed", "entity": value})
        if conflicts:
            raise StoreError("revision_conflict", "目标内容已改变", {"conflicts": conflicts})
        if not restoring:
            self._validate(candidate)
        return effective, candidate, persisted, previous

    def apply(self, command):
        command, payload = CourseStore._command(command)
        if not isinstance(command["actor"], str) or command["actor"] not in {"student", "agent", "import"}:
            raise StoreError("invalid_parameter", "未知修改者")
        if len(command["changes"]) > 200:
            raise StoreError("invalid_parameter", "单次变更超过 200 项")
        for change in command["changes"]:
            if change["namespace"] == "knowledge" and not change.get("delete") and not isinstance(change.get("value"), dict):
                raise StoreError("invalid_content", "knowledge value 必须是原始实体，删除请用 delete:true",
                                 {"id": change["key"]})
            if change["namespace"] in {"tasks", "conversations", "messages"}:
                raise StoreError("invalid_parameter", "内容命令不能回写任务或执行事实")
        for field in ("expectedHashes", "baseValues"):
            if field in command and not isinstance(command[field], dict):
                raise StoreError("invalid_parameter", f"{field} 必须是对象")
        with self.writer_lock():
            self._recover()
            # Dedup precedes validation/sync: a saved retry remains a saved retry,
            # even after deletion, generation restore, or a new external import.
            with self.store._transaction() as db:
                prior = self._prior_result(db, command["operationId"], payload)
            if prior is not None:
                return self._decorate(prior)
            data = self._sync()
            result = self._commit(command, payload, data)
        return self._notify(result)

    def _commit(self, command, payload, data, *, restore_data=None, label=None):
        # Validators may read CourseStore (e.g. orphan anchors). Run them under
        # the writer lock, before opening a SQLite transaction. History inverses
        # and restores use already-validated historical personal values.
        if restore_data is None and label != "undo":
            for change in command["changes"]:
                namespace = change["namespace"]
                if namespace != "knowledge" and not change.get("delete"):
                    validator = self.service._validators.get(namespace)
                    if validator is None:
                        raise StoreError("capability_unavailable", "未注册内容类型", {"namespace": namespace})
                    validator(change["key"], change["value"])
        # Validate/CAS before publishing the intent. SQLite BEGIN IMMEDIATE also
        # excludes generic personal-state writers until this preparation ends.
        with self.store._transaction(write=True) as db:
            generation = db.execute("SELECT generation FROM course_metadata").fetchone()[0]
            if generation != command["generation"]:
                raise StoreError("revision_conflict", "课程代际已改变",
                                 {"generation": generation, "expectedGeneration": command["generation"]})
            effective, candidate, persisted, previous = self._prepare(db, command, data, restoring=restore_data is not None, inverse=label == "undo")
            if restore_data is not None:
                candidate = restore_data
                self._validate(candidate)
            db.execute("INSERT INTO content_journal VALUES (1,?,?,?)",
                       (command["operationId"], _json(data), _json(candidate)))
        replaced = False
        try:
            self._fault("after_journal")
            with self.store._transaction(write=True) as db:
                # Recheck SQLite CAS after the separately committed intent.
                # The JSON check detects noncooperating #02 importers.
                if self._load() != data:
                    raise StoreError("revision_conflict", "写入前检测到外部导入", {"path": str(self.path)})
                self._checkpoint(db, data, "before_" + (label or command["kind"]))
                result = self.store._apply_in_transaction(db, effective, payload,
                                                          persisted_values=persisted,
                                                          before_values=previous,
                                                          bump_generation=restore_data is not None)
                self._fault("before_replace")
                if self._load() != data:
                    raise StoreError("revision_conflict", "替换前检测到外部导入")
                if candidate != data:
                    replaced = True  # rename may succeed before fsync fails
                    self._write(candidate)
                self._fault("after_replace")
                self._checkpoint(db, candidate, label or command["kind"], result["commitId"])
                self._fault("before_sqlite_commit")
            self._fault("after_sqlite_commit")
        except Exception as exc:
            try:
                if not replaced:
                    with self.store._transaction(write=True) as db:
                        db.execute("DELETE FROM content_journal")
                else:
                    self._recover()
            except Exception as recovery:
                raise StoreError("save_failed", "提交失败且 journal 等待恢复",
                                 {"reason": str(exc), "recovery": str(recovery),
                                  "operationId": command["operationId"]}) from exc
            if isinstance(exc, StoreError):
                raise
            raise StoreError("save_failed", "知识提交失败，已恢复完整状态",
                             {"reason": str(exc), "operationId": command["operationId"]}) from exc
        # A cleanup error never changes a durable commit into an unsaved result.
        # Next read/retry resolves the retained journal using the ledger.
        try:
            with self.store._transaction(write=True) as db:
                db.execute("DELETE FROM content_journal")
        except StoreError:
            pass
        return self._decorate(result)

    def _notify(self, result):
        if self.changed is not None:
            try:
                self.changed(result)
            except Exception:
                # Notification is a task concern, not a reason to repeat writes.
                # The runtime must record delivery/ack independently of saved.
                result = {**result, "notificationError": "changed callback failed; delivery unconfirmed"}
        return result

    def history(self):
        """HTTP adapter; selective undo itself reads CourseStore.history."""
        return {"versions": self.versions()}

    def versions(self):
        with self.writer_lock():
            self._recover()
            self._sync()
            with self.store._transaction() as db:
                return [{"versionId": vid, "sequence": seq, "generation": gen, "label": label}
                        for vid, seq, gen, label in db.execute(
                            "SELECT version_id,sequence,generation,label FROM content_versions ORDER BY rowid")]

    def _history_request(self, command, kind, target, generation):
        if command is None:
            command = {"operationId": (f"undo:{target}:{generation}" if kind == "undo"
                                        else "restore:" + str(uuid.uuid4())),
                       "actor": "student", "generation": generation}
        request = json.loads(_json(command))
        if not isinstance(request, dict):
            raise StoreError("invalid_parameter", "历史命令必须是对象")
        request = {**request, "kind": kind, "target": target}
        if not isinstance(request.get("operationId"), str) or not request["operationId"]:
            raise StoreError("invalid_parameter", "缺少 operationId")
        if not isinstance(request.get("actor"), str) or request["actor"] not in {"student", "agent", "import"}:
            raise StoreError("invalid_parameter", "未知修改者")
        if type(request.get("generation")) is not int:
            raise StoreError("invalid_parameter", "缺少 generation")
        return request, _json(request)

    def undo(self, operation_id, command=None):
        if not isinstance(operation_id, str) or not operation_id:
            raise StoreError("invalid_parameter", "operationId 必须是字符串")
        with self.writer_lock():
            self._recover()
            data = self._sync()
            with self.store._transaction() as db:
                generation = db.execute("SELECT generation FROM course_metadata").fetchone()[0]
                request, payload = self._history_request(command, "undo", operation_id, generation)
                prior = self._prior_result(db, request["operationId"], payload)
                if prior is not None:
                    return self._decorate(prior)
                row = db.execute("SELECT result_json FROM operations WHERE operation_id=?", (operation_id,)).fetchone()
                if row is None:
                    raise StoreError("not_found", "找不到要撤回的操作", {"operationId": operation_id})
                target = json.loads(row[0])
                changes, expected, conflicts = [], {}, []
                entities = self._entities(data)
                for namespace, key, before, after in db.execute(
                        "SELECT namespace,key,before_json,after_json FROM history WHERE sequence=? ORDER BY ordinal",
                        (target["sequence"],)):
                    if namespace in {"contentMeta", "tasks", "conversations", "messages"}:
                        raise StoreError("invalid_parameter", "执行事实不可撤回；顶层结构导入请使用整幅恢复")
                    before, after = json.loads(before), json.loads(after)
                    state = self.store._read(db, namespace, key)
                    current = entities.get(key, (None, None))[1] if namespace == "knowledge" else state["value"]
                    b = _MISSING if after["deleted"] else after["value"]
                    c = _MISSING if state["deleted"] else current
                    d = _MISSING if before["deleted"] else before["value"]
                    paths = []
                    if namespace != "knowledge" and state["revision"] != after["revision"]:
                        paths.append("/")
                        desired = c
                    else:
                        desired = _merge(b, c, d, conflicts=paths)
                    conflicts.extend({"namespace": namespace, "key": key, "path": path,
                                      "entity": current, "revision": state["revision"]} for path in paths)
                    changes.append({"namespace": namespace, "key": key,
                                    **({"delete": True} if desired is _MISSING else {"value": desired})})
                    expected[f"{namespace}:{key}"] = state["revision"]
                if conflicts:
                    raise StoreError("revision_conflict", "撤回片段已有后续改动", {"conflicts": conflicts})
            effective = {**request, "changes": changes, "expectedRevisions": expected}
            result = self._commit(effective, payload, data, label="undo")
        return self._notify(result)

    def restore(self, sequence, command=None):
        """Restore knowledge + selected personal state; never rewind task facts."""
        if type(sequence) is not int or sequence < 0:
            raise StoreError("invalid_parameter", "sequence 必须为非负整数")
        with self.writer_lock():
            self._recover()
            data = self._sync()
            with self.store._transaction() as db:
                generation = db.execute("SELECT generation FROM course_metadata").fetchone()[0]
                request, payload = self._history_request(command, "restore", sequence, generation)
                prior = self._prior_result(db, request["operationId"], payload)
                if prior is not None:
                    return self._decorate(prior)
                latest = db.execute("SELECT sequence FROM course_metadata").fetchone()[0]
                version = db.execute("SELECT sequence,knowledge_json,personal_json FROM content_versions "
                                     "WHERE sequence<=? ORDER BY sequence DESC,rowid DESC LIMIT 1", (sequence,)).fetchone()
                if version is None or sequence > latest:
                    raise StoreError("not_found", "找不到课程版本", {"sequence": sequence})
                baseline, raw_knowledge, raw_personal = version
                desired, personal = json.loads(raw_knowledge), json.loads(raw_personal)
                for namespace, key, raw_after in db.execute(
                        "SELECT namespace,key,after_json FROM history WHERE sequence>? AND sequence<=? "
                        "ORDER BY sequence,ordinal", (baseline, sequence)):
                    after = json.loads(raw_after)
                    if namespace == "knowledge":
                        indexed = self._entities(desired)
                        collection = indexed.get(key, (None, None))[0]
                        if collection is None and not after["deleted"]:
                            # A creation is present in a post-commit content version
                            # at this same sequence; absent versions are corruption.
                            raise StoreError("save_failed", "历史缺少知识创建恢复点", {"id": key})
                        if collection is not None:
                            desired[collection] = [item for item in desired[collection] if item["id"] != key]
                            if not after["deleted"]:
                                desired[collection].append(after["value"])
                    elif namespace in _PERSONAL:
                        personal[f"{namespace}:{key}"] = {"value": after["value"], "deleted": after["deleted"]}
                # Evidence versions remain available to later notes/conversations
                # even when learning content is restored to an earlier point.
                known_sources = {source["id"]: source for source in desired.get("sources", [])}
                for source in data.get("sources", []):
                    if source["id"] not in known_sources:
                        desired["sources"].append(deepcopy(source))
                    else:
                        retained = known_sources[source["id"]]
                        versions = {item["id"] for item in retained.get("versions", [])}
                        retained.setdefault("versions", []).extend(deepcopy(item) for item in source.get("versions", []) if item["id"] not in versions)
                old, new = self._entities(data), self._entities(desired)
                changes, expected = [], {}
                known = {key for key, in db.execute("SELECT key FROM documents WHERE namespace='knowledge'")}
                for key in sorted(known | old.keys() | new.keys()):
                    value = deepcopy(new.get(key, (None, None))[1])
                    if value is not None and isinstance(value.get("reading"), dict):
                        value["reading"]["revision"] = max(value["reading"].get("revision", 0),
                                                            self._reading_clock(db, key, old.get(key, (None, None))[1])) + 1
                        for entity in desired[new[key][0]]:
                            if entity["id"] == key:
                                entity["reading"] = deepcopy(value["reading"])
                    changes.append({"namespace": "knowledge", "key": key,
                                    **({"delete": True} if value is None else {"value": value})})
                    expected[f"knowledge:{key}"] = self.store._read(db, "knowledge", key)["revision"]
                current = self._personal(db)
                for token in sorted(current.keys() | personal.keys()):
                    namespace, key = token.split(":", 1)
                    state = personal.get(token, {"deleted": True})
                    changes.append({"namespace": namespace, "key": key,
                                    **({"delete": True} if state["deleted"] else {"value": state["value"]})})
                    expected[token] = self.store._read(db, namespace, key)["revision"]
            effective = {**request, "changes": changes, "expectedRevisions": expected}
            result = self._commit(effective, payload, data, restore_data=desired, label="restore")
        return self._notify(result)
