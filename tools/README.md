# 项目工具

课程目录只保存资料、知识及学习状态，课程工具集中在这里。以下课程命令从 YiZhi 仓库根运行，默认读取 `courses/digital-logic/`。

## 桌面开发工具边界

旧版课程临时迁入和可控生产者在 [桌面开发工具](desktop/README.md) 独立组织和构建。正式应用不加载或打包这些工具；目标边界见 [ADR-0008](../docs/adr/0008-product-development-boundary.md)。

## 数字逻辑知识

```bash
python3 tools/digital-logic/知识地图.py search '译码器' --limit 0
python3 tools/digital-logic/知识地图.py get KU-064
python3 tools/digital-logic/知识地图.py check --source-only
python3 tools/digital-logic/知识地图.py check
```

`知识地图.py` 是统一查询与校验入口；`地图生成.py` 只从既有权威数据生成 Markdown、HTML 与画板图，`复习内容.py` 负责内容包的领域校验。布局与身份不会因展示视图重建而重新生成。

运行中的内容导入统一使用 `python3 legacy/review-board/import_content.py 内容包.json`。底层 `复习内容.py import` 不参与应用内容锁，不能与正在使用的课程并发写入。

## 教材检索

```bash
python3 tools/digital-logic/textbook/教材.py verify
python3 tools/digital-logic/textbook/教材.py search '5.55' --chapter 5 --scope exercises
python3 tools/digital-logic/textbook/教材.py read 179-180
```

教材原件、OCR、章节文本、页码与校准目录保留在课程的教材目录。普通检索使用现有索引；`构建索引.py` 和 `ocr.swift` 仅用于有明确需要的资料维护，正常开发不重新 OCR 或重建课程。

## 验证

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tools/digital-logic -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tools/digital-logic/textbook -p 'test_*.py'
```

查询和教材使用规则分别见 [知识地图技能](../.agents/skills/digital-logic-midterm-map/SKILL.md) 与 [教材技能](../.agents/skills/digital-logic-textbook/SKILL.md)。
