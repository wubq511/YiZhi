#!/usr/bin/env python3
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile


class ContentError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def entity_hash(value):
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


COURSE_ROOT = Path(__file__).resolve().parents[2]


def _check_version_file(course_root, version):
    if not isinstance(version, dict):
        raise ContentError("invalid_content", "资料版本必须是对象")
    required = {"id", "sha256", "path", "displayName", "totalPages"}
    if set(version) != required or not _present(version["id"]) or not version["id"].startswith("VER-"):
        raise ContentError("invalid_content", "资料版本字段或 ID 无效")
    if not _present(version["sha256"]) or len(version["sha256"]) != 64:
        raise ContentError("invalid_content", "资料版本 SHA-256 无效")
    if not _present(version["path"]) or not _present(version["displayName"]):
        raise ContentError("invalid_content", "资料版本路径或显示名为空")
    if type(version["totalPages"]) is not int or version["totalPages"] < 0:
        raise ContentError("invalid_content", "资料版本页数无效")
    path = (course_root / version["path"]).resolve()
    if not path.is_relative_to(course_root):
        raise ContentError("invalid_parameter", "资料版本路径超出课程文件夹")
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise ContentError("source_unavailable", "资料版本资源缺失",
                           {"path": version["path"]}) from exc
    if digest != version["sha256"]:
        raise ContentError("invalid_content", "资料版本声明摘要与实际文件不符",
                           {"versionId": version["id"]})


def _apply_source_proposals(candidate, proposals, course_root):
    if not isinstance(proposals, list):
        raise ContentError("invalid_content", "sourceProposals 必须是数组")
    sources = {item["id"]: item for item in candidate["sources"]}
    versions = {(source["id"], version["id"]): version
                for source in candidate["sources"] for version in source.get("versions", [])}
    for proposal in proposals:
        if not isinstance(proposal, dict) or set(proposal) != {"source", "version"}:
            raise ContentError("invalid_content", "来源提案必须包含 source 和 version")
        source_patch, version = proposal["source"], proposal["version"]
        if not isinstance(source_patch, dict):
            raise ContentError("invalid_content", "来源元数据必须是对象")
        required = {"id", "type", "title", "path", "totalPages", "version"}
        if set(source_patch) != required or any(not _present(source_patch[key]) for key in ("id", "type", "title", "path", "version")):
            raise ContentError("invalid_content", "来源元数据字段无效")
        if type(source_patch["totalPages"]) is not int or source_patch["totalPages"] < 0:
            raise ContentError("invalid_content", "来源页数无效")
        _check_version_file(course_root, version)
        source_id = source_patch["id"]
        existing = sources.get(source_id)
        owner = next((key for key in versions if key[1] == version["id"]), None)
        if owner is not None:
            if owner[0] != source_id or versions[owner] != version:
                raise ContentError("revision_conflict", f"资料版本 ID 冲突：{version['id']}")
            continue
        if existing is not None:
            for key, value in source_patch.items():
                if existing.get(key) != value:
                    raise ContentError("revision_conflict", f"来源元数据不能覆盖：{source_id}.{key}")
            existing.setdefault("versions", []).append(copy.deepcopy(version))
        else:
            if source_patch["path"] != version["path"]:
                raise ContentError("invalid_content", "新来源的当前路径必须指向首个版本")
            source = copy.deepcopy(source_patch)
            source["versions"] = [copy.deepcopy(version)]
            candidate["sources"].append(source)
            sources[source_id] = source
        versions[(source_id, version["id"])] = version


def _asset_path(relative, root):
    """Resolve a portable course/package-relative path, without traversal."""
    if (not _present(relative) or "\\" in relative or "\0" in relative
            or ":" in relative.split("/")[0]
            or any(part in {"", ".", ".."} for part in relative.split("/"))):
        raise ContentError("invalid_parameter", "资源必须使用合法相对路径", {"path": relative})
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ContentError("invalid_parameter", "资源路径超出允许范围", {"path": relative})
    return path


