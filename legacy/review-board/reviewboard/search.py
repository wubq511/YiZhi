from __future__ import annotations

from copy import deepcopy
import re
import subprocess
from threading import RLock

from .storage import StoreError


SCOPES = {"knowledge", "notes", "conversations", "sources"}


def warning_location(locations):
    pages = sorted({loc["pdfPage"] for loc in locations if "pdfPage" in loc})
    sections = sorted({loc["section"] for loc in locations if "section" in loc})
    result = {"pdfPages": pages} if pages else {}
    if len(sections) == 1:
        result["section"] = sections[0]
    elif sections:
        result["sections"] = sections
    return result


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        yield str(value)
    elif isinstance(value, dict):
        for key, item in value.items():
            if key not in {"sourceRefs", "versions", "sha256", "baseSourceHash", "baseEntityHashes"}:
                yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def excerpt(text, query, size=180):
    flat = re.sub(r"\s+", " ", text).strip()
    index = flat.casefold().find(query.casefold())
    if index < 0:
        return None
    start = max(0, index - 60)
    end = min(len(flat), index + len(query) + 100)
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")


def hit(scope, identifier, name, text, location, version, query, rank=5, entity_type=None):
    fragment = excerpt(text, query)
    if fragment is None:
        return None
    return {"scope": scope, "id": identifier, "entityType": entity_type or scope,
            "name": name, "snippet": fragment, "location": location,
            "version": str(version), "_rank": rank}


