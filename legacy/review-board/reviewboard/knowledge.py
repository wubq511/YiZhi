"""Read course semantics through the existing knowledge-map module."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import threading

from .paths import KNOWLEDGE_TOOLS_ROOT


class KnowledgeCatalog:
    PRIMARY_IDS = ("KU-035", "KU-055", "KU-056", "KU-063")

    def __init__(self, root: Path, knowledge_path: Path):
        self.root = root
        self.path = knowledge_path
        self._lock = threading.RLock()
        self._stamp = None
        self._store = None
        tool = KNOWLEDGE_TOOLS_ROOT / "知识地图.py"
        if not tool.is_file():
            raise FileNotFoundError(f"应用缺少知识查询工具：{tool}")
        sys.path.insert(0, str(tool.parent))
        spec = importlib.util.spec_from_file_location("review_course_knowledge", tool)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def store(self):
        with self._lock:
            stat = self.path.stat()
            stamp = (stat.st_mtime_ns, stat.st_size)
            if stamp != self._stamp:
                data = self.module.load_data(self.path)
                self._store = self.module.Store(data, root=self.root)
                self._stamp = stamp
            return self._store

    def get(self, identifier):
        return self.store().get(identifier)

    def graph(self, view="main"):
        if view not in {"main", "auxiliary", "all"}:
            raise self.module.MapError("invalid_parameter", "未知关系视图")
        return self.store().graph(view)

    def unit_ids(self):
        return set(self.store().units)

    def view(self):
        """Preserve the accepted sample until the content provider publishes more."""
        store = self.store()
        graph = store.graph("all")
        primary = {uid for uid in self.PRIMARY_IDS if uid in store.units}
        published = {
            uid for uid, unit in store.units.items()
            if unit.get("reading", {}).get("status") == "complete"
        }
        active = primary | published
        edges = [edge for edge in graph["edges"]
                 if edge["fromUnitId"] in active or edge["toUnitId"] in active]
        visible = active | {edge[key] for edge in edges
                            for key in ("fromUnitId", "toUnitId")}
        units = [store.get(uid) for uid in sorted(visible)]
        theme_ids = {unit["themeId"] for unit in units}
        source_ids = {ref["sourceId"] for unit in units
                      for ref in unit.get("sourceRefs", [])}
        return {
            "sourceHash": graph["sourceHash"],
            "primaryIds": sorted(primary),
            "publishedIds": sorted(published),
            "units": units,
            "themes": [theme for theme in graph["groups"] if theme["id"] in theme_ids],
            "layout": graph["layout"],
            "edges": edges,
            "sources": [store.get(sid) for sid in sorted(source_ids)],
            "catalogCounts": graph["counts"],
        }

    def query(self, operation, params):
        store = self.store()
        first = lambda key, default=None: params.get(key, [default])[0]
        integer = lambda key, default: int(first(key, default))
        if operation == "search":
            return store.search(text=first("q", ""), entity=first("entity", "unit"),
                                limit=integer("limit", 20))
        if operation == "related":
            return store.related(first("id"), relation_type=first("relation", "requires"),
                                 direction=first("direction", "upstream"),
                                 depth=integer("depth", 1), view=first("view", "all"))
        if operation == "path":
            return store.path(first("from"), first("to"),
                              relation_type=first("relation", "requires"))
        if operation == "questions":
            return store.question_mappings(first("id"), role=first("role", "all"))
        raise self.module.MapError("invalid_parameter", "未知知识查询操作")