def _prepare_assets(package, package_root, course_root):
    if not isinstance(package["assets"], list):
        raise ContentError("invalid_content", "assets 必须是数组")
    actions = []
    targets = {}
    for asset in package["assets"]:
        if not isinstance(asset, dict) or set(asset) != {"path", "target", "sha256"}:
            raise ContentError("invalid_content", "资源提案字段无效")
        source = _asset_path(asset["path"], package_root)
        target = _asset_path(asset["target"], course_root)
        prefix = f"期中/资源/{package['packageId']}/"
        if not asset["target"].startswith(prefix):
            raise ContentError("invalid_content", "资源必须放在本包命名空间", {"target": asset["target"]})
        if not isinstance(asset["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", asset["sha256"]):
            raise ContentError("invalid_content", "资源 SHA-256 无效", {"target": asset["target"]})
        try:
            payload = source.read_bytes()
        except OSError as exc:
            raise ContentError("source_unavailable", "资源提案文件缺失",
                               {"path": asset["path"]}) from exc
        digest = hashlib.sha256(payload).hexdigest()
        if digest != asset["sha256"]:
            raise ContentError("invalid_content", "资源声明摘要与实际文件不符")
        if target in targets:
            if targets[target] != digest:
                raise ContentError("revision_conflict", "同一资源目标有不同内容", {"target": asset["target"]})
            continue
        targets[target] = digest
        if target.exists():
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ContentError("revision_conflict", "目标资源已存在且内容不同",
                                   {"target": asset["target"]})
            continue
        actions.append((payload, target))
    return actions


def validate_figure_assets(data, course_root, pending_assets=()):
    """Check reading resources at the I/O boundary; schema validation stays pure.

    pending_assets may contain only destinations returned by _prepare_assets:
    a manifest alone cannot authorize a missing file. Source-page URLs refer to
    versioned PDFs, whose rendered PNG need not have been cached yet.
    """
    course_root = Path(course_root).resolve()
    pending = set(pending_assets)
    sources = {source["id"]: source for source in data.get("sources", [])}

    def visit(unit_id, blocks):
        if not isinstance(blocks, list):
            return  # The schema validator reports malformed containers.
        for block in blocks:
            if not isinstance(block, dict):
                continue
            payload = block.get("payload", {})
            if block.get("kind") == "figure" and isinstance(payload, dict) and "asset" in payload:
                asset = payload["asset"]
                details = {"unitId": unit_id, "blockId": block.get("id"), "asset": asset}
                page = (re.fullmatch(r"/source-pages/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)/([0-9]+)\.png", asset)
                        if isinstance(asset, str) else None)
                if page:
                    source = sources.get(page[1], {})
                    version = next((v for v in source.get("versions", []) if v["id"] == page[2]), None)
                    if version is None or source.get("type") == "course-note":
                        raise ContentError("source_unavailable", "原页图来源或版本无效", details)
                    if not 1 <= int(page[3]) <= version.get("totalPages", source.get("totalPages", 0)):
                        raise ContentError("invalid_content", "原页图页码越界", details)
                    path = _asset_path(version["path"], course_root)
                else:
                    path = _asset_path(asset, course_root)
                    if not asset.startswith("期中/资源/"):
                        raise ContentError("invalid_content", "正文图片必须位于期中/资源或使用版本化原页图", details)
                if path not in pending and not path.is_file():
                    raise ContentError("source_unavailable", "正文图片资源缺失或不是文件", details)
            visit(unit_id, block.get("children", []))

    for unit in data.get("units", []):
        reading = unit.get("reading")
        if isinstance(reading, dict):
            visit(unit["id"], reading.get("blocks", []))


def apply_package(data, package, course_root=None, *, package_root=None):
    course_root = Path(course_root).resolve() if course_root is not None else COURSE_ROOT
    if package.get("schemaVersion") != "review-content-package-1":
        raise ContentError("invalid_content", "内容包版本必须为 review-content-package-1")
    if package.get("ticketId") != "02" or not package.get("packageId"):
        raise ContentError("invalid_content", "内容包必须属于 #02 并具有稳定 packageId")
    for field in ("baseSourceHash", "baseEntityHashes", "unitIds", "units",
                  "questionUpdates", "sourceProposals", "assets", "evidence"):
        if field not in package:
            raise ContentError("invalid_content", f"内容包缺少字段：{field}")
    unit_ids = package["unitIds"]
    proposals = package["units"]
    question_updates = package["questionUpdates"]
    if not isinstance(unit_ids, list) or not unit_ids or len(unit_ids) != len(set(unit_ids)):
        raise ContentError("invalid_content", "内容包 unitIds 必须非空且不重复")
    if (not isinstance(proposals, list) or len(proposals) != len(unit_ids)
            or {x.get("unitId") for x in proposals} != set(unit_ids)):
        raise ContentError("invalid_content", "内容包 units 与 unitIds 不一致")
    if not isinstance(question_updates, list):
        raise ContentError("invalid_content", "questionUpdates 必须是数组")
    question_ids = [update.get("questionId") for update in question_updates]
    if len(question_ids) != len(set(question_ids)):
        raise ContentError("invalid_content", "同一内容包不能重复提议同一共享题目")
    candidate = copy.deepcopy(data)
    units = {item["id"]: item for item in candidate["units"]}
    questions = {item["id"]: item for item in candidate["questions"]}
    proposal_by_id = {proposal["unitId"]: proposal for proposal in proposals}
    for unit_id in unit_ids:
        if unit_id not in units:
            raise ContentError("not_found", f"内容包目标单元不存在：{unit_id}")
        reading = proposal_by_id[unit_id].get("reading")
        if not isinstance(reading, dict):
            raise ContentError("invalid_content", f"单元缺少 reading 提案：{unit_id}")
        if units[unit_id].get("reading") == reading:
            continue
        expected = package["baseEntityHashes"].get(unit_id)
        actual = entity_hash(units[unit_id])
        if expected != actual:
            raise ContentError("revision_conflict", f"目标单元已变化：{unit_id}",
                               {"unitId": unit_id, "expected": expected, "actual": actual})
    allowed_question_fields = {"stem", "solution", "answerNature"}
    for update in question_updates:
        if not isinstance(update, dict) or not set(update) <= allowed_question_fields | {"questionId"}:
            raise ContentError("invalid_content", "题目增补包含未声明字段")
        question_id = update.get("questionId")
        if question_id not in questions:
            raise ContentError("not_found", f"内容包目标题目不存在：{question_id}")
        fields = {key: value for key, value in update.items() if key != "questionId"}
        if not fields or any(not _present(value) for value in fields.values()):
            raise ContentError("invalid_content", f"题目增补为空或不是文本：{question_id}")
        if fields.get("answerNature") not in {None, "official-solution", "derived-solution"}:
            raise ContentError("invalid_content", f"正式题目答案性质非法：{question_id}")
        if all(questions[question_id].get(key) == value for key, value in fields.items()):
            continue
        expected = package["baseEntityHashes"].get(question_id)
        actual = entity_hash(questions[question_id])
        if expected != actual:
            raise ContentError("revision_conflict", f"共享题目已变化：{question_id}",
                               {"questionId": question_id, "expected": expected, "actual": actual})
    for unit_id in unit_ids:
        units[unit_id]["reading"] = copy.deepcopy(proposal_by_id[unit_id]["reading"])
    for update in question_updates:
        question = questions[update["questionId"]]
        for key, value in update.items():
            if key != "questionId":
                question[key] = copy.deepcopy(value)
    _apply_source_proposals(candidate, package["sourceProposals"], course_root)
    # Both CLI preflight and the unified writer verify the actual manifest bytes.
    # No missing path is exempted just because its name occurs in package.assets.
    if package.get("assets") and package_root is None:
        raise ContentError("invalid_parameter", "含资源的内容包需要 package_root 以核验资源与 SHA-256")
    actions = _prepare_assets(package, package_root, course_root)
    validate_figure_assets(candidate, course_root, (target for _, target in actions))
    return candidate


def import_package(map_path, package_path, course_root=None):
    course_root = Path(course_root).resolve() if course_root is not None else COURSE_ROOT
    try:
        data = json.loads(map_path.read_text(encoding="utf-8"))
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContentError("invalid_content", f"无法读取课程或内容包：{exc}") from exc
    candidate = apply_package(data, package, course_root, package_root=package_path.parent.resolve())
    import 知识地图
    try:
        store = 知识地图.Store(candidate, root=course_root)
        store.validate()
    except 知识地图.MapError as exc:
        raise ContentError("invalid_content", "内容包导入后课程校验失败", exc.details) from exc
    actions = _prepare_assets(package, package_path.parent.resolve(), course_root)
    if candidate == data and not actions:
        return {"status": "unchanged", "packageId": package["packageId"],
                "unitIds": package["unitIds"], "sourceHash": store.hash}
    temporary = None
    created = []
    try:
        for payload, target in actions:
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as handle:
                created.append(target)
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=map_path.parent,
                                        prefix=map_path.name + ".", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(candidate, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, map_path)
    except OSError as exc:
        if temporary and temporary.exists():
            temporary.unlink()
        for target in created:
            target.unlink(missing_ok=True)
        raise ContentError("save_failed", f"内容包写入失败：{exc}") from exc
    return {"status": "imported", "packageId": package["packageId"],
            "unitIds": package["unitIds"], "sourceHash": store.hash}


def _atomic_write_json(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                        prefix=path.name + ".", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        if temporary and temporary.exists():
            temporary.unlink()
        raise ContentError("save_failed", f"课程数据写入失败：{exc}") from exc


def pin_sources(map_path):
    try:
        data = json.loads(map_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContentError("invalid_content", f"无法读取课程：{exc}") from exc
    candidate = copy.deepcopy(data)
    root = Path(__file__).resolve().parents[2]
    versions = {}
    for source in candidate["sources"]:
        if not source.get("versions"):
            path = root / source["path"]
            try:
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
            except OSError as exc:
                raise ContentError("source_unavailable", f"无法固定资料版本：{source['id']}",
                                   {"path": source["path"], "reason": str(exc)}) from exc
            version_id = f"VER-{source['id']}-{digest[:12]}"
            source["versions"] = [{
                "id": version_id, "sha256": digest, "path": source["path"],
                "displayName": source.get("version", source["title"]),
                "totalPages": source["totalPages"],
            }]
        versions[source["id"]] = source["versions"][0]["id"]

    def pin(node):
        if isinstance(node, dict):
            source_id = node.get("sourceId")
            if source_id in versions and not node.get("versionId") and any(
                    key in node for key in ("pdfPages", "bookPages", "page", "section")):
                node["versionId"] = versions[source_id]
            for value in node.values():
                pin(value)
        elif isinstance(node, list):
            for value in node:
                pin(value)

    pin(candidate)
    if candidate == data:
        return {"status": "unchanged", "sourceCount": len(versions)}
    _atomic_write_json(map_path, candidate)
    return {"status": "pinned", "sourceCount": len(versions)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="复习正文内容包校验与导入")
    sub = parser.add_subparsers(dest="command", required=True)
    import_parser = sub.add_parser("import")
    import_parser.add_argument("--map", type=Path, required=True)
    import_parser.add_argument("--package", type=Path, required=True)
    import_parser.add_argument("--course-root", type=Path, default=COURSE_ROOT)
    pin_parser = sub.add_parser("pin-sources")
    pin_parser.add_argument("--map", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "import":
            result = import_package(args.map, args.package, args.course_root)
        else:
            result = pin_sources(args.map)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ContentError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": exc.message,
                                    "details": exc.details}}, ensure_ascii=False, indent=2))
        return 1


