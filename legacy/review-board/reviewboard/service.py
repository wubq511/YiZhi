"""Course manifest, domain validation and the single persistence boundary."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading
import uuid
import math
import re

from .knowledge import KnowledgeCatalog
from .search import CourseSearch
from .material_sources import MaterialSourceLibrary
from .storage import CourseStore, StoreError


def inside(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise StoreError("invalid_parameter", "课程资源路径超出课程文件夹")
    return path


def open_manifest(root: Path):
    path = root / "课程.json"
    if not path.exists():
        manifest = {
            "schemaVersion": "review-course-1",
            "courseId": "COURSE-" + str(uuid.uuid4()),
            "name": "数字逻辑与部件设计",
            "knowledge": "期中/数据/知识地图.json",
            "layout": "期中/数据/视图布局.json",
            "state": ".review-board/状态.sqlite3",
        }
        try:
            with path.open("x", encoding="utf-8") as handle:
                json.dump(manifest, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
        except FileExistsError:
            pass
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != "review-course-1":
            raise ValueError("不支持的课程格式")
        for key in ("courseId", "name", "knowledge", "layout", "state"):
            if not isinstance(manifest.get(key), str) or not manifest[key]:
                raise ValueError(f"缺少课程字段：{key}")
        for key in ("knowledge", "layout", "state"):
            inside(root, manifest[key])
        return manifest
    except (ValueError, OSError) as exc:
        raise StoreError("invalid_content", f"无法读取课程清单：{exc}") from exc


class CourseService:
    CAPABILITIES = ["knowledge.read", "notes.object", "review.state", "reading.restore",
                    "commands.atomic", "events.resume", "resources.local",
                    "sources.read", "search.keyword"]

    def __init__(self, root: Path, *, catalog=None):
        self.root = Path(root).resolve()
        self.manifest = open_manifest(self.root)
        self.catalog = catalog or KnowledgeCatalog(
            self.root, inside(self.root, self.manifest["knowledge"]))
        state_path = inside(self.root, self.manifest["state"])
        state_path.parent.mkdir(parents=True, exist_ok=True)
        self.store = CourseStore(state_path, self.manifest["courseId"])
        self.sources = MaterialSourceLibrary(self.root, self.catalog, self.root / ".review-board/cache/source-pages")
        self.search = CourseSearch(self.catalog, self.sources, self.store.snapshot)
        self._command_lock = threading.RLock()
        self._validators = {
            "notes": self._note,
            "review": self._review,
            "reading": self._reading,
            "layout": self._layout,
            "annotations": self._annotation,
            "agent_ui": self._agent_ui,
            "editingDrafts": self._editing_draft,
            "semanticChanges": self._semantic_change,
        }
        self._content = None
        self._agent = None
        self._supports_content = hasattr(self.catalog, "path") and callable(
            getattr(getattr(self.catalog.module, "Store", None), "validate", None))
        if self._supports_content:
            from .material_import import MaterialImporter
            from .content_imports import register_imports
            self._material_importer = MaterialImporter(self)
            register_imports(self)
            # Readers and JSON/SQLite commands share a lock. Recover before first rendering.
            self.catalog._lock = self._command_lock
            try:
                self.content
            except Exception:
                self.store.close()
                raise

    @property
    def content(self):
        with self._command_lock:
            if self._content is None:
                if not self._supports_content:
                    raise StoreError("capability_unavailable", "此课程读取适配器尚未接入内容写入")
                from .content_commands import ContentCommands
                # Journal recovery precedes reads; full content validation is needed
                # for editing, not for reading a course whose source PDF is missing.
                self._content = ContentCommands(self, initialize=False)
            return self._content

    @property
    def agent(self):
        with self._command_lock:
            if self._agent is None:
                from .agent_runtime import AgentRuntime
                self._agent = AgentRuntime(self)
            return self._agent

    def register_namespace(self, namespace, validator):
        """Feature modules register here; they never create their own state writer."""
        if namespace in self._validators:
            raise ValueError(f"namespace 已注册：{namespace}")
        self._validators[namespace] = validator

    def open_course(self):
        with self._command_lock:
            if self._content:
                self._content._recover()
                from .anchors import reconcile_anchors
                reconcile_anchors(self)
            view = self.catalog.view()
            return {"course": self.manifest, "view": view,
                    "catalog": {"counts": view["catalogCounts"], "sourceHash": view["sourceHash"]},
                    "state": self.store.snapshot(), "capabilities": self.CAPABILITIES + ["agent.ask", "agent.recover", "annotations.edit"] + (
                        ["agent.edit", "content.edit", "sources.import"] if self._supports_content else [])}

    def _object(self, value):
        if not isinstance(value, dict):
            raise StoreError("invalid_content", "内容必须是对象")

    def _unit(self, identifier):
        if not isinstance(identifier, str) or identifier not in self.catalog.unit_ids():
            raise StoreError("not_found", "找不到知识单元", {"id": identifier})

    def _note(self, key, value):
        self._object(value)
        self._anchor_object(key, value.get("objectId"), "notes")
        if value.get("noteId") != key or not key.startswith("NOTE-"):
            raise StoreError("invalid_content", "笔记身份不一致")
        if not isinstance(value.get("text"), str) or len(value["text"]) > 100_000:
            raise StoreError("invalid_content", "笔记内容无效或过长")
        anchor = value.get("anchor")
        if not isinstance(anchor, dict) or anchor.get("objectId") != value["objectId"]:
            raise StoreError("invalid_content", "笔记缺少稳定对象引用")

    def _review(self, key, value):
        self._unit(key)
        self._object(value)
        if not isinstance(value.get("status"), str) or value["status"] not in {"todo", "weak", "mastered"}:
            raise StoreError("invalid_content", "复习状态只能是待复习、薄弱或已掌握")

    def _reading(self, key, value):
        self._object(value)
        if key != "default":
            raise StoreError("invalid_parameter", "未知阅读上下文")
        selected = value.get("selected")
        if selected:
            self._unit(selected)
        camera = value.get("camera")
        if camera is not None:
            import math
            if not isinstance(camera, dict) or any(
                type(camera.get(k)) not in (int, float) or not math.isfinite(camera[k])
                for k in ("x", "y", "scale")
            ) or not .005 <= camera["scale"] <= 10:
                raise StoreError("invalid_content", "阅读视口无效")
        if not isinstance(value.get("mode", "overview"), str) or value.get("mode", "overview") not in {"overview", "units", "detail"}:
            raise StoreError("invalid_content", "未知显示深度")

    def _layout(self, key, value):
        self._object(value)
        if not key.startswith(("VE-", "DRAW-")):
            raise StoreError("invalid_parameter", "布局使用视觉对象身份")
        for field in ("x", "y", "width", "height"):
            if field in value and (type(value[field]) not in (int, float) or not math.isfinite(value[field])):
                raise StoreError("invalid_content", "布局坐标或尺寸无效")
        if any(value.get(k, 0) < 0 for k in ("width", "height")):
            raise StoreError("invalid_content", "布局尺寸不能为负")

    def _anchor_object(self, key, identifier, namespace):
        if not isinstance(identifier, str) or not re.fullmatch(r"KU-\d+", identifier):
            raise StoreError("invalid_content", "缺少稳定知识对象身份")
        if identifier not in self.catalog.unit_ids():
            old = self.store.read(namespace, key)["value"]
            if not old or old.get("objectId") != identifier:
                raise StoreError("not_found", "关联对象不存在；已有个人内容仍保留")

    def _annotation(self, key, value):
        self._object(value)
        if not key.startswith("DRAW-") or value.get("drawingId") != key:
            raise StoreError("invalid_content", "图形身份不一致")
        self._anchor_object(key, value.get("objectId"), "annotations")
        if not isinstance(value.get("tool"), str) or value["tool"] not in {"line", "wave", "highlight", "rectangle", "ellipse", "arrow"}:
            raise StoreError("invalid_content", "未知标注工具")
        anchor = value.get("anchor")
        if not isinstance(anchor, dict) or anchor.get("objectId") != value["objectId"]:
            raise StoreError("invalid_content", "图形缺少稳定引用")

    def _agent_ui(self, key, value):
        self._object(value)
        if key != "default":
            raise StoreError("invalid_parameter", "未知学习侧栏")

    def _editing_draft(self, key, value):
        self._object(value)
        if len(json.dumps(value, ensure_ascii=False)) > 500_000:
            raise StoreError("invalid_content", "编辑草稿过大")

    def _semantic_change(self, key, value):
        self._object(value)
        self._unit(key)
        if value.get("status") not in {"needs-review", "consistent"}:
            raise StoreError("invalid_content", "未知交互核对状态")

    def apply_command(self, command):
        if not isinstance(command, dict):
            raise StoreError("invalid_parameter", "命令必须是对象")
        changes = command.get("changes")
        if not isinstance(changes, list) or not 1 <= len(changes) <= 200:
            raise StoreError("invalid_parameter", "命令缺少有效的修改对象")
        if not isinstance(command.get("actor"), str) or command["actor"] not in {"student", "agent", "import"}:
            raise StoreError("invalid_parameter", "未知修改者")
        if "materialChange" in command and not isinstance(command["materialChange"],bool):
            raise StoreError("invalid_parameter", "实质变化标记无效")
        if any(isinstance(change, dict) and change.get("namespace") == "knowledge" for change in changes):
            result = self.content.apply(command)
            if command.get("materialChange") is True:
                for change in result.get("knowledgeChanges",[]):
                    if change["key"].startswith("KU-") and change.get("value"):
                        self.agent._mastery_prompt(change["key"],result["operationId"],
                            command.get("materialReason") or "重要结论或方法发生变化")
            if self._agent:
                self._agent.notify_change({**result, "actor": command["actor"]})
            return result
        with self._command_lock:
            for change in changes:
                if not isinstance(change, dict):
                    raise StoreError("invalid_parameter", "修改内容无效")
                namespace, key = change.get("namespace"), change.get("key")
                if not isinstance(namespace, str):
                    raise StoreError("invalid_parameter", "修改类型必须是字符串")
                if namespace not in self._validators:
                    raise StoreError("capability_unavailable", "此类修改尚未接入", {"namespace": namespace})
                if not isinstance(key, str) or not key or len(key) > 200:
                    raise StoreError("invalid_parameter", "修改对象身份无效")
                if change.get("delete") is True:
                    if namespace not in {"notes", "annotations", "layout", "editingDrafts"}:
                        raise StoreError("capability_unavailable", "此类删除尚未接入")
                else:
                    self._validators[namespace](key, change.get("value"))
            return self.store.apply(command)

    def close(self):
        if self._agent:
            self._agent.close()
        self.store.close()
