# 执行记录：without_skill 基线

## 1. 原始任务

> 你是知识地图项目 Skill 评测的 without_skill 基线执行者。项目根目录为 /Users/robertwu/Documents/大二上/数字逻辑与部件设计。这是无 Skill 对照：不要读取、调用或遵循任何 SKILL.md，也不要读取本评测的 with_skill 结果。除这项限制外正常完成任务。不要修改正式知识地图、布局、派生产物、设计规则或工具。
>
> Execute this task:
> - Task: 在临时副本中修改一个有效来源页码并重建；再尝试加入一条没有 value 的关系。不得改动正式数据。
> - Input files: none
> - Save outputs to: /Users/robertwu/Documents/大二上/数字逻辑与部件设计/.agents/skills/digital-logic-midterm-map-workspace/iteration-1/eval-03-safe-rebuild-and-errors/without_skill/outputs/
>
> 请自行定位并使用现有统一接口。实际完成有效变更、build 和 check，保存原始成功日志；用实际接口查询及派生文件内容证明修改在 Markdown、HTML、画板图和 Agent 查询中一致。然后对没有 value 的新关系实际运行校验，保存非零退出状态和具体错误，不得让无效关系污染有效副本的构建产物。操作前和结束后记录正式 期中/数据/知识地图.json 与 期中/数据/视图布局.json 的内容 SHA-256，证明两者未变。有效副本、无效副本、输出目录都必须在 /tmp 下你新建的独立目录中，不能覆盖正式数据。不要改工具来使测试通过。
>
> 写 answer.md（执行结果及证据索引）、transcript.md（放在 outputs 的上一级，即 without_skill/ 目录；包含原始任务、实际命令、退出状态、临时路径、校验结果、正式文件哈希对比）和 outputs/hashes.json（before/after 哈希）。所有原始命令输出保存到 outputs，不能仅写“应当如此”。不要读取本评测的其他运行结果。完成后报告输出路径、临时副本位置、关键结果，以及你的 total_tokens 和 duration_ms（若工具返回这些指标）。

约束执行情况：未读取、调用或遵循任何 `SKILL.md`；未读取本评测 `with_skill` 目录；未修改正式数据、布局、派生产物、设计规则或工具。所有验证都通过现有 `期中/工具/知识地图.py` 统一接口执行。

## 2. 环境与路径

| 项 | 值 |
| --- | --- |
| 日期 | 2026-10-25（+08:00） |
| Python | `python3.12`，3.12.13 |
| 项目根目录 | `/Users/robertwu/Documents/大二上/数字逻辑与部件设计` |
| 统一接口 | `期中/工具/知识地图.py`（`get/search/related/path/questions/graph/check/build`） |
| 临时根目录 | `/tmp/midterm-map-eval03-baseline.DmVo3X` |
| 有效副本 | `/tmp/midterm-map-eval03-baseline.DmVo3X/valid/期中` |
| 无效副本 | `/tmp/midterm-map-eval03-baseline.DmVo3X/invalid/期中` |
| 有效副本构建输出 | `/tmp/midterm-map-eval03-baseline.DmVo3X/valid/期中`（工具默认输出目录） |
| 独立构建输出目录 | `/tmp/midterm-map-eval03-baseline.DmVo3X/build-output`（`MIDTERM_OUTPUT_DIR`） |
| 评测交付目录 | `/Users/robertwu/Documents/大二上/数字逻辑与部件设计/.agents/skills/digital-logic-midterm-map-workspace/iteration-1/eval-03-safe-rebuild-and-errors/without_skill/outputs` |

创建方式（退出码 0，日志 `outputs/logs/01_temp_setup.log`）：

```bash
TMPROOT=$(mktemp -d /tmp/midterm-map-eval03-baseline.XXXXXX)
mkdir -p "$TMPROOT/valid" "$TMPROOT/invalid"
cp -R "期中" "$TMPROOT/valid/期中"
cp -R "期中" "$TMPROOT/invalid/期中"
ln -s ".../理论课" "$TMPROOT/valid/理论课"
ln -s ".../习题课" "$TMPROOT/valid/习题课"
ln -s ".../教材" "$TMPROOT/valid/教材"
# invalid 副本同样建立三个来源目录符号链接
```

