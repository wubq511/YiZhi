# 执行记录：eval-01-precise-query（with_skill）

## 原始任务

在期中知识地图中找「用译码器实现逻辑函数」，给出单元 ID、主题、重要性、课件页码、直接关联题目和直接前置；不要从 Markdown 猜。实际调用接口，保存 `search` / `get` / `questions` / `related` 的原始 JSON 到 outputs，另写 `answer.md`；本文件记录过程与结论。

工作目录：`/Users/robertwu/Documents/大二上/数字逻辑与部件设计`

## 遵循的 Skill

先读取 `.agents/skills/digital-logic-midterm-map/SKILL.md`，按其中规定使用统一入口 `期中/工具/知识地图.py`。查询流程为：

1. `search` 按名称定位单元，查看全部匹配及主题上下文；
2. `get` 按稳定 ID 精确读取；
3. `questions --role direct` 取直接题目；
4. `related --relation requires --direction upstream --depth 1` 取直接前置。

未修改任何权威数据、派生产物或工具。

## 实际执行的命令与退出状态

所有命令均在项目根执行。输出文件位于 `outputs/`。

| # | 命令 | 退出状态 | 输出文件 |
|---|---|---|---|
| 1 | `python3 期中/工具/知识地图.py --help` | 0 | 终端 |
| 2 | `python3 期中/工具/知识地图.py search '译码器' --limit 0` | 0 | `outputs/search.json` |
| 3 | `python3 期中/工具/知识地图.py get KU-064` | 0 | `outputs/get-KU-064.json` |
| 4 | `python3 期中/工具/知识地图.py questions KU-064 --role direct` | 0 | `outputs/questions-KU-064-direct.json` |
| 5 | `python3 期中/工具/知识地图.py related KU-064 --relation requires --direction upstream --depth 1` | 0 | `outputs/related-KU-064-requires-depth1.json` |
| 6 | `python3 期中/工具/知识地图.py get SRC-C05` | 0 | `outputs/get-SRC-C05.json` |
| 7 | `python3 期中/工具/知识地图.py get TH-14` | 0 | `outputs/get-TH-14.json` |
| 8 | `python3 期中/工具/知识地图.py questions KU-064 --role all` | 0 | `outputs/questions-KU-064-all.json` |

说明：第 6、7 条命令的 stderr 为空文件，已删除，未产生其他临时文件。命令 6、7、8 用于补充核对来源标题/总页数、主题评级，以及确认 direct 题目是否只有一道。

## 原始证据与关键字段

`search.json`：`query="译码器"`，`count=5`。其中精确命中：

- `KU-064`，`name="用译码器实现逻辑函数"`，`themeId="TH-14"`，`kind="method"`，`stars=5`。

`get-KU-064.json`：

- `id="KU-064"`，`themeId="TH-14"`，`kind="method"`。
- `sourceRefs` 均为 `SRC-C05`，`visualStatus="verified"`：PDF 35；37；39；42–43。
- `rating.stars=5`，理由引用习题课【11】`Q-120`（official-solution）。
- `theme.name="编码器与译码器"`，`theme.lessonId="L05"`，`theme.rating.stars=5`。
- 内嵌 `questions` 仅含 `MAP-199 → Q-120`，`role="direct"`。
- 内嵌 `relations` 含三条 `requires` 入边：`REL-015`（KU-028）、`REL-016`（KU-062）、`REL-040`（KU-024）。

`questions-KU-064-direct.json`：

- `counts={"direct":1}`；唯一项 `Q-120`【11】，`role="direct"`，`basis="official-solution"`，来源 `SRC-EX07` 第 17 页，`hasOfficialAnswer=true`。

`related-KU-064-requires-depth1.json`：

- 根节点 `KU-064`，`relationType="requires"`，`direction="upstream"`，`depth=1`，`view="all"`。
- depth 1 节点：`KU-028`、`KU-062`、`KU-024`。
- `conditions["KU-064"].required = ["KU-028","KU-062","KU-024"]`，`groups=[]`；`requirementGroups=[]`。
- `REL-040` 的 `view="auxiliary"`，`route="低有效输出实现"`；另两条为 `view="main"`。

`get-SRC-C05.json`：

- `type="courseware"`，`title="05 组合模块1+代码"`，`path="理论课/课件/05 组合模块1+代码.pdf"`，`totalPages=61`。

`get-TH-14.json`：

- `name="编码器与译码器"`，`rating.stars=5`，`unitPeak=5`；`KU-064` 为其下唯一 5 星单元。

## 最终结论

- 单元 ID：`KU-064`
- 主题：`TH-14` 编码器与译码器（`L05`）
- 重要性：单元 5 星，主题 5 星
- 课件页码：`SRC-C05` PDF 第 35、37、39、42–43 页（均为 verified）
- 直接关联题目：`Q-120`【11】（映射 `MAP-199`，`role=direct`，official-solution）；本单元无 support 题目
- 直接前置：`KU-028`（`REL-015`，main）、`KU-062`（`REL-016`，main）、`KU-024`（`REL-040`，auxiliary 路线「低有效输出实现」）；三条均列入 `conditions.required`

证据可独立复核：每个字段均来自上表命令的稳定 JSON，不依赖 Markdown 或显示标签。

## 指标

工具未返回 `total_tokens` 或 `duration_ms`；Bash 仅报告各次调用的 wall time，均在 0.2 s 以内。因此无法提供这两个指标，未虚构数值。
