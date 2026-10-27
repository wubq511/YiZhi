"""从期中知识地图 canonical 确定性生成 Markdown、离线 HTML 和画板图。"""

from __future__ import annotations

import copy
import hashlib
import html
import json
import math
import os
import re
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple
from urllib.parse import quote

__all__ = ["source_hash", "default_layout", "render_expected", "build"]

OUTPUT_PATHS = (
    "01-课件知识点.md",
    "02-题目知识点映射.md",
    "03-知识点地图.md",
    "知识地图.html",
    "数据/画板图.json",
)

_RELATION_NAMES = {
    "requires": "学习前置",
    "constructs": "构造 / 扩展",
    "improves": "优化 / 演进",
    "inverse": "互逆",
}
_KIND_NAMES = {"concept": "概念", "method": "方法", "module": "模块"}
_BASIS_NAMES = {
    "stem": "题干直接指向",
    "official-solution": "官方解答",
    "agent-analysis": "分析判定",
}


def source_hash(data: Mapping[str, Any]) -> str:
    """返回权威 JSON 语义的 SHA-256；不读取文件路径或运行环境。"""
    payload = json.dumps(
        data,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _json_text(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        indent=2,
        allow_nan=False,
    ) + "\n"


def _natural_key(value: Any) -> Tuple[Any, ...]:
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", str(value))
    )


