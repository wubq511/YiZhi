# Fireworks：统一 MUX 例题实际演示

已完成原生 Fireworks **JSON → SVG → PNG / 离线 HTML** 流程。内容唯一输入为同目录 `brief.json`，没有更改输入或总报告。图展示四组赋值、MUX 选择机制、三条概念依赖，以及 brief 的结论和来源说明。

## 来源与产物

- Skill：`fireworks-tech-graph`，版本 **1.2.0**，默认 **Style 1 / Flat Icon**。
- 仓库：[yizhiyanhua-ai/fireworks-tech-graph](https://github.com/yizhiyanhua-ai/fireworks-tech-graph)。
- 源码 commit：[1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/commit/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f)；官方 `version` 返回 `modified: false`。
- 本地 Skill：[SKILL.md](https://github.com/yizhiyanhua-ai/fireworks-tech-graph/blob/1ca1ff9cfcb67893a43d32b9ef3a1b782c44a46f/SKILL.md)。完整读取 Skill、Style 1、style matrix、composition contract、layout、visual quality 和 PNG export 相关说明后执行。
- brief SHA-256：`037f8e3a2d97fe28940a5187959351fb2cc4aa64234700878b11593729f91a3d`。

| 文件 | 用途 |
| --- | --- |
| `fireworks-mux.svg` | 1440 × 1040 的语义 SVG；保留文字、节点、边与路由，可继续编辑源码 |
| `fireworks-mux.png` | 2160 × 1560；官方 `export-png` 使用 CairoSVG 生成，已目检 |
| `fireworks-mux.html` | 官方 `export-html` 生成的单文件离线查看器；内嵌 SVG 与脚本 |
| `fireworks-ir.json` | JSON IR，含完整原始 brief、来源 hash、11 个节点、5 条边及版式参数 |
| `fireworks-layout.json` | 官方排版、路由、语义、配色和文字完整性报告 |
| `fireworks-checks.json` | 实际官方命令、退出码与原始结构化返回值 |
| `fireworks-verification.json` | 全部 8 组输入、文字覆盖、字体字形、PNG 尺寸、HTML 静态检查与目检记录 |
| `fireworks-build.py` | 从 brief 重建本组产物的复现脚本 |
| `fireworks-notes.md` | 本说明与工具适配结论 |

## 实际命令与适配

以下均已实际执行；完整绝对路径和返回值保存在 `fireworks-checks.json`。命令在本产物目录运行，`PY` 指 `/tmp/mux-fireworks/.venv/bin/python`，`FW` 指 `/tmp/mux-fireworks/scripts/fireworks.py`；Cairo 动态库使用已有 `/opt/homebrew/opt/cairo/lib`。

```sh
"$PY" "$FW" version
"$PY" "$FW" validate architecture fireworks-ir.json
"$PY" "$FW" render architecture fireworks-ir.json fireworks-mux.svg --report fireworks-layout.json
"$PY" "$FW" check fireworks-mux.svg
"$PY" "$FW" export-png fireworks-mux.svg fireworks-mux.png --width 2160
"$PY" "$FW" export-html fireworks-mux.svg fireworks-mux.html --title '用 4 选 1 多路选择器实现布尔函数'
```

整套复现：在本目录运行 `/tmp/mux-fireworks/.venv/bin/python fireworks-build.py`。脚本设置需要的 Cairo 环境变量，生成 IR，调用官方 CLI，并完成下列文字/逻辑检查。重建会将目检状态重新置为 pending，避免把旧目检冒充为新结果。

临时依赖仅安装于 `/tmp/mux-fireworks/.venv`，pip 缓存也在该 clone 内：CairoSVG 2.9.1、Pillow 13.0.0、fontTools 4.67.0。未永久安装 Skill，clone 保留供主线程清理。

生成后仅做两项 SVG 适配，再运行官方最终检查与导出：

1. 为原生 font stack 优先加入本机 `Heiti SC`，使用已有 `STHeiti Medium.ttc` 简体字面；全部可见字符均在字形表中，中文、`Σ`、`¬` 目检正常。没有替换原生 Style 1 配色或降低字号来隐藏文字。
2. 添加 brief 的原样来源与 `source_note`，使用普通 SVG `text` 和 `desc`。官方导出器不接受 `metadata` 元素，因此完整 brief 保留在 JSON IR；没有修改或放宽官方导出白名单。

## 验证结果

- 官方 `validate / render / check / export-png / export-html` 全部退出 0。
- 官方 `check` 的 **XML、markers、collisions、geometry、composition 五项全部通过**，各项 details 均为空。
- `quality_profile: showcase`：构图分数 100，0 交叉/桥接，最多 1 个弯，最小节点间距 45 px，最小容器留白 20 px。此分数只代表原生构图规则，不是教学准确率或审美评分。
- `text_policy: strict`：`complete_text: true`，无截断。全部 brief 标题、函数、数据端、概念、关系标签、结论与来源说明均在可见 SVG 文字中。
- 单独枚举 `x,y,z` 全部 8 种输入：最小项函数、四组赋值和 MUX 输出 **8/8 一致**，`brief.json` 字节保持不变。
- PNG 已解码并经 `view_image` 目检：中文与技术符号可读，文字无裁切，三条前置关系方向正确，来源说明完整；未以“命令成功”代替目检。
- HTML 静态解析通过，内联 JavaScript 的 `node --check --input-type=module` 通过，没有外部 script/image/link/iframe 资源依赖。**主线程随后用 CUA 实际打开查看器，确认整图显示、放大至 120% 和复位至 100%；没有逐项测试复制、主题及全部导出格式。**

## 工具特有的优缺点与限制

**优势：** SVG 是主产物，JSON 保留内容与布局，方便精确修改；节点、边、端口和路由带语义信息；原生工具能检查碰撞、间距、折弯与文字截断，并直接生成可离线分享的 HTML。本例不需要凭空仿造产品 UI，成图过程可以按脚本复现。

**限制：** 原生模式是通用技术图，当前演示使用 `semantic_profile: generic`。它不理解 MUX 的电气引脚，也不验证课件来源或教学前置关系；所以本图是选择机制与概念依赖说明，不是逐引脚电路原理图。布尔逻辑正确性由独立的 8 输入枚举核对，不能算作 Fireworks 自带能力。原生 HTML 是查看器，并非节点拖拽编辑器；浏览器已实测缩放与复位。

**字体与迁移：** PNG 已固定字形；SVG/HTML 保留可编辑文字但未嵌入字体，换设备会使用字体栈回退，可能产生轻微字宽变化。CairoSVG 依赖本轮补齐在临时环境，源仓库未改动。

临时 clone 与虚拟环境已在交付收尾时删除；复现前按固定 commit 重新 clone 并安装上文依赖。
