# 键盘撤销事实实验

结论：本机 headless Chrome 中，现有 textarea 与 MathLive 的键盘撤销／重做有效，并经 `input` 事件同步样例 localStorage。同对象正文修改、其他对象持续修改这两个组合没有破坏本轮编辑现场。画板移动撤销、自由绘图撤销和应用层统一快捷键路由存在缺口。没有补实现。

这是架构讨论阶段的有界事实实验。仅写本目录，只读复用 `../architecture-spike/` 的现成源文件、构建产物和资源，不重建源、不调用原基准、不连接用户浏览器或旧 8772 服务。

## 实测结果

最终 [results.json](results.json) 的 22 项检查通过。检查中“观察到画板不撤销”通过，表示缺口得到复现，**不表示画板支持撤销**。

| 页面与输入 | 键盘输入后 | ⌘Z 后 | ⇧⌘Z 后 |
| --- | --- | --- | --- |
| 84 个真实单元／KU-001 textarea，初始空串 | `undo84` | 空串 | `undo84` |
| 500 个对象／KU-001 MathLive，初始 `Y=A\overline{B}+C` | `Y=A\overline{B}+C7` | 初始公式 | 加 `7` 的公式 |

500 对象由原有 84 个课程单元复制产生，沿用原页面的独立对象身份。本轮两个页面均使用 `mode=managed&dynamic=1`，分别创建初始 localStorage 为空的隔离上下文，实际 DOM 对象数分别为 84、500。没有把两个编辑器在两种负载下做全排列。

只做两个现场组合：

1. **同对象**：textarea 输入、撤销、重做后，通过已有 `probe.emit(0, text)` 修改 KU-001 第一段正文，再撤销／重做输入。输入 DOM、焦点、光标位置保持，正文补丁实际生效且不会随输入撤销。
2. **其他对象**：MathLive 输入、撤销、重做后，对可见的 KU-002 第一段正文做 8 次递增修改。每次修改后至少等待 100 ms，再读取现场；实际周期还包含采样开销，不声称严格 10 Hz。第 4、6 次更新前分别执行撤销、重做，更新结束再执行一对。全部正文文本与预期相符；MathLive DOM、焦点及相应公式光标保持，撤销／重做返回预期值，其他正文不会因此回滚。

这些正文更新是已有前端 probe 的模拟写入，没有真实 Agent 或课程服务参与；没有模拟直接覆盖正在编辑的 textarea／公式。

## 输入事件与保存

脚本使用 `page.keyboard.type()` / `press()`，没有用 `fill()`、`insertText()`、赋值或 `dispatchEvent()` 制造待撤销的输入，也没有调用 MathLive 的 undo API。鼠标点击取得编辑焦点；MathLive 用 `End` 定位末尾后键入单个 `7`。

- textarea 观察到原生 `beforeinput` / `input`，`inputType` 包含 `insertText`、`historyUndo`、`historyRedo`，`isTrusted=true`。
- MathLive 0.111.1 观察到相同三种 `inputType`，由组件发出的输入事件 `isTrusted=false`；这是组件对键盘操作的事件表达，不是脚本伪造输入事件。完整按键和事件记录保存在 JSON。
- 每个已记录 `input` 分发后的编辑器值均等于对应 localStorage 草稿值，包括撤销为空串。观察器只记录事件及 `Storage.setItem` 调用，不取消事件、不执行编辑命令；`setItem` 包装器先调用原方法再记录。
- 84 页共 11 次 `setItem`（含同对象正文补丁），500 页共 15 次（含 8 次其他正文更新）。源码每次序列化当前 `saved` 并覆盖同一 key，并没有因此获得版本历史。逐次写入的 UTF-8 文本长度保留在 `writes[].bytesUtf8`；这不是浏览器实际占用、配额或写入成本测量。

**这里验证的是当前编辑实例的短期撤销，不是历史版本恢复。** localStorage 保存的是样例最新状态；不能当作 CourseService、历史仓库或正式持久化验收。本轮不检查刷新、卸载重挂后 Undo 栈是否保留，也不覆盖另一 agent 的历史数据实验。

## 画板缺口与源码证据

500 页实际鼠标拖动 KU-001：基线从 `(0, 0)` 变为约 `(55.7143, 30)`。随后点击画板空白，确认焦点为 `BODY`，执行 ⌘Z、⇧⌘Z，基线均仍是拖后位置。不是用 `probe.moveNode` 代替真实拖动。

- `architecture-spike/src/main.jsx:334`、`:335` 把拖动交给布局对象；`src/dynamic-layout.js:51`、`:55` 更新位置基线，没有旧位置栈及撤销／重做入口。
- 检查 `main.jsx`、`dynamic-layout.js` 与 `复习画板/web/content/provider.js` 后，没有发现应用层 Undo/Redo 命令或键盘路由。`results.json.sourceAudit` 保留搜索范围、匹配结果和关键源码行。空关键词结果与实际读源码结合判断，不宣称 bundle 内第三方编辑器没有自己的快捷键。
- `provider.js:138` 的 `drawing()` 及 `drawMux`、`drawDecoder`、`drawKmap` 是课程 SVG 图示渲染，不是画板自由绘图操作。当前页未提供可进行绘制／撤销的笔迹编辑流程，因此**绘图撤销未实现、未做动态验收**，没有为了让实验通过新增功能。