说明：工具把 `BASE` 解析为 `工具/知识地图.py` 的上一级 `期中/`，把 `ROOT` 解析为项目根；来源存在性检查要求 `理论课/`、`习题课/`、`教材/` 存在于临时根目录，因此使用符号链接引用正式资料。没有向正式目录写入。

## 3. 接口定位

命令（退出码 0，完整输出见 `outputs/logs/00b_environment_and_interface_help.log`）：

```bash
python3.12 期中/工具/知识地图.py --help
for cmd in get search related path questions graph check build; do
  python3.12 期中/工具/知识地图.py "$cmd" --help
done
```

定位到的统一接口：

```text
get search related path questions graph check build
```

关键实现细节：

- `MIDTERM_MAP_FILE` 默认指向副本自己的 `数据/知识地图.json`。
- `MIDTERM_LAYOUT_FILE` 默认指向副本自己的 `数据/视图布局.json`。
- `MIDTERM_OUTPUT_DIR` 默认指向副本自己的 `期中/`；因此 `build` 的全部派生产物写在 `/tmp` 副本内。
- `check` 先校验权威数据与布局，再逐文件比较 5 个派生产物。
- 校验规则包含：关系必须有非空 `value`；单元来源页必须与 `pageCoverage` 精确一致。

## 4. 操作前正式文件哈希

命令（退出码 0，日志 `outputs/logs/00_formal_hashes_before.txt`）：

```bash
shasum -a 256 \
  "期中/数据/知识地图.json" \
  "期中/数据/视图布局.json"
```

结果：

```text
86d0ef390cc00efcc41e1abe2f8d10341a59a907ea5cd6f351777a2d6822c1bf  期中/数据/知识地图.json
c9f0f6b75a0e630cf92b34fc5a5c7980ecd3500fb7b3d5085d2de69181322b93  期中/数据/视图布局.json
```

## 5. 有效副本基线校验

命令（均在有效副本内执行）：

```bash
python3.12 "$TMPROOT/valid/期中/工具/知识地图.py" check --source-only
python3.12 "$TMPROOT/valid/期中/工具/知识地图.py" check
```

结果：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `check --source-only` | 0 | `status: ok`，`sourceHash: de303986e203e77cada8eeb3680cabeaa29967b5af37d25409545008a8a058cf` |
| `check` | 0 | `status: ok`，含 `layout`、`derived_outputs` |

原始输出：`outputs/logs/02a_baseline_check_source.log`、`outputs/logs/02b_baseline_check_full.log`；退出码：对应的 `.exit` 文件。

修改前有效副本派生产物哈希：`outputs/logs/02c_valid_copy_outputs_before.sha256`。

## 6. 有效变更

### 6.1 修改内容

对象：`KU-003 二进制、八进制与十六进制互转`。

- `sourceRefs` 中 `SRC-C01` 的 `pdfPages`：`[34]` → `[35]`。
- `SRC-C01` 逐页覆盖第 34 页 `unitIds`：移除 `KU-003`。
- `SRC-C01` 逐页覆盖第 35 页 `unitIds`：加入 `KU-003`。
- `SRC-C01` 共 57 页，35 在有效范围内（`get SRC-C01` 实际返回 `totalPages: 57`）。

修改方式：对 `/tmp` 有效副本的 `数据/知识地图.json` 运行 Python 脚本；脚本先备份到 `/tmp/.../valid/知识地图.before.json`，再做精确断言和写回。退出码 0。

原始输出（`outputs/logs/03_modify_valid_copy.log`）：

```text
modified unit: KU-003 二进制、八进制与十六进制互转
pdfPages: [34] -> [35] (sourceId: SRC-C01)
pageCoverage SRC-C01 p34 unitIds: []
pageCoverage SRC-C01 p35 unitIds: ['KU-007', 'KU-003']
data sha256 before: 86d0ef390cc00efcc41e1abe2f8d10341a59a907ea5cd6f351777a2d6822c1bf
data sha256 after : 36375174bc45926302b4b320b45efb219f8d5e4edc2b7f11cec7626e3075b084
```

数据差异（`outputs/logs/03b_valid_data.diff`）只包含上述三处：单元来源页、第 34 页覆盖、第 35 页覆盖。

### 6.2 修改后校验与构建

命令与退出码：