class CourseSearch:
    def __init__(self, catalog, library, state_provider):
        self.catalog = catalog
        self.library = library
        self.state_provider = state_provider
        self._key = None
        self._documents = []
        self._warnings = []
        self._source_stamps = {}
        self._lock = RLock()

    def _knowledge(self):
        store = self.catalog.store()
        version = store.hash
        for theme in store.themes.values():
            yield from self._hits("knowledge", theme["id"], theme["name"],
                                  " ".join(strings(theme)), {"themeId": theme["id"]}, version, 2, "theme")
        for unit in store.units.values():
            base_text = " ".join(strings({key: value for key, value in unit.items() if key != "reading"}))
            yield from self._hits("knowledge", unit["id"], unit["name"], base_text,
                                  {"unitId": unit["id"]}, version, 1, "unit")
            def walk(block):
                text = " ".join(strings(block.get("payload", {})))
                yield from self._hits("knowledge", unit["id"], unit["name"], text,
                                      {"unitId": unit["id"], "blockId": block["id"]}, version, 4, "unit")
                for child in block.get("children", []):
                    yield from walk(child)
            for block in unit.get("reading", {}).get("blocks", []):
                yield from walk(block)
        for question in store.questions.values():
            mappings = sorted(store.by_question[question["id"]],
                              key=lambda item: (item["role"] != "direct", item["id"]))
            unit_ids = [item["unitId"] for item in mappings]
            location = {"questionId": question["id"], "unitIds": unit_ids}
            if unit_ids:
                location["unitId"] = unit_ids[0]
            yield from self._hits("knowledge", question["id"], question["label"],
                                  " ".join(strings(question)), location, version, 3, "question")

    def _hits(self, scope, identifier, name, text, location, version, rank, entity_type):
        yield {"scope": scope, "id": identifier, "name": name, "text": text or name,
               "location": location, "version": str(version),
               "_rank": rank, "entityType": entity_type}

    def _personal(self, snapshot):
        documents = snapshot.get("documents", {})
        for key, record in documents.get("notes", {}).items():
            value = record.get("value") or {}
            text = value.get("text", "")
            object_id = value.get("objectId") or value.get("anchor", {}).get("objectId")
            yield from self._hits("notes", value.get("noteId", key), f"个人笔记 · {object_id or key}",
                                  text, {"unitId": object_id, "noteId": value.get("noteId", key)},
                                  record.get("revision", 0), 3, "note")
        for key, record in documents.get("conversations", {}).items():
            value = record.get("value") or {}
            conversation_id = value.get("conversationId", key)
            for message in value.get("messages", []):
                message_id = message["messageId"]
                yield from self._hits("conversations", message_id, f"学习对话 · {conversation_id}",
                                      message.get("text", ""),
                                      {"conversationId": conversation_id, "messageId": message_id},
                                      record.get("revision", 0), 3, "message")

    def _source_signature(self, store):
        """Detect resource loss/recovery even without a committed course event.

        ctime/inode also detect same-size replacements with a preserved mtime.
        Evict the reader's caches for changed versions before it verifies hashes
        and extracts text; otherwise rebuilding could reuse stale reader data.
        """
        stamps = {}
        for source in store.sources.values():
            for version in source.get("versions", []):
                identifier = (source["id"], version["id"])
                path = None
                try:
                    path = self.library._inside(version["path"])
                    stat = path.stat()
                    resource = (str(path), stat.st_dev, stat.st_ino, stat.st_size,
                                stat.st_mtime_ns, stat.st_ctime_ns)
                except (StoreError, OSError) as exc:
                    resource = (getattr(exc, "code", "source_unavailable"), str(exc))
                stamp = (version["path"], version["sha256"], resource)
                stamps[identifier] = stamp
                if self._source_stamps.get(identifier) != stamp:
                    if path is not None:
                        self.library._hashes.pop(path, None)
                    self.library._pdf_text.pop(identifier, None)
        self._source_stamps = stamps
        return tuple(sorted(stamps.items()))

    def _sources(self, warnings):
        store = self.catalog.store()
        seen = set()
        for source in store.sources.values():
            for version in source.get("versions", []):
                identifier = (source["id"], version["id"])
                if identifier in seen:
                    continue
                seen.add(identifier)
                unavailable = []
                documents = []
                try:
                    for page in self.library.text_pages(source["id"], version["id"]):
                        if page["textStatus"] == "unavailable":
                            if page["location"] not in unavailable:
                                unavailable.append(page["location"])
                            continue
                        documents.extend(self._hits("sources", source["id"], source["title"], page["text"],
                                                    page["location"], version["id"], 5, "source"))
                except (StoreError, OSError, UnicodeError, subprocess.SubprocessError) as exc:
                    details = getattr(exc, "details", {})
                    warning = {"sourceId": source["id"], "versionId": version["id"],
                               "title": source["title"], "code": getattr(exc, "code", "source_unavailable"),
                               "message": str(exc), "details": details}
                    location = warning_location([details.get("location", details)])
                    if location:
                        warning["location"] = location
                    warnings.append(warning)
                    continue
                yield from documents
                if unavailable:
                    location = warning_location(unavailable)
                    warning = {"sourceId": source["id"], "versionId": version["id"],
                               "title": source["title"], "code": "source_unavailable",
                               "message": f"此版本有 {len(unavailable)} 处没有可用文本，可回查原文",
                               "location": location}
                    if "pdfPages" in location:
                        warning["unavailablePages"] = len(location["pdfPages"])
                    warnings.append(warning)

    def _rebuild(self, snapshot):
        warnings = []
        documents = []
        documents.extend(self._knowledge())
        documents.extend(self._personal(snapshot))
        documents.extend(self._sources(warnings))
        self._documents, self._warnings = documents, warnings

    def search(self, text, scopes=None, mode="keyword", limit=50):
        if mode != "keyword":
            raise StoreError("capability_unavailable", "描述性检索由 Agent 工作线接入")
        if not isinstance(text, str) or not text.strip():
            raise StoreError("invalid_parameter", "搜索关键词不能为空")
        if type(limit) is not int or not 1 <= limit <= 200:
            raise StoreError("invalid_parameter", "搜索数量必须在 1–200 之间")
        selected = set(SCOPES if scopes is None else scopes)
        if not selected or not selected <= SCOPES:
            raise StoreError("invalid_parameter", "搜索范围无效")
        with self._lock:
            snapshot = self.state_provider()
            store = self.catalog.store()
            source_hash = store.hash
            sequence = snapshot.get("sequence", 0)
            key = (source_hash, sequence, self._source_signature(store))
            if key != self._key:
                self._rebuild(snapshot)
                self._key = key
            documents = self._documents
            warnings = deepcopy(self._warnings) if "sources" in selected else []
        query = text.strip()
        items = []
        for item in documents:
            if item["scope"] not in selected:
                continue
            rank = item["_rank"]
            if query.casefold() in item["name"].casefold():
                rank = 0 if item["name"].casefold() == query.casefold() else min(rank, 1)
            result = hit(item["scope"], item["id"], item["name"], item["text"],
                         item["location"], item["version"], query, rank, item["entityType"])
            if result:
                items.append(result)
        items.sort(key=lambda item: (item["_rank"], item["scope"], item["id"], str(item["location"])))
        items = items[:limit]
        for item in items:
            item.pop("_rank", None)
        return {"query": text, "mode": mode, "scopes": sorted(selected),
                "count": len(items), "items": items,
                "index": {"status": "ready", "sourceHash": source_hash, "sequence": sequence},
                "sourceWarnings": warnings}
