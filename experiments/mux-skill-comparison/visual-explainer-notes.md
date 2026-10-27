# visual-explainer：同题 MUX 交互演示

已按官方 kit 生成原生源文件与渲染 HTML；纯逻辑枚举 **8/8 通过**。主线程已用 CUA 实际打开页面并点击全部 8 组输入：输出、选中端、分组高亮及说明同步正确；已查看电路与前置关系布局。标题宽度已修正并复验。证据见 `browser-verification.json` 和 `visual-explainer-preview.png`。

## 文件与内容

- [源文件 visual-explainer-mux.src.html](visual-explainer-mux.src.html)
- [正式 kit 渲染页面 visual-explainer-mux.html](visual-explainer-mux.html)

唯一课程内容输入为同目录 `brief.json`。嵌入页面的 JSON 已与输入做深度相等检查；函数、选择端、四个数据端、四组取值、四概念三条关系、结论及来源均保留。输入文件 SHA-256：`037f8e3a2d97fe28940a5187959351fb2cc4aa64234700878b11593729f91a3d`。

页面使用 `blueprint` register、官方 `.ve-svg` / `.ve-n` / `.ve-e` / `.cases` 与 kit tokens。三个按钮切换 x/y/z；纯 `model(settings, brief)` 实时计算选中端及 F，联动输入值、当前路径、输出、四组结果中的当前组和说明句。没有定时播放或装饰动画。初始状态为 `xyz=010`，选中 `I1=¬z`，`F=1`。

下方保留原四概念及三条边：真值表 → 按选择变量分组（分组取值）；按选择变量分组 → 用 MUX 实现函数（确定数据端）；MUX 选择规则 → 用 MUX 实现函数（确定选择端）。来源原文保持可见。

## 使用的官方版本与文档

- Clone：`/tmp/mux-visual-explainer`，留给主线程清理。
- 上游 commit：[`5f378868e0ea745a6284b51e710c390f0c76f72c`](https://github.com/nicobailon/visual-explainer/commit/5f378868e0ea745a6284b51e710c390f0c76f72c)，技能 metadata 版本 `0.14.0`。
- 完整阅读：`plugins/visual-explainer/SKILL.md`；必要 refs：`kit.md`、`style-guide.md`、`diagrams.md`、`motion.md`。
- 读取了 CLI `--help` 显示的 usage，其中有正式 `--no-check` 选项。没有读取 kit CSS/JS/MJS 源码，没有修改工具；clone 的 `git status --short` 为空。
- 本分工未创建 Git commit；此处 commit 指使用的上游版本。

## 正式生成命令

```bash
node '/tmp/mux-visual-explainer/plugins/visual-explainer/kit/render.mjs' \
  '/Users/robertwu/Documents/大二上/数字逻辑与部件设计/docs/复习工具调研/04-演示/mux-skill-comparison/visual-explainer-mux.src.html' \
  -o '/Users/robertwu/Documents/大二上/数字逻辑与部件设计/docs/复习工具调研/04-演示/mux-skill-comparison/visual-explainer-mux.html' \
  --no-check
```

退出码 `0`；渲染器报告 `kit inlined`、`Page: 3 figures · 25 prose words outside figures`。源文件为 15,323 bytes，渲染 HTML 为 61,986 bytes。未使用 `--open`，未运行 Playwright、headless 或其他浏览器自动化。

## 模型验证与浏览器验收

通过 Node `vm` 执行**页面自己定义的纯模型函数**，将全部输入与 `brief.function` 的最小项集合、`brief.groups` 两个依据分别比较；同时核对选中 I 端。验证结果：

| xyz | 选中端 | F | 最小项预期 |
| --- | --- | ---: | ---: |
| 000 | I0 | 0 | 0 |
| 001 | I0 | 1 | 1 |
| 010 | I1 | 1 | 1 |
| 011 | I1 | 0 | 0 |
| 100 | I2 | 0 | 0 |
| 101 | I2 | 0 | 0 |
| 110 | I3 | 1 | 1 |
| 111 | I3 | 1 | 1 |

另外已检查：两个自有脚本语法有效；源文件 ID 唯一；源文件没有 HTML 注释；正式输出保留原 brief 与两个自有脚本，且 kit 标记已被替换。未检查或输出 kit CSS/JS 实现。

以上是独立模型检查；主线程随后另以 CUA 完成真实浏览器验收，使用按钮 `#toggle-x`、`#toggle-y`、`#toggle-z` 覆盖全部组合，确认 `#output-value`、`#selected-route`、`#selected-note`、`#live-result` 与 `[data-group][data-active="true"]` 同步；并查看四组结果、四节点关系与来源可读性。页面有静态初始图作为无 JS 时的内容，但交互需要正常执行脚本。

本次只创建本目录的 `visual-explainer-mux.src.html`、`visual-explainer-mux.html` 和本记录；没有修改 brief、其他工具产物或总报告，没有全局安装或发布。

临时 clone 已在交付收尾时删除；复现前按上游固定 commit 重新 clone 到文中路径。