## 环境、隔离与边界

实测环境：macOS / arm64，Node v26.0.0，已安装 Google Chrome 156.0.8078.48，复用工作区运行时的 `playwright-core 1.62.1`。`package.json` 和 `package-lock.json` 锁定同一版本；此次只生成锁文件，没有安装依赖或下载浏览器。

`serve.py` 以 `127.0.0.1:0` 启动专用只读 HTTP 服务，由操作系统分配随机端口。Chrome 独立启动，页面另建隔离上下文；不使用 CDP 连接用户浏览器。profile、下载目录、trace 目录与缓存位于本目录 `.runtime/`。每轮 `finally` 关闭上下文、Chrome、服务器，验证端口不可连接并删除 `.runtime/`。最终请求均是发往专用 origin 的 GET，没有课程写请求。

**键盘合成输入不是物理键盘或原生中文 IME。** `isTrusted=true` 也不能改变这一边界。本次只输入 ASCII，未验证候选窗、组合输入、真实触控板、复杂公式或多步编辑分组策略。textarea 原生撤销不能充当正式富文本验收。

本机实际测试的是 macOS 的 ⌘Z / ⇧⌘Z。脚本在非 macOS 下选择 Control+Z / Control+Shift+Z 方便复现；本轮没有 Windows／Linux、Control+Y 或跨浏览器结论。

本实验没有采集 FPS、耗时分位数或 Undo 存储增长，没有性能阈值，也不据此推断正式应用的性能、存储预算或 Undo 架构。

## 失败记录

[first-run-results.json](first-run-results.json) 保留首轮原始结果和当时的脚本 SHA-256：[first-run-failure-84.png](first-run-failure-84.png) 是对应现场。首轮 18 项检查中有 1 项失败：84 页控制台出现一次 `Failed to load resource: net::ERR_CONNECTION_RESET`；当时所有输入／撤销／重做行为检查通过，500 页无错误。首轮尚未记录请求失败 URL，**无法精确归因**。

随后仅调整本目录的实验服务监听 backlog（Python 默认 5 → 128），补充失败请求 URL、控制台位置、origin 与逐事件同步检查，并在原有 8 次更新内加入流中撤销／重做。复核无连接错误。最后修正源码函数匹配中的缩进处理，再保存最终一轮结果；没有扩展页面矩阵或重跑旧基准。连接错误没有复现不等于已证明其根因。原样例及其资源未改。

## 复现

保留原项目目录关系，在本目录运行：

```sh
node probe.mjs
```

默认优先复用本目录已安装的 `playwright-core`，否则复用本机 Codex 工作区运行时；也可指定已有包与 Chrome：

```sh
PLAYWRIGHT_CORE_PATH=/absolute/path/to/playwright-core \
PROBE_CHROME='/absolute/path/to/Chrome' node probe.mjs
```

脚本检查 Playwright 版本必须为 1.62.1。另一机器没有可复用包时，只在本目录安装锁定包，不下载浏览器：

```sh
npm ci --ignore-scripts --no-audit --no-fund --cache .cache
node probe.mjs
rm -rf node_modules .cache
```

运行会覆盖本目录 `results.json`；不会改原样例。正常退出自动清理 `.runtime/`；若人为强杀进程，先按输出／系统进程确认并关闭该次专用 Chrome 与服务，再删除本目录遗留 `.runtime/`。不要清理用户浏览器。

## 完整性与留存

`results.json` 记录页面入口、`src/main.jsx`、布局源、`dist/app.js` / `app.css`、原 `dynamic-probe.mjs`、课程副本等原样例全目录文件，以及外部 provider／MathLive 引用文件的运行前后 SHA-256，共 51 个文件，全部一致。另记录本实验 `probe.mjs`、`serve.py`、包清单与锁文件 SHA-256。

核心原 bundle SHA-256：`09d2dceb53d0c1ddbb0d2f83578ed8ec64c852ef5b1f66264692dc4e1069448f`。源码／bundle 一致性在此指本轮前后字节未变，没有重新构建以声称源产物可重现。

保留可复现脚本、本说明、锁定包版本、最终结果及必要首轮失败记录。`node_modules`、安装缓存、临时上下文和专用进程均已清理。此目录不包含生产 Undo 方案。

迁入 YiZhi 后，`probe.mjs` 优先从常规依赖解析 Playwright；没有本地安装时可通过 `PLAYWRIGHT_CORE_PATH` 指定现有 `playwright-core` 包入口。