def _sorted_ids(items: Iterable[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    return sorted(items, key=lambda item: _natural_key(item["id"]))


def _prepare(data: Mapping[str, Any]) -> Dict[str, Any]:
    retired = {item["id"] for item in data.get("retiredUnits", [])}
    units = _sorted_ids(
        unit for unit in data["units"] if unit["id"] not in retired and unit.get("status") != "retired"
    )
    unit_by_id = {unit["id"]: unit for unit in units}
    if len(unit_by_id) != len(units):
        raise ValueError("当前知识单元 ID 不唯一")

    themes = sorted(data["themes"], key=lambda item: (_natural_key(item["lessonId"]), _natural_key(item["id"])))
    theme_by_id = {theme["id"]: theme for theme in themes}
    sources = {source["id"]: source for source in data["sources"]}
    questions = _sorted_ids(data["questions"])
    question_by_id = {question["id"]: question for question in questions}
    mappings = sorted(data["mappings"], key=lambda item: _natural_key(item["id"]))

    relations = []
    for relation in _sorted_ids(data["relations"]):
        if relation.get("status") != "approved":
            continue
        endpoints = (relation["fromUnitId"], relation["toUnitId"])
        missing = [unit_id for unit_id in endpoints if unit_id not in unit_by_id]
        if missing:
            raise ValueError(f"{relation['id']} 引用了非当前单元: {', '.join(missing)}")
        relations.append(relation)
    relation_by_id = {relation["id"]: relation for relation in relations}

    units_by_theme = defaultdict(list)
    for unit in units:
        if unit["themeId"] not in theme_by_id:
            raise ValueError(f"{unit['id']} 引用了未知主题 {unit['themeId']}")
        units_by_theme[unit["themeId"]].append(unit)

    mappings_by_question = defaultdict(list)
    mappings_by_unit = defaultdict(list)
    for mapping in mappings:
        if mapping["unitId"] not in unit_by_id:
            raise ValueError(f"{mapping['id']} 引用了非当前单元 {mapping['unitId']}")
        if mapping["questionId"] not in question_by_id:
            raise ValueError(f"{mapping['id']} 引用了未知题目 {mapping['questionId']}")
        mappings_by_question[mapping["questionId"]].append(mapping)
        mappings_by_unit[mapping["unitId"]].append(mapping)

    return {
        "retired": retired,
        "units": units,
        "unit_by_id": unit_by_id,
        "units_by_theme": units_by_theme,
        "themes": themes,
        "theme_by_id": theme_by_id,
        "sources": sources,
        "questions": questions,
        "question_by_id": question_by_id,
        "mappings": mappings,
        "mappings_by_question": mappings_by_question,
        "mappings_by_unit": mappings_by_unit,
        "relations": relations,
        "relation_by_id": relation_by_id,
    }


def _visual_id(kind: str, semantic_id: str) -> str:
    suffix = re.sub(r"[^0-9A-Za-z_-]+", "-", semantic_id).strip("-")
    if not suffix:
        raise ValueError(f"无法为 {semantic_id!r} 创建视觉元素 ID")
    return f"VE-{kind}-{suffix}"


def default_layout(data: Mapping[str, Any]) -> Dict[str, Any]:
    """按课次分栏、主题分组生成共享布局；视觉 ID 使用独立 VE 命名空间。"""
    ctx = _prepare(data)
    groups = []
    nodes = []
    edges = []
    lesson_indexes = {}
    lesson_y = defaultdict(lambda: 80)
    group_width = 600
    node_width = 268
    node_height = 86

    for theme in ctx["themes"]:
        lesson_id = theme["lessonId"]
        if lesson_id not in lesson_indexes:
            lesson_indexes[lesson_id] = len(lesson_indexes)
        theme_units = ctx["units_by_theme"][theme["id"]]
        rows = max(1, (len(theme_units) + 1) // 2)
        group_height = 100 + 98 * rows
        x = 80 + lesson_indexes[lesson_id] * 700
        y = lesson_y[lesson_id]
        groups.append(
            {
                "themeId": theme["id"],
                "elementId": _visual_id("G", theme["id"]),
                "x": x,
                "y": y,
                "width": group_width,
                "height": group_height,
                "title": f"{theme['id']} · {theme['name']}",
            }
        )
        for index, unit in enumerate(theme_units):
            nodes.append(
                {
                    "elementId": _visual_id("N", unit["id"]),
                    "unitId": unit["id"],
                    "x": x + 24 + (index % 2) * 284,
                    "y": y + 88 + (index // 2) * 98,
                    "width": node_width,
                    "height": node_height,
                }
            )
        lesson_y[lesson_id] = y + group_height + 40

    for relation in ctx["relations"]:
        edges.append({"elementId": _visual_id("E", relation["id"]), "relationId": relation["id"]})

    layout = {"schemaVersion": "midterm-layout-1", "groups": groups, "nodes": nodes, "edges": edges}
    _validate_layout(ctx, layout)
    return layout


def _validate_layout(ctx: Mapping[str, Any], layout: Any) -> None:
    if not isinstance(layout, dict):
        raise ValueError("视图布局必须是 JSON object")
    semantic_ids = set(ctx["unit_by_id"]) | set(ctx["theme_by_id"]) | set(ctx["relation_by_id"])
    visual_ids = set()

    def check_element(item: Mapping[str, Any], fields: Sequence[str]) -> None:
        for field in fields:
            if field not in item:
                raise ValueError(f"布局元素缺少 {field}")
        element_id = item["elementId"]
        if not isinstance(element_id, str) or not element_id.strip():
            raise ValueError("布局包含空视觉元素 ID")
        if element_id in semantic_ids:
            raise ValueError(f"视觉元素 ID 与知识 ID 混用: {element_id}")
        if element_id in visual_ids:
            raise ValueError(f"视觉元素 ID 重复: {element_id}")
        visual_ids.add(element_id)

    groups = layout.get("groups")
    nodes = layout.get("nodes")
    edges = layout.get("edges")
    if not isinstance(groups, list) or not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("视图布局必须包含 groups、nodes、edges 数组")

    group_themes = set()
    for group in groups:
        check_element(group, ("themeId", "elementId", "x", "y", "width", "height", "title"))
        if group["themeId"] not in ctx["theme_by_id"] or group["themeId"] in group_themes:
            raise ValueError(f"布局主题引用无效或重复: {group['themeId']}")
        group_themes.add(group["themeId"])
        for field in ("x", "y", "width", "height"):
            value = group[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{group['elementId']} 的 {field} 不是有限数值")
        if group["width"] <= 0 or group["height"] <= 0 or not str(group["title"]).strip():
            raise ValueError(f"{group['elementId']} 的尺寸或标题无效")

    node_units = set()
    node_by_unit = {}
    for node in nodes:
        check_element(node, ("elementId", "unitId", "x", "y", "width", "height"))
        unit_id = node["unitId"]
        if unit_id not in ctx["unit_by_id"] or unit_id in node_units:
            raise ValueError(f"布局单元引用无效或重复: {unit_id}")
        node_units.add(unit_id)
        node_by_unit[unit_id] = node
        for field in ("x", "y", "width", "height"):
            value = node[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{node['elementId']} 的 {field} 不是有限数值")
        if node["width"] <= 0 or node["height"] <= 0:
            raise ValueError(f"{node['elementId']} 的尺寸无效")

    edge_relations = set()
    for edge in edges:
        check_element(edge, ("elementId", "relationId"))
        relation_id = edge["relationId"]
        if relation_id not in ctx["relation_by_id"] or relation_id in edge_relations:
            raise ValueError(f"布局关系引用无效或重复: {relation_id}")
        edge_relations.add(relation_id)

    missing_groups = set(ctx["theme_by_id"]) - group_themes
    missing_nodes = set(ctx["unit_by_id"]) - node_units
    missing_edges = set(ctx["relation_by_id"]) - edge_relations
    if missing_groups or missing_nodes or missing_edges:
        parts = []
        if missing_groups:
            parts.append("主题 " + ", ".join(sorted(missing_groups)))
        if missing_nodes:
            parts.append("单元 " + ", ".join(sorted(missing_nodes)))
        if missing_edges:
            parts.append("关系 " + ", ".join(sorted(missing_edges)))
        raise ValueError("现有布局缺少当前内容: " + "；".join(parts))

    for relation in ctx["relations"]:
        if relation["fromUnitId"] not in node_by_unit or relation["toUnitId"] not in node_by_unit:
            raise ValueError(f"{relation['id']} 缺少视觉端点")


def _md(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").replace("|", "\\|")


def _page_ranges(pages: Iterable[Any]) -> str:
    values = sorted({int(page) for page in pages})
    if not values:
        return "—"
    ranges = []
    start = previous = values[0]
    for page in values[1:] + [None]:
        if page is not None and page == previous + 1:
            previous = page
            continue
        ranges.append(str(start) if start == previous else f"{start}–{previous}")
        if page is not None:
            start = previous = page
    return "、".join(ranges)


def _source_href(source: Mapping[str, Any]) -> str:
    return "../" + quote(str(source["path"]), safe="/")


def _source_ref_md(ref: Mapping[str, Any], sources: Mapping[str, Any]) -> str:
    source = sources[ref["sourceId"]]
    label = f"{source['id']} · PDF P{_page_ranges(ref.get('pdfPages', []))}"
    if ref.get("bookPages"):
        label += f" · 书 P{_page_ranges(ref['bookPages'])}"
    result = f"[{_md(label)}]({_source_href(source)})"
    if ref.get("note"):
        result += f"：{_md(ref['note'])}"
    return result


def _source_refs_md(refs: Iterable[Mapping[str, Any]], sources: Mapping[str, Any]) -> str:
    return "<br>".join(_source_ref_md(ref, sources) for ref in refs) or "—"


def _stars(value: Any) -> str:
    stars = int(value)
    return f"{stars} 星（{'★' * stars}{'☆' * max(0, 5 - stars)}）"


def _unit_stats(units: Sequence[Mapping[str, Any]]) -> Tuple[str, str]:
    if not units:
        return "—", "无当前单元"
    distribution = Counter(int(unit["rating"]["stars"]) for unit in units)
    peak = f"{max(distribution)} 星"
    detail = "、".join(f"{stars} 星 {distribution[stars]} 个" for stars in sorted(distribution, reverse=True))
    return peak, detail


def _lesson_title(lesson_id: str, sources: Mapping[str, Any]) -> str:
    match = re.search(r"\d+", lesson_id)
    number = match.group(0) if match else lesson_id
    source = sources.get(f"SRC-C{number}")
    title = str(source["title"]) if source else ""
    title = re.sub(r"^\s*\d+\s*", "", title)
    return f"第 {number} 课" + (f"：{title}" if title else "")


def _render_lessons(data: Mapping[str, Any]) -> str:
    ctx = _prepare(data)
    lines = [
        "# 课件知识点",
        "",
        "> 本文件由 `数据/知识地图.json` 派生。主题评级是 A 层判断；单元峰值与分布仅由当前 B 层单元计算。",
        "",
    ]
    current_lesson = None
    for theme in ctx["themes"]:
        if theme["lessonId"] != current_lesson:
            current_lesson = theme["lessonId"]
            lines.extend([f"## {_lesson_title(current_lesson, ctx['sources'])}", ""])
        units = ctx["units_by_theme"][theme["id"]]
        peak, distribution = _unit_stats(units)
        lines.extend(
            [
                f"### {theme['id']} · {_md(theme['name'])}",
                "",
                f"- **主题评级**：{_stars(theme['rating']['stars'])}；{_md(theme['rating']['rationale'])}",
                f"- **核心学习表现**：{_md(theme['coreOutcome'])}",
                f"- **单元摘要**：共 {len(units)} 个；峰值 {peak}；分布 {distribution}。",
                f"- **主题来源**：{_source_refs_md(theme.get('sourceRefs', []), ctx['sources'])}",
                "",
                "| 单元 | 类型 | 评级 | 掌握目标 | 简要内容 | 来源 |",
                "| --- | --- | --- | --- | --- | --- |",
            ]
        )
        for unit in units:
            name = f"`{unit['id']}` {_md(unit['name'])}"
            lines.append(
                "| "
                + " | ".join(
                    (
                        name,
                        _KIND_NAMES.get(unit["kind"], _md(unit["kind"])),
                        _stars(unit["rating"]["stars"]),
                        _md(unit["outcome"]),
                        _md(unit["summary"]),
                        _source_refs_md(unit.get("sourceRefs", []), ctx["sources"]),
                    )
                )
                + " |"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _question_section(ctx: Mapping[str, Any], questions: Sequence[Mapping[str, Any]]) -> List[str]:
    lines = []
    questions_by_source = defaultdict(list)
    for question in questions:
        questions_by_source[question["sourceId"]].append(question)
    source_order = {source_id: index for index, source_id in enumerate(ctx["sources"])}
    for source_id in sorted(questions_by_source, key=lambda item: (source_order.get(item, 10**6), _natural_key(item))):
        source = ctx["sources"][source_id]
        lines.extend([f"### {source_id} · {_md(source['title'])}", ""])
        source_questions = sorted(questions_by_source[source_id], key=lambda item: (_natural_key(item["label"]), _natural_key(item["id"])))
        for question in source_questions:
            lines.extend([f"#### {_md(question['label'])}（`{question['id']}`）", ""])
            parent = ""
            if question.get("parentId"):
                parent_question = ctx["question_by_id"][question["parentId"]]
                parent = f"；父题 `{parent_question['id']}`（{_md(parent_question['label'])}）"
            answer = "有" if question["hasOfficialAnswer"] else "无"
            lines.append(f"- **任务**：{_md(question['taskSummary'])}")
            lines.append(
                f"- **题型**：{_md('、'.join(question.get('questionTypes', []))) or '—'}；"
                f"**官方答案**：{answer}{parent}。"
            )
            lines.append(f"- **来源**：{_source_refs_md(question.get('sourceRefs', []), ctx['sources'])}")
            for role, role_name in (("direct", "direct（直接考查）"), ("support", "support（前置支撑）")):
                role_mappings = [item for item in ctx["mappings_by_question"][question["id"]] if item["role"] == role]
                if not role_mappings:
                    continue
                lines.append(f"- **{role_name}**：")
                for mapping in role_mappings:
                    unit = ctx["unit_by_id"][mapping["unitId"]]
                    basis = _BASIS_NAMES.get(mapping["basis"], mapping["basis"])
                    detail = f"`{unit['id']}` {_md(unit['name'])}；依据 `{mapping['basis']}`（{_md(basis)}）"
                    if mapping.get("note"):
                        detail += f"；{_md(mapping['note'])}"
                    lines.append(f"  - {detail}。")
            lines.append("")
    return lines


def _render_questions(data: Mapping[str, Any]) -> str:
    ctx = _prepare(data)
    homework = [item for item in ctx["questions"] if item.get("kind") != "exercise-example"]
    exercise = [item for item in ctx["questions"] if item.get("kind") == "exercise-example"]
    direct_count = sum(item["role"] == "direct" for item in ctx["mappings"])
    support_count = sum(item["role"] == "support" for item in ctx["mappings"])
    lines = [
        "# 题目知识点映射",
        "",
        f"> 共 {len(ctx['questions'])} 题、{len(ctx['mappings'])} 条映射：direct {direct_count} 条，support {support_count} 条。参考条目独立列出，不混入题目映射计数。",
        "",
        "## 课后作业",
        "",
    ]
    lines.extend(_question_section(ctx, homework))
    lines.extend(["## 考前习题课", ""])
    lines.extend(_question_section(ctx, exercise))
    lines.extend(["## 参考条目（不计入题目映射）", ""])
    for item in sorted(data.get("referenceItems", []), key=lambda value: _natural_key(value["id"])):
        lines.extend([f"### {item['id']} · {_md(item['label'])}", ""])
        lines.append(f"- **类型**：`{_md(item['kind'])}`")
        related = [
            f"`{unit_id}` {_md(ctx['unit_by_id'][unit_id]['name'])}"
            for unit_id in item.get("relatedUnitIds", [])
            if unit_id in ctx["unit_by_id"]
        ]
        lines.append(f"- **相关单元**：{'；'.join(related) or '—'}")
        if item.get("note"):
            lines.append(f"- **说明**：{_md(item['note'])}")
        lines.append(f"- **来源**：{_source_refs_md(item.get('sourceRefs', []), ctx['sources'])}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _mermaid_label(unit: Mapping[str, Any]) -> str:
    name = html.escape(str(unit["name"]), quote=True).replace("\n", " ")
    return f"{unit['id']}<br/>{name}"


def _mermaid_lines(ctx: Mapping[str, Any], view: str) -> List[str]:
    relations = [relation for relation in ctx["relations"] if relation["view"] == view]
    unit_ids = sorted(
        {relation["fromUnitId"] for relation in relations} | {relation["toUnitId"] for relation in relations},
        key=_natural_key,
    )
    lines = ["```mermaid", "flowchart LR"]
    for unit_id in unit_ids:
        lines.append(f"  {unit_id.replace('-', '_')}[\"{_mermaid_label(ctx['unit_by_id'][unit_id])}\"]")
    for relation in relations:
        source = relation["fromUnitId"].replace("-", "_")
        target = relation["toUnitId"].replace("-", "_")
        if relation["type"] == "constructs":
            connector = "-.->" if relation["directed"] else "-.-"
        elif relation["type"] == "improves":
            connector = "==>" if relation["directed"] else "==="
        elif relation["type"] == "inverse":
            connector = "-.->" if relation["directed"] else "---"
        else:
            connector = "-->" if relation["directed"] else "---"
        label = relation["type"]
        if relation.get("requirementGroupId"):
            label += f"（{relation['requirementGroupId']} 任一）"
        lines.append(f"  {source} {connector}|\"{label}\"| {target}")
    lines.append("```")
    return lines


def _render_map(data: Mapping[str, Any]) -> str:
    ctx = _prepare(data)
    main_count = sum(relation["view"] == "main" for relation in ctx["relations"])
    auxiliary_count = sum(relation["view"] == "auxiliary" for relation in ctx["relations"])
    lines = [
        "# 知识点地图",
        "",
        f"> 仅展示 `status=approved` 且端点属于当前单元的关系：主视图 {main_count} 条，辅助视图 {auxiliary_count} 条，共 {len(ctx['relations'])} 条。退休单元不进入本文件。",
        "",
        "## 主题汇总",
        "",
        "| 课次 | 主题 | 核心学习表现 | 主题评级与理由 | 单元峰值 | 星级分布 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for theme in ctx["themes"]:
        units = ctx["units_by_theme"][theme["id"]]
        peak, distribution = _unit_stats(units)
        rating = f"{_stars(theme['rating']['stars'])}；{_md(theme['rating']['rationale'])}"
        lines.append(
            f"| {_md(theme['lessonId'])} | `{theme['id']}` {_md(theme['name'])} | {_md(theme['coreOutcome'])} | {rating} | {peak} | {distribution} |"
        )

    lines.extend(["", "## 前置路线组", ""])
    groups = sorted(data.get("requirementGroups", []), key=lambda item: _natural_key(item["id"]))
    if groups:
        lines.extend(
            [
                "未分组的 `requires` 入边分别必要；路线组与未分组前置之间按 AND 连接，组内严格按下表解释。",
                "",
                "| 路线组 | 目标 | 条件 | 可替代成员 | 依据与价值 |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for group in groups:
            mode = "任一（OR，不是 AND）" if group["mode"] == "any" else "全部（AND）"
            members = "；".join(
                f"`{unit_id}` {_md(ctx['unit_by_id'][unit_id]['name'])}" for unit_id in group["unitIds"]
            )
            evidence = f"{_md(group['value'])}<br>{_source_refs_md(group.get('sourceRefs', []), ctx['sources'])}"
            target = ctx["unit_by_id"][group["targetUnitId"]]
            lines.append(f"| `{group['id']}` | `{target['id']}` {_md(target['name'])} | **{mode}** | {members} | {evidence} |")
        lines.append("")
        if any(group["id"] == "G1" and group["mode"] == "any" for group in groups):
            lines.extend(["**G1 明确结论：`KU-033` 与 `KU-035` 任一即可，不要求两者同时掌握。**", ""])
    else:
        lines.extend(["当前没有路线组。", ""])

    lines.extend(
        [
            "## 已审核关系表",
            "",
            "| 关系 | 视图 | 类型 | 起点 → 终点 | 价值 / 路线 | 来源 |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
    )
    for relation in ctx["relations"]:
        source = ctx["unit_by_id"][relation["fromUnitId"]]
        target = ctx["unit_by_id"][relation["toUnitId"]]
        arrow = "→" if relation["directed"] else "—"
        endpoints = f"`{source['id']}` {_md(source['name'])} {arrow} `{target['id']}` {_md(target['name'])}"
        value = _md(relation["value"])
        extras = []
        if relation.get("route"):
            extras.append(f"路线：{_md(relation['route'])}")
        if relation.get("requirementGroupId"):
            extras.append(f"**{relation['requirementGroupId']}：组内任一（OR）**")
        if extras:
            value += "<br>" + "；".join(extras)
        relation_type = f"`{relation['type']}`（{_RELATION_NAMES.get(relation['type'], relation['type'])}）"
        lines.append(
            f"| `{relation['id']}` | `{relation['view']}` | {relation_type} | {endpoints} | {value} | {_source_refs_md(relation.get('sourceRefs', []), ctx['sources'])} |"
        )

    for view, title in (("main", "主视图"), ("auxiliary", "辅助视图")):
        lines.extend(
            [
                "",
                f"## Mermaid {title}",
                "",
                f"仅包含 `view={view}` 的已审核关系；带 G1 标记的两条入边是**任一**路线，不是 AND。",
                "",
            ]
        )
        lines.extend(_mermaid_lines(ctx, view))
    return "\n".join(lines).rstrip() + "\n"


def _make_board(data: Mapping[str, Any], layout: Mapping[str, Any]) -> Dict[str, Any]:
    ctx = _prepare(data)
    _validate_layout(ctx, layout)
    layout_groups = {group["themeId"]: group for group in layout["groups"]}
    layout_nodes = {node["unitId"]: node for node in layout["nodes"]}
    layout_edges = {edge["relationId"]: edge for edge in layout["edges"]}

    sources = [
        {
            "id": source["id"],
            "type": source["type"],
            "title": source["title"],
            "path": source["path"],
            "href": _source_href(source),
            "totalPages": source.get("totalPages"),
        }
        for source in data["sources"]
    ]
    groups = []
    for theme in ctx["themes"]:
        units = ctx["units_by_theme"][theme["id"]]
        peak, distribution = _unit_stats(units)
        groups.append(
            {
                "id": theme["id"],
                "themeId": theme["id"],
                "elementId": layout_groups[theme["id"]]["elementId"],
                "lessonId": theme["lessonId"],
                "name": theme["name"],
                "coreOutcome": theme["coreOutcome"],
                "sourceRefs": copy.deepcopy(theme.get("sourceRefs", [])),
                "rating": copy.deepcopy(theme["rating"]),
                "unitIds": [unit["id"] for unit in units],
                "unitPeak": peak,
                "ratingDistribution": distribution,
            }
        )

    nodes = []
    for unit in ctx["units"]:
        theme = ctx["theme_by_id"][unit["themeId"]]
        nodes.append(
            {
                "id": unit["id"],
                "unitId": unit["id"],
                "elementId": layout_nodes[unit["id"]]["elementId"],
                "themeId": unit["themeId"],
                "lessonId": theme["lessonId"],
                "kind": unit["kind"],
                "name": unit["name"],
                "aliases": copy.deepcopy(unit.get("aliases", [])),
                "outcome": unit["outcome"],
                "summary": unit["summary"],
                "internals": copy.deepcopy(unit.get("internals", [])),
                "questionTypes": list(unit.get("questionTypes", [])),
                "sourceRefs": copy.deepcopy(unit.get("sourceRefs", [])),
                "rating": copy.deepcopy(unit["rating"]),
            }
        )

    edges = []
    for relation in ctx["relations"]:
        edge = {
            "id": relation["id"],
            "relationId": relation["id"],
            "elementId": layout_edges[relation["id"]]["elementId"],
            "fromUnitId": relation["fromUnitId"],
            "toUnitId": relation["toUnitId"],
            "fromElementId": layout_nodes[relation["fromUnitId"]]["elementId"],
            "toElementId": layout_nodes[relation["toUnitId"]]["elementId"],
            "type": relation["type"],
            "directed": relation["directed"],
            "value": relation["value"],
            "sourceRefs": copy.deepcopy(relation.get("sourceRefs", [])),
            "view": relation["view"],
            "status": relation["status"],
        }
        for field in ("route", "requirementGroupId"):
            if field in relation:
                edge[field] = relation[field]
        edges.append(edge)

    aggregates = {}
    for relation in edges:
        from_theme = ctx["unit_by_id"][relation["fromUnitId"]]["themeId"]
        to_theme = ctx["unit_by_id"][relation["toUnitId"]]["themeId"]
        if from_theme == to_theme:
            continue
        key = (from_theme, to_theme, relation["type"], relation["directed"], relation["view"])
        if key not in aggregates:
            aggregates[key] = []
        aggregates[key].append(relation["id"])
    theme_edges = []
    for index, key in enumerate(sorted(aggregates, key=lambda value: tuple(_natural_key(part) for part in value)), 1):
        from_theme, to_theme, relation_type, directed, view = key
        relation_ids = sorted(aggregates[key], key=_natural_key)
        theme_edges.append(
            {
                "id": f"TE-{index:04d}",
                "fromThemeId": from_theme,
                "toThemeId": to_theme,
                "type": relation_type,
                "directed": directed,
                "view": view,
                "relationIds": relation_ids,
            }
        )

    views = {}
    for view in ("main", "auxiliary", "all"):
        view_edges = [edge for edge in edges if view == "all" or edge["view"] == view]
        views[view] = {
            "layoutRef": "layout",
            "nodeElementIds": [node["elementId"] for node in nodes],
            "edgeIds": [edge["id"] for edge in view_edges],
            "edgeElementIds": [edge["elementId"] for edge in view_edges],
        }

    return {
        "schemaVersion": "midterm-board-1",
        "sourceHash": source_hash(data),
        "course": copy.deepcopy(data.get("course", {})),
        "sources": sources,
        "groups": groups,
        "nodes": nodes,
        "edges": edges,
        "themeEdges": theme_edges,
        "requirementGroups": copy.deepcopy(data.get("requirementGroups", [])),
        "questions": copy.deepcopy(ctx["questions"]),
        "mappings": copy.deepcopy(ctx["mappings"]),
        "referenceItems": copy.deepcopy(data.get("referenceItems", [])),
        "views": views,
        "layout": copy.deepcopy(layout),
    }


def _script_json(value: Any) -> str:
    return (
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def render_expected(data: Mapping[str, Any], layout_path: os.PathLike[str] | str) -> Dict[str, str]:
    """在内存中返回五个固定相对路径的派生内容，不写任何文件。"""
    layout = json.loads(Path(layout_path).read_text(encoding="utf-8"))
    board = _make_board(data, layout)
    template = _HTML_TEMPLATE.replace("__MAP_DATA__", _script_json(board))
    template = template.replace("__SOURCE_HASH__", board["sourceHash"])
    return {
        "01-课件知识点.md": _render_lessons(data),
        "02-题目知识点映射.md": _render_questions(data),
        "03-知识点地图.md": _render_map(data),
        "知识地图.html": template,
        "数据/画板图.json": _json_text(board),
    }


def build(data: Mapping[str, Any], output_dir: os.PathLike[str] | str, layout_path: os.PathLike[str] | str) -> Dict[str, Any]:
    """保留现有布局，原子写出全部派生产物并返回稳定构建摘要。"""
    destination = Path(output_dir)
    layout_file = Path(layout_path)
    if layout_file.exists():
        layout = json.loads(layout_file.read_text(encoding="utf-8"))
    else:
        layout = default_layout(data)
        _atomic_write(layout_file, _json_text(layout))
    expected = render_expected(data, layout_file)
    for relative_path in OUTPUT_PATHS:
        _atomic_write(destination / Path(relative_path), expected[relative_path])
    return {"sourceHash": source_hash(data), "outputs": list(OUTPUT_PATHS), "layout": layout}


_HTML_TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>数字逻辑期中知识地图</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#eef2f7;font-size:15px;line-height:1.55}
*{box-sizing:border-box}
body{margin:0;min-width:320px}
button,input,select{font:inherit}
button,select,input{border:1px solid #b7c2d0;border-radius:7px;background:#fff;color:#172033;min-height:38px}
button{cursor:pointer;padding:.4rem .75rem;font-weight:600}
button:hover{background:#edf4ff;border-color:#527bad}
button:focus-visible,input:focus-visible,select:focus-visible,svg [tabindex]:focus-visible,#canvas:focus-visible{outline:3px solid #0969da;outline-offset:2px}
header{padding:1rem 1.25rem .7rem;background:#fff;border-bottom:1px solid #d6dee8}
h1{font-size:1.35rem;margin:0 0 .25rem}
header p{margin:.15rem 0;color:#526075}
.hash{font-size:.75rem;overflow-wrap:anywhere;color:#657188}
.controls{display:flex;flex-wrap:wrap;gap:.55rem;align-items:end;padding:.75rem 1.25rem;background:#f8fafc;border-bottom:1px solid #d6dee8}
.control{display:flex;flex-direction:column;gap:.15rem;min-width:128px}
.control.grow{flex:1;min-width:180px;max-width:340px}
.control label,.control-label{font-size:.78rem;font-weight:650;color:#526075}
.control input,.control select{width:100%;padding:.35rem .5rem}
.button-group{display:flex;gap:.35rem}
.status{padding:.35rem 1.25rem;background:#f8fafc;color:#46546a;font-size:.85rem;display:flex;flex-wrap:wrap;gap:.5rem 1rem}
.legend{display:flex;flex-wrap:wrap;gap:.35rem .85rem;padding:.45rem 1.25rem;background:#fff;border-top:1px solid #e3e8ef;border-bottom:1px solid #d6dee8;font-size:.78rem;color:#526075}
.legend-line{display:inline-block;width:34px;margin-right:.25rem;vertical-align:middle;border-top:2px solid #64748b}
.legend-line.constructs{border-top-style:dashed}
.legend-line.improves{border-top-style:dotted;border-top-width:3px}
.legend-line.inverse{border-top:0;background:repeating-linear-gradient(90deg,#64748b 0 9px,transparent 9px 12px,#64748b 12px 14px,transparent 14px 18px);height:2px}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 370px;gap:0;min-height:0}
#viewport{position:relative;height:calc(100vh - 280px);min-height:480px;background:#e9eef5;overflow:hidden;border-right:1px solid #ccd6e2}
#canvas{display:block;width:100%;height:100%;touch-action:none;cursor:grab;background-image:radial-gradient(#c5cfdb 1px,transparent 1px);background-size:20px 20px}
#canvas:active{cursor:grabbing}
#details{background:#fff;padding:1rem 1.1rem 2rem;overflow:auto;height:calc(100vh - 280px);min-height:480px}
#details h2{font-size:1.15rem;line-height:1.35;margin:.1rem 0 .5rem;overflow-wrap:anywhere}
#details h3{font-size:.95rem;margin:1.1rem 0 .3rem;padding-bottom:.2rem;border-bottom:1px solid #e1e7ee}
#details p{margin:.35rem 0;overflow-wrap:anywhere}
#details ul{padding-left:1.25rem;margin:.3rem 0}
#details li{margin:.35rem 0;overflow-wrap:anywhere}
#details .meta{color:#58677b;font-size:.85rem}
#details .rating{color:#8a4b08;font-weight:650}
#details .evidence{background:#f6f8fb;border-left:3px solid #7895b7;padding:.45rem .6rem;margin:.5rem 0}
#details .sources{font-size:.84rem}
#details .source-item{margin:.35rem 0;overflow-wrap:anywhere}
#details a{color:#075ea8;text-decoration-thickness:1px;text-underline-offset:2px;overflow-wrap:anywhere}
#details .link-button{display:block;width:100%;text-align:left;margin:.3rem 0;font-weight:500;overflow-wrap:anywhere;height:auto;min-height:34px}
#details .empty{color:#68758a}
.group{cursor:pointer}
.group-bg{fill:#f8fafc;stroke:#a7b5c6;stroke-width:1.2}
.group:hover .group-bg,.group.selected .group-bg{stroke:#1769aa;stroke-width:2.5}
.group-title{font-weight:700;fill:#1c2b3f;font-size:16px}
.group-meta{fill:#5a697d;font-size:12px}
.node{cursor:pointer}
.node-bg{fill:#fff;stroke:#8293a8;stroke-width:1.2}
.node.stars-5 .node-bg{fill:#fff8e8;stroke:#a56a13}
.node.stars-4 .node-bg{fill:#fffdf5}
.node:hover .node-bg,.node.selected .node-bg{stroke:#0969da;stroke-width:3}
.node-id{font-size:11px;fill:#5c6b7f;font-weight:650}
.node-name{font-size:13px;fill:#172033;font-weight:650}
.edge{cursor:pointer}
.edge-line{fill:none;stroke:#64748b;stroke-width:1.8}
.edge-hit{fill:none;stroke:transparent;stroke-width:20;pointer-events:stroke}
.edge-constructs .edge-line{stroke-dasharray:9 5;stroke:#0f766e}
.edge-improves .edge-line{stroke-dasharray:2 5;stroke-width:2.5;stroke:#9a5b13}
.edge-inverse .edge-line{stroke-dasharray:12 4 2 4;stroke:#7c3f91}
.edge:hover .edge-line,.edge.selected .edge-line{stroke:#0969da;stroke-width:3.5}
.edge-label{font-size:10px;fill:#3e4c60;text-anchor:middle;paint-order:stroke;stroke:#eef2f7;stroke-width:4px;stroke-linejoin:round;pointer-events:auto;cursor:pointer;user-select:none}
.instructions{padding:.55rem 1.25rem;color:#5a687b;background:#f8fafc;font-size:.78rem;border-top:1px solid #d6dee8}
@media(max-width:900px){
  header{padding:.8rem}.controls{padding:.6rem .8rem;gap:.45rem}.control{min-width:calc(50% - .3rem);flex:1}.control.grow{max-width:none;min-width:100%}
  .status,.legend,.instructions{padding-left:.8rem;padding-right:.8rem}
  .workspace{grid-template-columns:1fr}#viewport{height:60vh;min-height:390px;border-right:0;border-bottom:1px solid #ccd6e2}
  #details{height:auto;min-height:250px;max-height:none;overflow:visible;padding:.85rem .9rem 2rem}
}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
</head>
<body>
<header>
  <h1>数字逻辑期中知识地图</h1>
  <p>只读、离线的课程知识与证据视图。主视图和辅助视图共用同一布局。</p>
  <div class="hash">权威数据 SHA-256：<code id="source-hash">__SOURCE_HASH__</code></div>
</header>
<div class="controls" role="search" aria-label="知识地图筛选与导航">
  <div class="control grow"><label for="search">名称、别名或单元 ID</label><input id="search" type="search" autocomplete="off" placeholder="例如：卡诺图"></div>
  <div class="control"><label for="lesson-filter">课次</label><select id="lesson-filter"><option value="">全部课次</option></select></div>
  <div class="control"><label for="theme-filter">主题</label><select id="theme-filter"><option value="">全部主题</option></select></div>
  <div class="control"><label for="rating-filter">星级</label><select id="rating-filter"><option value="">全部星级</option><option value="5">5 星</option><option value="4">4 星</option><option value="3">3 星</option><option value="2">2 星</option><option value="1">1 星</option></select></div>
  <div class="control"><label for="question-type-filter">题型</label><select id="question-type-filter"><option value="">全部题型</option></select></div>
  <div class="control"><label for="relation-view">关系视图</label><select id="relation-view"><option value="main">主视图 main</option><option value="auxiliary">辅助视图 auxiliary</option><option value="all">全部 all</option></select></div>
  <div class="control"><label for="theme-focus">主题聚焦</label><select id="theme-focus"><option value="">选择主题…</option></select></div>
  <div class="control"><span class="control-label">画布</span><div class="button-group"><button id="zoom-out" type="button" aria-label="缩小画布">−</button><button id="zoom-in" type="button" aria-label="放大画布">＋</button><button id="reset-view" type="button">复位</button></div></div>
  <button id="clear-filters" type="button">清除筛选</button>
</div>
<div class="status"><span id="result-count" role="status" aria-live="polite"></span><span>点击单元、主题分组或关系线查看证据</span></div>
<div class="legend" aria-label="关系线型图例">
  <span><span class="legend-line requires"></span>requires 学习前置（实线）</span>
  <span><span class="legend-line constructs"></span>constructs 构造（虚线）</span>
  <span><span class="legend-line improves"></span>improves 优化（点线）</span>
  <span><span class="legend-line inverse"></span>inverse 互逆（点划线）</span>
  <span><strong>G1：任一（OR）</strong>，不是 AND</span>
</div>
<main class="workspace">
  <section id="viewport" aria-label="可平移缩放的知识画布">
    <svg id="canvas" tabindex="0" role="group" aria-labelledby="canvas-title canvas-desc">
      <title id="canvas-title">数字逻辑知识关系画布</title>
      <desc id="canvas-desc">拖动或使用方向键平移，使用加减按钮缩放。单元、主题和关系均可通过 Tab 聚焦，按回车查看详情。</desc>
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"></path></marker></defs>
      <g id="scene"><g id="group-layer"></g><g id="edge-layer"></g><g id="node-layer"></g></g>
    </svg>
  </section>
  <aside id="details" aria-label="所选项目详情" aria-live="polite"><h2>选择一个项目</h2><p class="empty">点击单元查看评级理由、内部项、直接与支撑题目和来源；点击主题或关系线可查看对应证据。</p></aside>
</main>
<div class="instructions">操作：拖动平移，滚轮或按钮缩放；“复位”回到初始视口。画布聚焦后可用方向键平移、<kbd>+</kbd>/<kbd>−</kbd> 缩放、<kbd>0</kbd> 复位。所有筛选与详情按钮均可键盘操作。</div>
<script id="map-data" type="application/json">__MAP_DATA__</script>
<script>
"use strict";
const board=JSON.parse(document.getElementById("map-data").textContent);
const SVG_NS="http://www.w3.org/2000/svg";
const byId=(items,key)=>new Map(items.map(item=>[item[key],item]));
const unitById=byId(board.nodes,"unitId");
const themeById=byId(board.groups,"themeId");
const relationById=byId(board.edges,"relationId");
const sourceById=byId(board.sources,"id");
const questionById=byId(board.questions,"id");
const groupById=byId(board.requirementGroups,"id");
const layoutNodeByUnit=byId(board.layout.nodes,"unitId");
const layoutGroupByTheme=byId(board.layout.groups,"themeId");
const nodeElements=new Map();
const edgeElements=new Map();
const groupElements=new Map();
const mappingsByUnit=new Map(board.nodes.map(node=>[node.unitId,[]]));
board.mappings.forEach(mapping=>{if(mappingsByUnit.has(mapping.unitId))mappingsByUnit.get(mapping.unitId).push(mapping);});
const scene=document.getElementById("scene");
const svg=document.getElementById("canvas");
const details=document.getElementById("details");
const resultCount=document.getElementById("result-count");
let selected={kind:"",id:""};
let transform={x:24,y:24,scale:window.innerWidth<600?0.55:0.8};
let drag=null;
let suppressClick=false;
const relationNames={requires:"学习前置",constructs:"构造 / 扩展",improves:"优化 / 演进",inverse:"互逆"};
const kindNames={concept:"概念",method:"方法",module:"模块"};
const basisNames={stem:"题干直接指向","official-solution":"官方解答","agent-analysis":"分析判定"};
function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined&&text!==null)node.textContent=String(text);
  return node;
}
function svgElement(tag,attributes,text){
  const node=document.createElementNS(SVG_NS,tag);
  Object.entries(attributes||{}).forEach(([key,value])=>node.setAttribute(key,String(value)));
  if(text!==undefined)node.textContent=text;
  return node;
}
function stars(value){const count=Number(value);return count+" 星（"+"★".repeat(count)+"☆".repeat(Math.max(0,5-count))+"）";}
function pageRanges(pages){
  const values=Array.from(new Set((pages||[]).map(Number))).sort((a,b)=>a-b);
  if(!values.length)return "—";
  const ranges=[];let start=values[0],previous=values[0];
  values.slice(1).forEach(page=>{if(page===previous+1){previous=page;}else{ranges.push(start===previous?String(start):start+"–"+previous);start=page;previous=page;}});
  ranges.push(start===previous?String(start):start+"–"+previous);return ranges.join("、");
}
function sourceBlock(refs){
  const wrapper=element("div","sources");
  (refs||[]).forEach(ref=>{
    const source=sourceById.get(ref.sourceId);
    if(!source)return;
    const row=element("div","source-item");
    const link=element("a","",source.id+" · PDF P"+pageRanges(ref.pdfPages)+(ref.bookPages?" · 书 P"+pageRanges(ref.bookPages):""));
    link.href=source.href;link.target="_blank";link.rel="noopener";
    link.setAttribute("aria-label","打开来源 "+source.title+"，PDF 页 "+pageRanges(ref.pdfPages));
    row.appendChild(link);
    if(ref.note)row.appendChild(document.createTextNode("："+ref.note));
    wrapper.appendChild(row);
  });
  if(!wrapper.children.length)wrapper.appendChild(element("p","empty","无来源记录"));
  return wrapper;
}
function section(title){details.appendChild(element("h3","",title));}
function paragraph(text,className){const node=element("p",className||"",text);details.appendChild(node);return node;}
function clearDetails(){while(details.firstChild)details.removeChild(details.firstChild);}
function actionButton(label,handler){
  const button=element("button","link-button",label);button.type="button";button.addEventListener("click",handler);return button;
}
function updateSelection(){
  nodeElements.forEach((node,id)=>{const active=selected.kind==="unit"&&selected.id===id;node.classList.toggle("selected",active);node.setAttribute("aria-pressed",String(active));});
  edgeElements.forEach((edge,id)=>{const active=selected.kind==="relation"&&selected.id===id;edge.classList.toggle("selected",active);edge.setAttribute("aria-pressed",String(active));});
  groupElements.forEach((group,id)=>{const active=selected.kind==="theme"&&selected.id===id;group.classList.toggle("selected",active);group.setAttribute("aria-pressed",String(active));});
}
function select(kind,id){selected={kind:kind,id:id};updateSelection();}
function showUnit(unitId){
  const unit=unitById.get(unitId);if(!unit)return;
  const theme=themeById.get(unit.themeId);select("unit",unitId);clearDetails();
  details.appendChild(element("h2","",unit.name));
  paragraph(unit.unitId+" · "+unit.lessonId+" · "+theme.name+" · "+(kindNames[unit.kind]||unit.kind),"meta");
  paragraph(stars(unit.rating.stars),"rating");
  if(unit.aliases&&unit.aliases.length)paragraph("别名："+unit.aliases.join("、"),"meta");
  section("掌握目标与简要内容");paragraph(unit.outcome);paragraph(unit.summary,"evidence");
  section("评级理由");paragraph(unit.rating.rationale);
  if(unit.rating.supportAdjustment)paragraph("支撑调整："+(typeof unit.rating.supportAdjustment==="string"?unit.rating.supportAdjustment:JSON.stringify(unit.rating.supportAdjustment)),"meta");
  section("内部项");
  if(unit.internals&&unit.internals.length){const list=element("ul");unit.internals.forEach(item=>list.appendChild(element("li","",(item.kind?item.kind+"：":"")+item.text)));details.appendChild(list);}else paragraph("无单独内部项。","empty");
  [["direct","直接考查题目 direct"],["support","前置支撑题目 support"]].forEach(([role,title])=>{
    section(title);
    const matches=(mappingsByUnit.get(unitId)||[]).filter(mapping=>mapping.role===role);
    if(!matches.length){paragraph("无 "+role+" 映射。","empty");return;}
    const list=element("ul");
    matches.forEach(mapping=>{
      const question=questionById.get(mapping.questionId);if(!question)return;
      const item=element("li");
      item.appendChild(element("strong","",question.label+"（"+question.id+"）"));
      item.appendChild(document.createTextNode("："+question.taskSummary));
      item.appendChild(element("div","meta","依据 "+mapping.basis+"（"+(basisNames[mapping.basis]||mapping.basis)+"）"+(mapping.note?"；"+mapping.note:"")+"；官方答案："+(question.hasOfficialAnswer?"有":"无")));
      item.appendChild(sourceBlock(question.sourceRefs));list.appendChild(item);
    });
    details.appendChild(list);
  });
  section("单元来源");details.appendChild(sourceBlock(unit.sourceRefs));
  section("关联关系");
  const related=board.edges.filter(edge=>edge.fromUnitId===unitId||edge.toUnitId===unitId);
  if(!related.length)paragraph("无已审核关系。","empty");
  related.forEach(edge=>details.appendChild(actionButton(edge.relationId+" · "+edge.type+" · "+edge.fromUnitId+" → "+edge.toUnitId,()=>showRelation(edge.relationId))));
  details.appendChild(actionButton("查看所属主题："+theme.name,()=>showTheme(theme.themeId)));
}
function showTheme(themeId){
  const theme=themeById.get(themeId);if(!theme)return;
  select("theme",themeId);clearDetails();details.appendChild(element("h2","",theme.name));
  paragraph(theme.themeId+" · "+theme.lessonId+" · "+theme.unitIds.length+" 个当前单元","meta");
  paragraph(stars(theme.rating.stars),"rating");
  section("核心学习表现");paragraph(theme.coreOutcome);
  section("主题评级理由");paragraph(theme.rating.rationale);
  paragraph("单元峰值 "+theme.unitPeak+"；分布 "+theme.ratingDistribution+"。","evidence");
  section("主题来源");details.appendChild(sourceBlock(theme.sourceRefs));
  section("主题内单元");
  theme.unitIds.forEach(unitId=>{const unit=unitById.get(unitId);details.appendChild(actionButton(unitId+" · "+unit.name,()=>showUnit(unitId)));});
  section("由 B–B 关系聚合的主题连接");
  const aggregates=board.themeEdges.filter(edge=>edge.fromThemeId===themeId||edge.toThemeId===themeId);
  if(!aggregates.length){paragraph("无跨主题聚合边。","empty");return;}
  aggregates.forEach(aggregate=>{
    paragraph(aggregate.id+"："+aggregate.fromThemeId+" → "+aggregate.toThemeId+" · "+aggregate.type+" · "+aggregate.view,"meta");
    aggregate.relationIds.forEach(relationId=>{const edge=relationById.get(relationId);details.appendChild(actionButton(relationId+"："+edge.fromUnitId+" → "+edge.toUnitId,()=>showRelation(relationId)));});
  });
}
function showRelation(relationId){
  const edge=relationById.get(relationId);if(!edge)return;
  select("relation",relationId);clearDetails();details.appendChild(element("h2","",edge.relationId+" · "+edge.type));
  paragraph((relationNames[edge.type]||edge.type)+" · "+edge.view+" · "+(edge.directed?"有向":"无向"),"meta");
  details.appendChild(actionButton("起点："+edge.fromUnitId+" · "+unitById.get(edge.fromUnitId).name,()=>showUnit(edge.fromUnitId)));
  details.appendChild(actionButton("终点："+edge.toUnitId+" · "+unitById.get(edge.toUnitId).name,()=>showUnit(edge.toUnitId)));
  section("关系价值");paragraph(edge.value,"evidence");
  if(edge.route)paragraph("路线："+edge.route);
  if(edge.requirementGroupId){
    const group=groupById.get(edge.requirementGroupId);
    section("前置路线组 "+edge.requirementGroupId);
    if(group){
      paragraph(group.mode==="any"?"任一（OR），不是 AND":"全部（AND）","rating");paragraph(group.value);
      group.unitIds.forEach(unitId=>details.appendChild(actionButton(unitId+" · "+unitById.get(unitId).name,()=>showUnit(unitId))));
      details.appendChild(sourceBlock(group.sourceRefs));
    }
  }
  section("关系来源");details.appendChild(sourceBlock(edge.sourceRefs));
}
function wrapped(value,limit,maxLines){
  const chars=Array.from(String(value));const lines=[];
  for(let index=0;index<chars.length&&lines.length<maxLines;index+=limit)lines.push(chars.slice(index,index+limit).join(""));
  if(chars.length>limit*maxLines)lines[maxLines-1]=lines[maxLines-1].slice(0,Math.max(1,limit-1))+"…";
  return lines;
}
function addSvgText(parent,lines,x,y,className,lineHeight){
  const text=svgElement("text",{x:x,y:y,class:className});
  lines.forEach((line,index)=>{const span=svgElement("tspan",{x:x,dy:index===0?0:lineHeight},line);text.appendChild(span);});parent.appendChild(text);return text;
}
function activateOnKeyboard(node,handler){node.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();handler();}});}
function clickable(node,handler){
  node.addEventListener("click",event=>{event.stopPropagation();if(!suppressClick)handler();});
  activateOnKeyboard(node,handler);
}
function renderGroups(){
  const layer=document.getElementById("group-layer");
  board.groups.forEach(theme=>{
    const layout=layoutGroupByTheme.get(theme.themeId);
    const group=svgElement("g",{class:"group",tabindex:"0",role:"button","aria-pressed":"false","aria-label":"主题 "+theme.name+"，"+stars(theme.rating.stars),"data-theme-id":theme.themeId});
    group.appendChild(svgElement("rect",{class:"group-bg",x:layout.x,y:layout.y,width:layout.width,height:layout.height,rx:14}));
    addSvgText(group,wrapped(layout.title||theme.name,35,1),layout.x+18,layout.y+29,"group-title",18);
    addSvgText(group,[theme.lessonId+" · "+theme.unitIds.length+" 个单元 · "+theme.unitPeak+" 峰值 · "+stars(theme.rating.stars)],layout.x+18,layout.y+53,"group-meta",15);
    clickable(group,()=>{showTheme(theme.themeId);focusTheme(theme.themeId);});
    layer.appendChild(group);groupElements.set(theme.themeId,group);
  });
}
function center(layout){return {x:Number(layout.x)+Number(layout.width)/2,y:Number(layout.y)+Number(layout.height)/2};}
function boundary(layout,toward){
  const c=center(layout),dx=toward.x-c.x,dy=toward.y-c.y;
  if(dx===0&&dy===0)return c;
  const factor=1/Math.max(Math.abs(dx)/(Number(layout.width)/2),Math.abs(dy)/(Number(layout.height)/2));
  return {x:c.x+dx*factor,y:c.y+dy*factor};
}
function renderEdges(){
  const layer=document.getElementById("edge-layer");
  board.edges.forEach(edge=>{
    const fromLayout=layoutNodeByUnit.get(edge.fromUnitId),toLayout=layoutNodeByUnit.get(edge.toUnitId);
    const fromCenter=center(fromLayout),toCenter=center(toLayout);
    let start,end,pathData,labelX,labelY;
    if(edge.fromUnitId===edge.toUnitId){
      start={x:fromCenter.x+Number(fromLayout.width)/2,y:fromCenter.y-15};end={x:fromCenter.x+Number(fromLayout.width)/2,y:fromCenter.y+15};
      pathData="M "+start.x+" "+start.y+" C "+(start.x+100)+" "+(start.y-90)+" "+(end.x+100)+" "+(end.y+90)+" "+end.x+" "+end.y;
      labelX=start.x+95;labelY=start.y-10;
    }else{
      start=boundary(fromLayout,toCenter);end=boundary(toLayout,fromCenter);pathData="M "+start.x+" "+start.y+" L "+end.x+" "+end.y;
      labelX=(start.x+end.x)/2;labelY=(start.y+end.y)/2-6;
    }
    const group=svgElement("g",{class:"edge edge-"+edge.type,tabindex:"0",role:"button","aria-pressed":"false","aria-label":"关系 "+edge.relationId+"，"+edge.type+"，"+edge.fromUnitId+" 到 "+edge.toUnitId,"data-relation-id":edge.relationId});
    group.appendChild(svgElement("path",{class:"edge-hit",d:pathData}));
    const attributes={class:"edge-line",d:pathData};if(edge.directed)attributes["marker-end"]="url(#arrow)";
    group.appendChild(svgElement("path",attributes));
    const label=edge.type+(edge.requirementGroupId?" · "+edge.requirementGroupId+" 任一":"");
    addSvgText(group,[label],labelX,labelY,"edge-label",12);
    clickable(group,()=>showRelation(edge.relationId));layer.appendChild(group);edgeElements.set(edge.relationId,group);
  });
}
function renderNodes(){
  const layer=document.getElementById("node-layer");
  board.nodes.forEach(unit=>{
    const layout=layoutNodeByUnit.get(unit.unitId);
    const node=svgElement("g",{class:"node stars-"+unit.rating.stars,transform:"translate("+layout.x+" "+layout.y+")",tabindex:"0",role:"button","aria-pressed":"false","aria-label":"单元 "+unit.unitId+" "+unit.name+"，"+stars(unit.rating.stars),"data-unit-id":unit.unitId});
    node.appendChild(svgElement("rect",{class:"node-bg",x:0,y:0,width:layout.width,height:layout.height,rx:9}));
    addSvgText(node,[unit.unitId+" · "+"★".repeat(unit.rating.stars)],12,19,"node-id",14);
    addSvgText(node,wrapped(unit.name,17,2),12,42,"node-name",18);
    clickable(node,()=>showUnit(unit.unitId));layer.appendChild(node);nodeElements.set(unit.unitId,node);
  });
}
function applyTransform(){scene.setAttribute("transform","translate("+transform.x+" "+transform.y+") scale("+transform.scale+")");}
function zoomAt(factor,x,y){
  const next=Math.min(2.5,Math.max(0.2,transform.scale*factor));const ratio=next/transform.scale;
  transform.x=x-(x-transform.x)*ratio;transform.y=y-(y-transform.y)*ratio;transform.scale=next;applyTransform();
}
function zoomCenter(factor){const rect=svg.getBoundingClientRect();zoomAt(factor,rect.width/2,rect.height/2);}
function resetView(){transform={x:24,y:24,scale:window.innerWidth<600?0.55:0.8};document.getElementById("theme-focus").value="";applyTransform();}
function focusTheme(themeId){
  const layout=layoutGroupByTheme.get(themeId);if(!layout)return;
  const rect=svg.getBoundingClientRect();const padding=50;
  const scale=Math.min(1.15,Math.max(0.25,Math.min((rect.width-padding*2)/Number(layout.width),(rect.height-padding*2)/Number(layout.height))));
  transform.scale=scale;transform.x=(rect.width-Number(layout.width)*scale)/2-Number(layout.x)*scale;transform.y=(rect.height-Number(layout.height)*scale)/2-Number(layout.y)*scale;applyTransform();
}
function option(select,value,label){const node=document.createElement("option");node.value=value;node.textContent=label;select.appendChild(node);}
function populateControls(){
  const lessonFilter=document.getElementById("lesson-filter"),themeFilter=document.getElementById("theme-filter"),themeFocus=document.getElementById("theme-focus"),typeFilter=document.getElementById("question-type-filter");
  const lessons=Array.from(new Set(board.groups.map(theme=>theme.lessonId))).sort((a,b)=>a.localeCompare(b,"zh-Hans-CN",{numeric:true}));
  lessons.forEach(lesson=>option(lessonFilter,lesson,lesson));
  board.groups.forEach(theme=>{option(themeFilter,theme.themeId,theme.lessonId+" · "+theme.name);option(themeFocus,theme.themeId,theme.lessonId+" · "+theme.name);});
  const types=Array.from(new Set(board.nodes.flatMap(unit=>unit.questionTypes||[]))).sort((a,b)=>a.localeCompare(b,"zh-Hans-CN"));
  types.forEach(type=>option(typeFilter,type,type));
  ["main","auxiliary","all"].forEach(view=>{const select=document.getElementById("relation-view");select.options[select.options.length-3+["main","auxiliary","all"].indexOf(view)].textContent=(view==="main"?"主视图 main":view==="auxiliary"?"辅助视图 auxiliary":"全部 all")+"（"+board.views[view].edgeIds.length+"）";});
}
function applyFilters(){
  const query=document.getElementById("search").value.trim().toLocaleLowerCase();
  const lesson=document.getElementById("lesson-filter").value,theme=document.getElementById("theme-filter").value;
  const rating=document.getElementById("rating-filter").value,questionType=document.getElementById("question-type-filter").value;
  const visibleUnits=new Set();
  nodeElements.forEach((node,unitId)=>{
    const unit=unitById.get(unitId);const haystack=[unit.name,(unit.aliases||[]).join(" "),unit.unitId].join(" ").toLocaleLowerCase();
    const visible=(!query||haystack.includes(query))&&(!lesson||unit.lessonId===lesson)&&(!theme||unit.themeId===theme)&&(!rating||String(unit.rating.stars)===rating)&&(!questionType||(unit.questionTypes||[]).includes(questionType));
    node.style.display=visible?"":"none";node.setAttribute("aria-hidden",String(!visible));if(visible)visibleUnits.add(unitId);
  });
  groupElements.forEach((group,themeId)=>{const visible=themeById.get(themeId).unitIds.some(unitId=>visibleUnits.has(unitId));group.style.display=visible?"":"none";group.setAttribute("aria-hidden",String(!visible));});
  const allowed=new Set(board.views[document.getElementById("relation-view").value].edgeIds);let visibleRelations=0;
  edgeElements.forEach((group,relationId)=>{const edge=relationById.get(relationId);const visible=allowed.has(relationId)&&visibleUnits.has(edge.fromUnitId)&&visibleUnits.has(edge.toUnitId);group.style.display=visible?"":"none";group.setAttribute("aria-hidden",String(!visible));if(visible)visibleRelations+=1;});
  resultCount.textContent="显示 "+visibleUnits.size+" / "+board.nodes.length+" 个单元，"+visibleRelations+" / "+allowed.size+" 条当前视图关系（全部已审核关系 "+board.edges.length+" 条）";
}
function clearFilters(){
  ["search"].forEach(id=>document.getElementById(id).value="");
  ["lesson-filter","theme-filter","rating-filter","question-type-filter"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("relation-view").value="main";applyFilters();
}
svg.addEventListener("pointerdown",event=>{
  if(event.button!==0)return;drag={x:event.clientX,y:event.clientY,startX:transform.x,startY:transform.y,moved:false,captured:false};
});
svg.addEventListener("pointermove",event=>{
  if(!drag)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;
  if(drag.moved){
    if(!drag.captured){svg.setPointerCapture(event.pointerId);drag.captured=true;}
    transform.x=drag.startX+dx;transform.y=drag.startY+dy;applyTransform();event.preventDefault();
  }
});
function endDrag(event){if(!drag)return;suppressClick=drag.moved;drag=null;if(svg.hasPointerCapture(event.pointerId))svg.releasePointerCapture(event.pointerId);setTimeout(()=>{suppressClick=false;},0);}
svg.addEventListener("pointerup",endDrag);svg.addEventListener("pointercancel",endDrag);
svg.addEventListener("wheel",event=>{event.preventDefault();const rect=svg.getBoundingClientRect();zoomAt(event.deltaY<0?1.12:1/1.12,event.clientX-rect.left,event.clientY-rect.top);},{passive:false});
svg.addEventListener("keydown",event=>{
  if(event.target!==svg)return;const moves={ArrowLeft:[45,0],ArrowRight:[-45,0],ArrowUp:[0,45],ArrowDown:[0,-45]};
  if(moves[event.key]){event.preventDefault();transform.x+=moves[event.key][0];transform.y+=moves[event.key][1];applyTransform();}
  else if(event.key==="+"||event.key==="="){event.preventDefault();zoomCenter(1.15);}else if(event.key==="-"){event.preventDefault();zoomCenter(1/1.15);}else if(event.key==="0"){event.preventDefault();resetView();}
});
document.getElementById("zoom-in").addEventListener("click",()=>zoomCenter(1.2));
document.getElementById("zoom-out").addEventListener("click",()=>zoomCenter(1/1.2));
document.getElementById("reset-view").addEventListener("click",resetView);
document.getElementById("clear-filters").addEventListener("click",clearFilters);
document.getElementById("search").addEventListener("input",applyFilters);
["lesson-filter","theme-filter","rating-filter","question-type-filter","relation-view"].forEach(id=>document.getElementById(id).addEventListener("change",applyFilters));
document.getElementById("theme-focus").addEventListener("change",event=>{if(event.target.value){focusTheme(event.target.value);showTheme(event.target.value);}});
renderGroups();renderEdges();renderNodes();populateControls();applyFilters();applyTransform();
</script>
</body>
</html>
"""
