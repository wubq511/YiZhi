"""Import #02 proposals through the course's existing command/history boundary.

HTTP integration (registered by the host, not this module)::

    import_content_package(service, request['packagePath'],
                           course_id=request.get('courseId'))

At service boot call register_imports(service), including after reopen, so
selective undo recognizes the lightweight receipt metadata namespace.

#02 handoff, from the project root::

    python3 legacy/review-board/import_content.py path/to/package.json

Relative HTTP package paths are course-relative. Relative CLI paths are resolved
against its working directory before forwarding. The legacy 期中/工具/复习内容.py
import CLI does NOT acquire .content.lock: concurrent use of that old writer
still has the known lost-update race. This adapter does not claim to fix it.

Knowledge, shared questions, and source metadata are submitted as entity diffs
in ONE content.apply; no JSON file is independently rewritten here. Immutable
package assets are staged and fsynced first. A failed/interrupted import may
retain unreferenced immutable assets for retry; committed references cannot
point to a partially written asset. Current bodies never enter the receipt
metadata namespace. The host owns change notifications after this function
returns and releases writer_lock.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile

from .content_commands import entity_hash
from .storage import StoreError, _json


_RECEIPTS = "contentImports"
_IMPORT_COLLECTIONS = ("units", "questions", "sources")


def _receipt_validator(key, value):
    if (not isinstance(value, dict) or value.get("packageId") != key
            or not isinstance(value.get("packageHash"), str)
            or not isinstance(value.get("unitIds"), list)):
        raise StoreError("invalid_content", "内容包收据元数据无效")


def register_imports(service):
    """Register the receipt validator at boot too, so historical undo can reopen."""
    with service._command_lock:
        if _RECEIPTS not in service._validators:
            service.register_namespace(_RECEIPTS, _receipt_validator)


def _read_package(path):
    try:
        package = json.loads(path.read_text(encoding="utf-8"))
        _json(package)
    except (OSError, ValueError) as exc:
        raise StoreError("invalid_content", "无法读取内容包", {"path": str(path), "reason": str(exc)}) from exc
    if not isinstance(package, dict):
        raise StoreError("invalid_content", "内容包必须为 JSON 对象")
    identifier = package.get("packageId")
    if (not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 160
            or identifier in {".", ".."} or any(c in identifier for c in "/\\\0")
            or any(ord(c) < 32 for c in identifier)):
        raise StoreError("invalid_content", "内容包缺少合法的稳定 packageId")
    return package


def _fsync_directory(path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _stage_assets(module, package, package_root, course_root):
    """Use #02's path/hash checks; install new files atomically without replacing.

    This precedes apply_package, which checks source-version files on disk.
    Keeping already staged immutable files on failure makes retries safe even
    when content.apply raised after its SQLite COMMIT actually succeeded.
    """
    actions = module._prepare_assets(package, package_root, course_root)
    for payload, target in actions:
        missing = []
        directory = target.parent
        while not directory.exists():
            missing.append(directory)
            directory = directory.parent
        for directory in reversed(missing):
            directory.mkdir(exist_ok=True)
            _fsync_directory(directory.parent)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=target.parent, prefix=".import-", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                # Unlike replace(), link() cannot overwrite a preexisting file.
                os.link(temporary, target)
            except FileExistsError:
                if target.read_bytes() != payload:
                    raise StoreError("revision_conflict", "目标资源已被其他写入者改变", {"path": str(target)})
            temporary.unlink()
            temporary = None
            _fsync_directory(target.parent)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    # A retry may find a fully staged file whose directory fsync failed before
    # the previous command. Flush those paths too, even when actions is empty.
    directories = set()
    for asset in package["assets"]:
        directory = (course_root / asset["target"]).resolve().parent
        while directory.is_relative_to(course_root):
            directories.add(directory)
            if directory == course_root:
                break
            directory = directory.parent
    for directory in sorted(directories, key=lambda value: len(value.parts), reverse=True):
        _fsync_directory(directory)


def _result(content, result, package):
    return {**content._decorate(result), "packageId": package["packageId"],
            "unitIds": package["unitIds"],
            "status": "imported" if any(c["namespace"] == "knowledge" for c in result["changes"]) else "unchanged"}


def import_content_package(service, package_path, *, course_id=None):
    """Validate a fresh #02 proposal and atomically apply only its entity changes.

    Returns the normal saved receipt plus packageId/unitIds/status. An identical
    package ID + canonical payload retries the original commit, including after
    later edits or a generation restore. Reusing an ID with different content is
    invalid_parameter. Assets are relative to the selected package's directory.
    """
    if course_id is not None and course_id != service.manifest["courseId"]:
        raise StoreError("invalid_parameter", "导入请求不属于当前课程", {"courseId": course_id})
    if not isinstance(package_path, (str, Path)) or not str(package_path).strip():
        raise StoreError("invalid_parameter", "packagePath 必须是非空路径")
    path = Path(package_path).expanduser()
    path = (service.root / path).resolve() if not path.is_absolute() else path.resolve()
    package = _read_package(path)
    package_hash = entity_hash(package)
    operation_id = "OP-IMPORT-" + package["packageId"]
    content = service.content
    # Load the same version of #02 code as the catalog's knowledge module. This
    # avoids importing a second global module from a different temporary course.
    module = service.catalog.module.复习内容
    with content.writer_lock():
        content._recover()
        with service.store._transaction() as db:
            previous = db.execute("SELECT payload_json,result_json FROM operations WHERE operation_id=?",
                                  (operation_id,)).fetchone()
        if previous is not None:
            request, result = map(json.loads, previous)
            if (request.get("kind") != "knowledge.import" or request.get("packageHash") != package_hash):
                raise StoreError("invalid_parameter", "packageId 已用于不同内容包", {"packageId": package["packageId"]})
            return _result(content, result, package)
        data = content._sync()  # Fresh file + external-import revisions, under lock.
        try:
            # Reuse #02 semantics and asset checks; never call its file writer.
            _stage_assets(module, package, path.parent, service.root)
            candidate = module.apply_package(data, package, service.root, package_root=path.parent)
            content._validate(candidate)
        except module.ContentError as exc:
            raise StoreError(exc.code, str(exc), exc.details) from exc
        except OSError as exc:
            raise StoreError("save_failed", "内容包资源保存失败", {"reason": str(exc)}) from exc
        except (KeyError, TypeError, AttributeError, ValueError) as exc:
            raise StoreError("invalid_content", "内容包结构无效", {"reason": str(exc)}) from exc
        # apply_package is deliberately limited to these collections. Refuse a
        # future upstream change rather than silently losing unrepresented data.
        for field in data.keys() | candidate.keys():
            if field not in _IMPORT_COLLECTIONS and data.get(field) != candidate.get(field):
                raise StoreError("invalid_content", "内容包修改了未支持的顶层字段", {"field": field})
        snapshot = service.store.snapshot()
        documents = snapshot["documents"].get("knowledge", {})
        changes, expected, hashes = [], {}, {}
        for collection in _IMPORT_COLLECTIONS:
            before = {item["id"]: item for item in data[collection]}
            after = {item["id"]: item for item in candidate[collection]}
            if before.keys() - after.keys():
                raise StoreError("invalid_content", "内容包不允许删除正式实体", {"collection": collection})
            for identifier in sorted(after):
                old, new = before.get(identifier), after[identifier]
                if old == new:
                    continue
                token = "knowledge:" + identifier
                expected[token] = documents.get(identifier, {"revision": 0})["revision"]
                hashes[token] = entity_hash(old) if old is not None else None
                changes.append({"namespace": "knowledge", "key": identifier, "value": new})
        # Receipt metadata also makes already-identical/no-op imports durably
        # idempotent, without duplicating any current body or creating a DB.
        register_imports(service)
        receipt = {"packageId": package["packageId"], "packageHash": package_hash, "unitIds": package["unitIds"]}
        token = _RECEIPTS + ":" + package["packageId"]
        expected[token] = snapshot["documents"].get(_RECEIPTS, {}).get(package["packageId"], {"revision": 0})["revision"]
        changes.append({"namespace": _RECEIPTS, "key": package["packageId"], "value": receipt})
        result = content.apply({"operationId": operation_id, "actor": "import", "kind": "knowledge.import",
                                "generation": snapshot["generation"], "packageId": package["packageId"],
                                "packageHash": package_hash, "changes": changes,
                                "expectedRevisions": expected, "expectedHashes": hashes})
    return _result(content, result, package)