| 命令 | 退出码 | 结果 | 原始日志 |
| --- | --- | --- | --- |
| `check --source-only` | 0 | `status: ok`，`sourceHash: 7c34651a…d207` | `04a_valid_check_source_after_edit.log` |
| `build` | 0 | 输出 5 个派生产物，`sourceHash: 7c34651a…d207` | `04b_valid_build.log` |
| `check` | 0 | `status: ok`，含 `layout`、`derived_outputs` | `04c_valid_check_after_build.log` |

`build` 返回的 5 个产物：

```text
01-课件知识点.md
02-题目知识点映射.md
03-知识点地图.md
知识地图.html
数据/画板图.json
```

构建在 `/tmp/.../valid/期中` 内完成，未写入正式目录。

### 6.3 独立输出目录

为明确满足“输出目录在 `/tmp` 下”的要求，另建立 `/tmp/.../build-output` 并通过 `MIDTERM_OUTPUT_DIR` 指定：

```bash
mkdir -p "$TMPROOT/build-output"
MIDTERM_OUTPUT_DIR="$TMPROOT/build-output" python3.12 "$VALID/工具/知识地图.py" build
MIDTERM_OUTPUT_DIR="$TMPROOT/build-output" python3.12 "$VALID/工具/知识地图.py" check
```

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| 独立输出目录 `build` | 0 | `11a_dedicated_output_build.log` / `.exit` |
| 独立输出目录 `check` | 0 | `11b_dedicated_output_check.log` / `.exit` |

独立输出目录的 5 个派生产物与副本内构建逐文件 SHA-256 相同（`11c_dedicated_output_hashes.sha256`、`11d_output_equivalence.txt`：`five derived outputs equal ...: True`）。

## 7. 跨产物一致性验证

### 7.1 Agent 查询

命令（退出码 0）：

```bash
python3.12 "$TMPROOT/valid/期中/工具/知识地图.py" get KU-003
python3.12 "$TMPROOT/valid/期中/工具/知识地图.py" search "二进制、八进制与十六进制互转" --type unit --limit 5
python3.12 "$TMPROOT/valid/期中/工具/知识地图.py" get SRC-C01
```

`get KU-003` 的实际结果（节选，完整见 `outputs/logs/05a_agent_get_KU-003.json`）：

```json
"sourceRefs": [
  {
    "sourceId": "SRC-C01",
    "pdfPages": [35],
    "visualStatus": "verified",
    "note": "二进制、八进制与十六进制互转：二/八/十六进制按 3 位/4 位分组互转"
  }
]
```

`get SRC-C01` 返回 `totalPages: 57`，证明 35 是有效页码。

### 7.2 Markdown

命令（`01` 有 1 行匹配；`03` 无匹配并返回 1，因此命令使用了 `|| true` 继续）：

```bash
grep -n 'KU-003' "$TMPROOT/valid/期中/01-课件知识点.md" \
  > outputs/logs/05c_markdown_01_KU-003_lines.txt || true
grep -n 'KU-003' "$TMPROOT/valid/期中/03-知识点地图.md" \
  > outputs/logs/05c_markdown_03_KU-003_lines.txt || true
```

`01-课件知识点.md` 的实际行（第 18 行）显示：

```text
| `KU-003` 二进制、八进制与十六进制互转 | 方法 | 5 星（★★★★★） | … | … | [SRC-C01 · PDF P35](…)：二进制、八进制与十六进制互转：二/八/十六进制按 3 位/4 位分组互转 |
```

该行不再包含 `PDF P34`。`03-知识点地图.md` 只展示关系，`KU-003` 没有关系，因此不出现；其字节级内容未变。

### 7.3 HTML 与画板图

用 Python 从 `知识地图.html` 的 `<script id="map-data" type="application/json">` 中提取内嵌图数据，并读取 `数据/画板图.json`，比对节点 `KU-003`。脚本退出码 0，完整输出 `outputs/logs/05d_consistency_evidence.json`。

关键结果：