BLOCK_KINDS = {
    "paragraph", "formula", "figure", "table", "steps", "callout",
    "knowledge-reference", "example", "exercise", "interactive",
}
BLOCK_ROLES = {"core", "material", "supplement"}
ANSWER_NATURES = {"official-solution", "derived-solution", "self-test", "authored-example"}
CONTAINER_KINDS = {"steps", "callout", "example", "exercise", "interactive"}
MATERIAL_KINDS = {"figure", "method", "derivation", "example", "exercise", "interactive"}


def _present(value):
    return isinstance(value, str) and bool(value.strip())


def _source_refs(refs, sources, label, errors):
    if not isinstance(refs, list):
        errors.append(f"{label} sourceRefs 必须是数组")
        return
    for ref in refs:
        if not isinstance(ref, dict):
            errors.append(f"{label} 来源引用必须是对象")
            continue
        source = sources.get(ref.get("sourceId"))
        if source is None:
            errors.append(f"{label} 来源悬空：{ref.get('sourceId')}")
            continue
        version_id = ref.get("versionId")
        version = next((item for item in source.get("versions", []) if item["id"] == version_id), None)
        if not _present(version_id):
            errors.append(f"{label} 缺少资料版本 ID：{source['id']}")
        elif version is None:
            errors.append(f"{label} 版本不匹配：{source['id']}:{version_id}")
        if ref.get("visualStatus") == "unverified":
            errors.append(f"{label} 存在未核实来源")
        if source.get("type") == "course-note":
            if not _present(ref.get("section")):
                errors.append(f"{label} 课程笔记缺少真实小节")
            continue
        pages = ref.get("pdfPages")
        if not isinstance(pages, list) or not pages:
            errors.append(f"{label} 缺少 PDF 页码")
            continue
        page_count = version.get("totalPages", source["totalPages"]) if version else source["totalPages"]
        for page in pages:
            if type(page) is not int or not 1 <= page <= page_count:
                errors.append(f"{label} 页码越界：{source['id']}:{page}")
        if source.get("type") == "textbook":
            book_pages = ref.get("bookPages")
            if not isinstance(book_pages, list) or len(book_pages) != len(pages):
                errors.append(f"{label} 教材必须同时记录中文书页和 PDF 页序")
            elif any(type(page) is not int for page in book_pages):
                errors.append(f"{label} 教材中文书页必须是整数")


