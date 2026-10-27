"""Immutable uploaded resources and atomic, idempotent source-version imports."""
from __future__ import annotations

import base64
import binascii
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone

from .content_commands import entity_hash
from .storage import StoreError


MAX_BYTES = 40 * 1024 * 1024
MAX_BASE64 = 4 * ((MAX_BYTES + 2) // 3)


def _sync_directory(path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


class MaterialImporter:
    """add(request) returns the durable receipt plus sourceId/versionId/alreadyExists.

    materialImports records request identity in the SAME command as the source;
    the operation ledger supplies the original receipt after a lost response.
    All importers share ContentCommands.writer_lock, including file cleanup.
    """

    def __init__(self, service):
        self.service = service
        with service._command_lock:
            for namespace, validator in (("materialImports", self._import_record),
                                         ("materialUpdates", self._prompt),
                                         ("sourceTracking", self._tracking)):
                if namespace not in service._validators:
                    service.register_namespace(namespace, validator)

    @staticmethod
    def _import_record(key, value):
        if (not isinstance(value, dict) or value.get("operationId") != key
                or not isinstance(value.get("requestHash"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", value["requestHash"])
                or not isinstance(value.get("sourceId"), str)
                or not value["sourceId"].startswith("SRC-")
                or not isinstance(value.get("versionId"), str)
                or not value["versionId"].startswith("VER-")
                or type(value.get("alreadyExists")) is not bool):
            raise StoreError("invalid_content", "资料上传记录无效")

    def _prompt(self, key, value):
        if (not isinstance(value, dict) or value.get("updateId") != key
                or not isinstance(value.get("status"), str)
                or value["status"] not in {"pending", "update", "later"}
                or not isinstance(value.get("affectedUnitIds"), list)):
            raise StoreError("invalid_content", "资料更新提示无效")
        for identifier in value["affectedUnitIds"]:
            self.service._unit(identifier)

    @staticmethod
    def _tracking(key, value):
        if (key != "observed" or not isinstance(value, dict)
                or any(not isinstance(sid, str) or not isinstance(versions, list)
                       or any(not isinstance(vid, str) for vid in versions)
                       for sid, versions in value.items())):
            raise StoreError("invalid_content", "来源观察记录无效")

    @staticmethod
    def _decode(request):
        if not isinstance(request, dict):
            raise StoreError("invalid_parameter", "上传请求必须是对象")
        for field in ("operationId", "title", "name"):
            value = request.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > (200 if field == "operationId" else 1000):
                raise StoreError("invalid_parameter", f"上传缺少有效的 {field}")
        source = request.get("sourceId")
        if source is not None and (not isinstance(source, str) or not source.startswith("SRC-")):
            raise StoreError("invalid_parameter", "来源身份无效")
        extension = Path(request["name"]).suffix.lower()
        if extension not in {".pdf", ".md", ".txt"}:
            raise StoreError("invalid_parameter", "仅支持 PDF、Markdown 和 UTF-8 文本")
        encoded = request.get("contentBase64")
        if not isinstance(encoded, str) or not encoded:
            raise StoreError("invalid_parameter", "缺少 Base64 文件内容")
        if len(encoded) > MAX_BASE64:
            raise StoreError("invalid_parameter", "资料解码后不得超过 40 MiB")
        try:
            encoded_bytes = encoded.encode("ascii")
            content = base64.b64decode(encoded_bytes, validate=True)
        except (UnicodeError, binascii.Error, ValueError) as exc:
            raise StoreError("invalid_parameter", "文件 Base64 编码无效") from exc
        if not content or len(content) > MAX_BYTES:
            raise StoreError("invalid_parameter", "资料不能为空或超过 40 MiB")
        if extension != ".pdf":
            try:
                content.decode("utf-8")
            except UnicodeError as exc:
                raise StoreError("invalid_content", "文本资料必须使用 UTF-8") from exc
        affected = request.get("affectedUnitIds", [])
        if not isinstance(affected, list) or any(not isinstance(uid, str) for uid in affected):
            raise StoreError("invalid_parameter", "关联单元必须是身份数组")
        try:
            # Hash the exact request identity without materializing another 56 MiB JSON string.
            request_hash = entity_hash({**request, "contentBase64": hashlib.sha256(encoded_bytes).hexdigest()})
        except (TypeError, ValueError) as exc:
            raise StoreError("invalid_parameter", "上传请求必须是有效 JSON") from exc
        return content, extension, request_hash

    def _prior(self, operation_id, request_hash):
        with self.service.store._transaction() as db:
            row = db.execute("SELECT result_json FROM operations WHERE operation_id=?", (operation_id,)).fetchone()
        if row is None:
            return None
        receipt = json.loads(row[0])
        identity = next((c["value"] for c in receipt["changes"]
                         if c["namespace"] == "materialImports" and c["key"] == operation_id), None)
        if identity is None or identity["requestHash"] != request_hash:
            raise StoreError("invalid_parameter", "operationId 已用于其他请求")
        return self._receipt(receipt, identity)

    @staticmethod
    def _receipt(receipt, identity):
        return {**receipt, "knowledgeChanges": [c for c in receipt["changes"] if c["namespace"] == "knowledge"],
                **{k: identity[k] for k in ("sourceId", "versionId", "alreadyExists")}}

    @staticmethod
    def _page_count(path):
        try:
            result = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True,
                                    errors="replace", timeout=15, env={**os.environ, "LC_ALL": "C"})
        except (OSError, subprocess.SubprocessError) as exc:
            raise StoreError("source_unavailable", "无法使用 pdfinfo 核对 PDF 页数") from exc
        match = re.search(r"^Pages:\s+(\d+)\s*$", result.stdout, re.MULTILINE)
        if result.returncode or not match or int(match[1]) < 1:
            raise StoreError("invalid_content", "PDF 无效或没有可读取的页面")
        return int(match[1])

    def _directory(self):
        directory = self.service.root / ".review-board/materials"
        if not directory.resolve().is_relative_to(self.service.root):
            raise StoreError("invalid_parameter", "资料目录超出课程文件夹")
        directory.mkdir(parents=True, exist_ok=True)
        _sync_directory(directory.parent)
        return directory

    def _publish(self, content, extension, digest):
        """Publish a complete fsynced inode without ever replacing an existing one."""
        directory = self._directory()
        destination = directory / (digest + extension)
        temporary = None
        created = False
        try:
            with tempfile.NamedTemporaryFile(dir=directory, prefix=".upload-", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            pages = self._page_count(temporary) if extension == ".pdf" else 0
            try:
                os.link(temporary, destination)  # Atomic exclusive publication, unlike replace().
                created = True
            except FileExistsError:
                if destination.is_symlink() or hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
                    raise StoreError("save_failed", "同名资料资源与摘要不符，未覆盖原文件")
            _sync_directory(directory)
            return destination, created, pages
        except Exception:
            if created:
                destination.unlink(missing_ok=True)
            raise
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    @staticmethod
    def _references(value, source_id):
        if isinstance(value, dict):
            return value.get("sourceId") == source_id or any(
                MaterialImporter._references(v, source_id) for v in value.values())
        if isinstance(value, list):
            return any(MaterialImporter._references(v, source_id) for v in value)
        return False

    def _remove_unreferenced(self, path):
        # A failed acknowledgement can follow a durable commit or an unresolved
        # journal. Preserve the file whenever the authoritative JSON references it.
        try:
            relative = path.relative_to(self.service.root).as_posix()
            for source in self.service.catalog.store().sources.values():
                if source["path"] == relative or any(v["path"] == relative for v in source.get("versions", [])):
                    return
            path.unlink(missing_ok=True)
            _sync_directory(path.parent)
        except Exception:
            pass  # An uncertain recovery must never delete a potentially referenced asset.

    def add(self, request):
        content, extension, request_hash = self._decode(request)
        operation_id, supplied_id = request["operationId"], request.get("sourceId")
        digest = hashlib.sha256(content).hexdigest()
        content_commands = self.service.content
        with content_commands.writer_lock():
            prior = self._prior(operation_id, request_hash)
            if prior is not None:
                return prior
            for identifier in request.get("affectedUnitIds", []):
                self.service._unit(identifier)
            source_id = supplied_id or "SRC-USER-" + str(uuid.uuid4())
            original = content_commands.get(supplied_id) if supplied_id else None
            if original is not None and (original["deleted"] or not original["entity"]):
                raise StoreError("not_found", "找不到待追加版本的来源")
            source = deepcopy(original["entity"]) if original else None
            if source is not None and (source.get("type") == "course-note") != (extension != ".pdf"):
                raise StoreError("invalid_content", "文本与 PDF 来源类型不兼容，请创建独立来源")
            existing = next((v for v in (source or {}).get("versions", []) if v["sha256"] == digest), None)
            destination, created = None, False
            try:
                if existing:
                    version = deepcopy(existing)
                    path = (self.service.root / version["path"]).resolve()
                    if not path.is_relative_to(self.service.root) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                        raise StoreError("source_unavailable", "已保存资料版本资源缺失或摘要不符")
                else:
                    destination, created, pages = self._publish(content, extension, digest)
                    version = {"id": "VER-" + entity_hash([source_id, digest]), "sha256": digest,
                               "path": destination.relative_to(self.service.root).as_posix(),
                               "displayName": request["name"], "totalPages": pages}
                    if source is None:
                        source = {"id": source_id, "type": "supplementary" if extension == ".pdf" else "course-note",
                                  "title": request["title"], "path": version["path"], "totalPages": pages,
                                  "version": request["name"], "versions": []}
                    source.setdefault("versions", []).append(version)
                identity = {"operationId": operation_id, "requestHash": request_hash,
                            "sourceId": source_id, "versionId": version["id"], "alreadyExists": existing is not None}
                changes = [{"namespace": "materialImports", "key": operation_id, "value": identity}]
                expected = {f"materialImports:{operation_id}": 0,
                            f"knowledge:{source_id}": original["revision"] if original else 0}
                if not existing:
                    changes.insert(0, {"namespace": "knowledge", "key": source_id, "value": source})
                    sources = self.service.catalog.store().sources
                    affected = set(request.get("affectedUnitIds", []))
                    affected.update(uid for uid, unit in self.service.catalog.store().units.items()
                                    if self._references(unit, source_id))
                    prompt_id = "UPDATE-" + entity_hash([source_id, version["id"]])
                    prompt = {"updateId": prompt_id, "sourceId": source_id, "versionId": version["id"],
                              "displayName": version["displayName"], "status": "pending",
                              "affectedUnitIds": sorted(affected), "createdAt": datetime.now(timezone.utc).isoformat()}
                    # Restore keeps execution facts/prompts. Reimporting an old
                    # version must preserve the user's existing update/later choice.
                    previous_prompt = self.service.store.read("materialUpdates", prompt_id)
                    if previous_prompt["value"] is None:
                        changes.append({"namespace": "materialUpdates", "key": prompt_id, "value": prompt})
                        expected[f"materialUpdates:{prompt_id}"] = previous_prompt["revision"]
                    observed = self.service.store.read("sourceTracking", "observed")
                    tracking = deepcopy(observed["value"]) if observed["value"] is not None else {
                        sid: [v["id"] for v in src.get("versions", [])] for sid, src in sources.items()}
                    # Only this version is covered by our atomic prompt. Older
                    # unobserved imports must remain discoverable by the runtime.
                    tracked = tracking.setdefault(source_id, [])
                    if version["id"] not in tracked:
                        tracked.append(version["id"])
                    changes.append({"namespace": "sourceTracking", "key": "observed", "value": tracking})
                    expected["sourceTracking:observed"] = observed["revision"]
                command = {"operationId": operation_id, "actor": "import",
                           "kind": "source.version" if supplied_id else "source.add",
                           "generation": self.service.store.snapshot()["generation"],
                           "changes": changes, "expectedRevisions": expected}
                if original:
                    command["expectedHashes"] = {f"knowledge:{source_id}": original["hash"]}
                return self._receipt(content_commands.apply(command), identity)
            except Exception as exc:
                # An after-COMMIT fault is a saved import, even if apply raised.
                prior = self._prior(operation_id, request_hash)
                if prior is not None:
                    return prior
                if created:
                    self._remove_unreferenced(destination)
                if isinstance(exc, OSError):
                    raise StoreError("save_failed", "资料保存失败", {"reason": str(exc)}) from exc
                raise