```json
{
  "agentGet": {"sourceRefs": [{"sourceId": "SRC-C01", "pdfPages": [35], "visualStatus": "verified"}], "hasPage35": true, "hasPage34": false},
  "markdown01": {"hasPage35": true, "hasPage34": false},
  "html": {"sourceRefs": [{"sourceId": "SRC-C01", "pdfPages": [35], "visualStatus": "verified"}], "hasPage35": true, "hasPage34": false},
  "board": {"sourceRefs": [{"sourceId": "SRC-C01", "pdfPages": [35], "visualStatus": "verified"}], "hasPage35": true, "hasPage34": false},
  "checkSourceHash": "7c34651a36f91c5b8f04d4ccba004c14d3d63127cd86e488083ebd2d3a37d207",
  "consistent": {
    "agentGetMatchesPage35": true,
    "markdownMatchesPage35": true,
    "htmlMatchesBoard": true,
    "sourceHashesEqual": true,
    "noPage34Anywhere": true
  }
}
```

### 7.4 派生文件差异范围

命令与结果（退出码 0，日志 `outputs/logs/06a_derived_diff_summary.tsv`）：

```bash
cmp -s 正式/期中/<file> 有效副本/期中/<file>
```

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `01-课件知识点.md` | DIFFERENT | 仅 `KU-003` 来源页 34→35（`06b_markdown01.diff`） |
| `02-题目知识点映射.md` | same | 无变化 |
| `03-知识点地图.md` | same | 只展示关系，无该单元 |
| `知识地图.html` | DIFFERENT | 内嵌数据仅 `KU-003.pdfPages` 与 `sourceHash` 变化（`06d_html_board_semantic_diff.json`） |
| `数据/画板图.json` | DIFFERENT | 仅 `KU-003.pdfPages` 与 `sourceHash` 变化（同上） |

HTML 与画板图语义差异：

```json
{
  "board": {
    "differences": [
      {"path": ".nodes[2].sourceRefs[0].pdfPages[0]", "before": 34, "after": 35},
      {"path": ".sourceHash", "before": "de3039…58cf", "after": "7c3465…d207"}
    ]
  },
  "htmlEmbeddedBoard": {
    "differences": [
      {"path": ".nodes[2].sourceRefs[0].pdfPages[0]", "before": 34, "after": 35},
      {"path": ".sourceHash", "before": "de3039…58cf", "after": "7c3465…d207"}
    ]
  }
}
```

布局文件在有效副本内与正式文件逐字节相同（`outputs/logs/06c_layout_hash_compare.txt`，`cmp` 退出码 0）。

## 8. 无效关系校验

### 8.1 加入无效关系

在独立无效副本中，从正式数据的 43 条关系追加 `REL-044`，故意省略顶层 `value` 字段。其余字段均为合法值：

```json
{
  "id": "REL-044",
  "fromUnitId": "KU-003",
  "toUnitId": "KU-001",
  "type": "improves",
  "directed": true,
  "sourceRefs": [
    {"sourceId": "SRC-C01", "pdfPages": [20], "visualStatus": "verified", "note": "无效关系测试：故意省略 value"}
  ],
  "view": "main",
  "status": "approved"
}
```

加入脚本退出码 0；无效数据 SHA-256 由 `86d0ef…1bf` 变为 `e482c5…99f`；关系数 43→44。完整输出 `outputs/logs/07a_invalid_setup.log`，数据差异 `outputs/logs/07c_invalid_data.diff`。

### 8.2 实际校验

命令：

```bash
python3.12 "$TMPROOT/invalid/期中/工具/知识地图.py" check --source-only
python3.12 "$TMPROOT/invalid/期中/工具/知识地图.py" check
python3.12 "$TMPROOT/invalid/期中/工具/知识地图.py" build
```

退出状态：

| 命令 | 退出码 | 日志 |
| --- | --- | --- |
| `check --source-only` | 1 | `08a_invalid_check_source.log` / `.exit` |
| `check` | 1 | `08b_invalid_check_full.log` / `.exit` |
| `build` | 1 | `08c_invalid_build.log` / `.exit` |

实际错误输出（`check --source-only`）：

```json
{
  "error": {
    "code": "validation_failed",
    "message": "权威数据校验失败",
    "details": {
      "errors": [
        "关系缺少 value：REL-044"
      ]
    }
  }
}
```

`build` 输出相同的错误，说明校验在写入前就拒绝了无效数据。

### 8.3 构建产物未受污染