def validate_reading(data, errors):
    sources = {item["id"]: item for item in data.get("sources", [])}
    units = {item["id"]: item for item in data.get("units", [])}
    questions = {item["id"]: item for item in data.get("questions", [])}
    blocks_by_id = {}
    block_unit = {}

    def visit(unit_id, block):
        label = f"单元 {unit_id} 的正文块"
        if not isinstance(block, dict):
            errors.append(f"{label} 必须是对象")
            return
        identifier = block.get("id")
        if not _present(identifier) or not identifier.startswith("RB-"):
            errors.append(f"{label} 缺少稳定 ID")
        elif identifier in blocks_by_id:
            errors.append(f"正文块 ID 重复：{identifier}")
        else:
            blocks_by_id[identifier] = block
            block_unit[identifier] = unit_id
        label = f"单元 {unit_id} 正文块 {identifier or '<无ID>'}"
        kind = block.get("kind")
        if kind not in BLOCK_KINDS:
            errors.append(f"{label} 类型非法：{kind}")
        if block.get("role") not in BLOCK_ROLES:
            errors.append(f"{label} role 非法：{block.get('role')}")
        payload = block.get("payload")
        if not isinstance(payload, dict):
            errors.append(f"{label} 缺少 payload 对象")
            payload = {}
        _source_refs(block.get("sourceRefs"), sources, label, errors)
        children = block.get("children", [])
        if not isinstance(children, list):
            errors.append(f"{label} children 必须是数组")
            children = []
        if children and kind not in CONTAINER_KINDS:
            errors.append(f"{label} 不能包含子块")
        for child in children:
            visit(unit_id, child)

        if kind == "paragraph" and not _present(payload.get("text")):
            errors.append(f"{label} 缺少正文文本")
        elif kind == "formula" and not _present(payload.get("latex")):
            errors.append(f"{label} 缺少可编辑 LaTeX")
        elif kind == "figure":
            if not _present(payload.get("alt")):
                errors.append(f"{label} 缺少图示说明")
            if not _present(payload.get("asset")) and not isinstance(payload.get("config"), dict):
                errors.append(f"{label} 缺少本地资源或语义配置")
        elif kind == "table":
            columns = payload.get("columns")
            rows = payload.get("rows")
            if not isinstance(columns, list) or not columns or any(not _present(x) for x in columns):
                errors.append(f"{label} 表头无效")
            if not isinstance(rows, list) or not rows:
                errors.append(f"{label} 表格内容为空")
            elif isinstance(columns, list):
                for row in rows:
                    if not isinstance(row, list) or len(row) != len(columns):
                        errors.append(f"{label} 表格行列不一致")
                        break
                    if any(not isinstance(cell, (str, int, float, dict)) for cell in row):
                        errors.append(f"{label} 表格单元格无效")
                        break
        elif kind == "steps":
            items = payload.get("items")
            if not isinstance(items, list) or not items or any(not _present(x) for x in items):
                errors.append(f"{label} 缺少有序步骤")
        elif kind == "callout" and not _present(payload.get("text")):
            errors.append(f"{label} 缺少提醒文本")
        elif kind == "knowledge-reference":
            target = payload.get("targetUnitId")
            if target not in units:
                errors.append(f"{label} 知识引用悬空：{target}")
            elif target == unit_id:
                errors.append(f"{label} 不能引用自身")
            if not _present(payload.get("intent")):
                errors.append(f"{label} 缺少引用定位意图")
        elif kind in {"example", "exercise"}:
            if not _present(payload.get("title")):
                errors.append(f"{label} 缺少标题")
            question_id = payload.get("questionId")
            question = questions.get(question_id) if question_id else None
            if question_id and question is None:
                errors.append(f"{label} 正式题目悬空：{question_id}")
            if not question_id and not _present(payload.get("problem")):
                errors.append(f"{label} 缺少题干")
            if "hint" in payload and not isinstance(payload["hint"], str):
                errors.append(f"{label} 提示必须是文本")
            nature = payload.get("answerNature")
            if nature not in ANSWER_NATURES:
                errors.append(f"{label} 答案性质非法：{nature}")
            if nature == "self-test" and question_id:
                errors.append(f"{label} 编制自测不能冒充正式题号")
            if nature == "official-solution" and question and not question.get("hasOfficialAnswer"):
                errors.append(f"{label} 没有官方答案依据")
            if question_id:
                if not _present(question.get("stem")):
                    errors.append(f"{label} 正式题目缺少共享题干：{question_id}")
                if not children and not _present(question.get("solution")):
                    errors.append(f"{label} 正式题目缺少完整解答：{question_id}")
            elif not children:
                errors.append(f"{label} 缺少完整解法或答案")
        elif kind == "interactive":
            if payload.get("component") not in {"mux", "decoder", "kmap"}:
                errors.append(f"{label} 交互组件尚未支持")
            if not isinstance(payload.get("config"), dict) or not isinstance(payload.get("inputs"), dict):
                errors.append(f"{label} 缺少语义配置或输入初值")

    for unit in data.get("units", []):
        reading = unit.get("reading")
        if reading is None:
            continue
        label = f"单元 {unit['id']} reading"
        if not isinstance(reading, dict):
            errors.append(f"{label} 必须是对象")
            continue
        if reading.get("schemaVersion") != "review-reading-1":
            errors.append(f"{label} schemaVersion 必须为 review-reading-1")
        if type(reading.get("revision")) is not int or reading["revision"] < 1:
            errors.append(f"{label} revision 必须是正整数")
        status = reading.get("status")
        if status not in {"draft", "complete"}:
            errors.append(f"{label} status 非法")
        blocks = reading.get("blocks")
        if not isinstance(blocks, list):
            errors.append(f"{label} blocks 必须是数组")
            blocks = []
        for block in blocks:
            visit(unit["id"], block)
        coverage = reading.get("coverage")
        if not isinstance(coverage, list):
            errors.append(f"{label} coverage 必须是数组")
            coverage = []
        if status == "complete" and (not blocks or not coverage):
            errors.append(f"单元 {unit['id']} 标为 complete 但正文或掌握目标覆盖为空")
        for item in coverage:
            if not isinstance(item, dict):
                errors.append(f"单元 {unit['id']} coverage 项必须是对象")
                continue
            if not _present(item.get("goal")):
                errors.append(f"单元 {unit['id']} coverage 缺少掌握目标")
            core_ids = item.get("coreBlockIds")
            if status == "complete" and (not isinstance(core_ids, list) or not core_ids):
                errors.append(f"单元 {unit['id']} complete 覆盖缺少核心块")
                core_ids = []
            if not isinstance(core_ids, list):
                errors.append(f"单元 {unit['id']} coreBlockIds 必须是数组")
                core_ids = []
            for block_id in core_ids:
                if block_unit.get(block_id) != unit["id"]:
                    errors.append(f"单元 {unit['id']} coverage 引用了非本单元核心块：{block_id}")
                elif blocks_by_id[block_id].get("role") != "core":
                    errors.append(f"单元 {unit['id']} 核心覆盖指向非 core 块：{block_id}")
            materials = item.get("materials", [])
            if not isinstance(materials, list):
                errors.append(f"单元 {unit['id']} materials 必须是数组")
                materials = []
            for material in materials:
                if not isinstance(material, dict) or material.get("kind") not in MATERIAL_KINDS:
                    errors.append(f"单元 {unit['id']} 材料覆盖类型非法")
                    continue
                material_status = material.get("status")
                material_ids = material.get("blockIds", [])
                if material_status == "verified":
                    if not isinstance(material_ids, list) or not material_ids:
                        errors.append(f"单元 {unit['id']} 已核实材料没有正文块")
                    else:
                        for block_id in material_ids:
                            if block_unit.get(block_id) != unit["id"]:
                                errors.append(f"单元 {unit['id']} 材料覆盖指向错误块：{block_id}")
                elif material_status == "not-applicable":
                    if not _present(material.get("reason")):
                        errors.append(f"单元 {unit['id']} 不适用材料缺少理由")
                else:
                    errors.append(f"单元 {unit['id']} 材料核对状态非法")
            _source_refs(item.get("sourceRefs", []), sources,
                         f"单元 {unit['id']} coverage", errors)
            if status == "complete":
                if not item.get("sourceRefs"):
                    errors.append(f"单元 {unit['id']} complete 覆盖缺少来源证据")
                if item.get("visualStatus") != "verified" or item.get("readingStatus") != "passed":
                    errors.append(f"单元 {unit['id']} complete 覆盖缺少原图或完整阅读核对")
                if not _present(item.get("note")):
                    errors.append(f"单元 {unit['id']} complete 覆盖缺少核对记录")


if __name__ == "__main__":
    raise SystemExit(main())