- 无效副本：5 个派生产物 + `视图布局.json` 的 SHA-256 清单在测试前后完全相同。对比文件 `outputs/logs/08e_invalid_outputs_unchanged.diff` 的内容为 `invalid derived outputs unchanged: YES`。
- 有效副本：无效测试后再次完整 `check`，退出码 0，日志 `09b_valid_recheck_after_invalid_test.log`。
- 有效副本派生产物：测试前后 SHA-256 清单相同（`09a` 与 `09c`，对比 `09d` 输出 `valid derived outputs stable: YES`）。
- 有效副本查询：`get KU-003` 在无效测试前后字节相同（`09f_valid_query_stable.txt` 输出 `valid copy query unchanged after invalid test: YES`）。

## 9. 操作后正式文件哈希与工具一致性

### 9.1 正式文件

命令（退出码 0）：

```bash
shasum -a 256 \
  "期中/数据/知识地图.json" \
  "期中/数据/视图布局.json"
```

结果（`outputs/logs/10a_formal_hashes_after.txt`）：

```text
86d0ef390cc00efcc41e1abe2f8d10341a59a907ea5cd6f351777a2d6822c1bf  期中/数据/知识地图.json
c9f0f6b75a0e630cf92b34fc5a5c7980ecd3500fb7b3d5085d2de69181322b93  期中/数据/视图布局.json
```

与操作前完全一致。`outputs/hashes.json` 中 `allFormalFilesUnchanged: true`。

### 9.2 正式数据只读校验

```bash
python3.12 期中/工具/知识地图.py check --source-only
```

退出码 0；`sourceHash: de303986…58cf`；日志 `10c_formal_check_source.log`。该命令只读，不写正式文件。

### 9.3 工具文件

```bash
shasum -a 256 正式/期中/工具/知识地图.py 有效副本/期中/工具/知识地图.py \
              正式/期中/工具/地图生成.py 有效副本/期中/工具/地图生成.py
cmp -s 正式/期中/工具/知识地图.py 有效副本/期中/工具/知识地图.py
cmp -s 正式/期中/工具/地图生成.py 有效副本/期中/工具/地图生成.py
```

结果（`outputs/logs/10d_tool_hashes.txt`）：

```text
4eb60ecd72a4d4f5adbf4d933e9a13840c1ee9296ccd6010ff4c167a836227cc  知识地图.py（正式与副本相同）
2b6bf3c281146cee2cbd83d00adbf4a1aec7181d731da158da006e12c3b5b224  地图生成.py（正式与副本相同）
cmp 知识地图.py exit=0
cmp 地图生成.py exit=0
```

## 10. 汇总

| 检查项 | 实际结果 |
| --- | --- |
| 有效页码修改 | `KU-003` / `SRC-C01`：PDF 34 → 35，并同步 `pageCoverage` |
| 修改后 `check --source-only` | 退出码 0 |
| `build` | 退出码 0，生成 5 个产物 |
| 修改后完整 `check` | 退出码 0 |
| 独立 `/tmp` 输出目录 `build` / `check` | 退出码均为 0，5 个产物与副本内构建哈希一致 |
| Markdown 一致性 | `01-课件知识点.md` 显示 `PDF P35` |
| HTML 一致性 | 内嵌节点 `KU-003.sourceRefs[0].pdfPages == [35]` |
| 画板图一致性 | 节点 `KU-003.sourceRefs[0].pdfPages == [35]` |
| Agent 查询一致性 | `get KU-003` 返回 `pdfPages: [35]` |
| 语义哈希一致性 | HTML = 画板图 = `check` = `7c34651a…d207` |
| 无 value 的关系校验 | 退出码 1，`validation_failed`，`关系缺少 value：REL-044` |
| 无效副本 `build` | 退出码 1，未写入派生产物 |
| 无效副本产物是否变化 | 否，前后哈希清单相同 |
| 有效副本是否被无效测试影响 | 否，重新 `check` 退出码 0，产物哈希不变 |
| 最终有效副本 `check` | 退出码 0（`12_final_valid_check.log`） |
| 正式 `知识地图.json` | 前后均为 `86d0ef…1bf` |
| 正式 `视图布局.json` | 前后均为 `c9f0…b93` |
| 工具是否被修改 | 否，正式与副本 `cmp` 退出码 0 |

`total_tokens` 与 `duration_ms`：本次工具调用未返回这两项指标，无法报告。
