# macOS 桌面宿主隔离实验

2026-10-27。独立桌面交付已接受，Electron／Tauri **尚未选定**。本目录只验证宿主能力，复用相邻 `architecture-spike` 已构建的 `500 / managed / dynamic=1` 页面。500 个对象由 84 个真实课程单元复制生成，不是 500 份独立编写的课程。没有重建或修改原 source／bundle，没有重跑旧四基准、26 项动态检查或七秒性能基准，没有写入正式课程或私有状态。

**结果：Electron 最终轮 8/8 正文检查、5/5 宿主检查通过；WKWebView 原样页面 7/8，通过临时 CSS 诊断定位到一项选文兼容差异，仍保留原样路径失败。** 这支持继续桌面验证，不足以选定框架或宣称性能胜出。原 `architecture-spike` 全部 47 个文件收尾哈希一致，依赖、运行时、临时数据与专用进程已清理。

| 可外部核对的项目 | 最终观测 |
| --- | --- |
| 正文实际挂载 | 500 个 article，3 份完整重正文，正文增长期间保持同一实例 |
| 自然高度与 RO 投影 | KU-001 约 2,149.27 → 材料展开 2,608.26 → 增长 4,413.48 → 最终 5,182.91 画布 CSS px；四个保留阶段均 0 重叠 |
| MathLive 编辑 | `x+1+2`，增长前后 DOM／焦点／光标保持；Electron 合成字符后实际为 `x+1+27` |
| 正文非空选文 | Electron 保留“位置记数法（positi”，Text 身份和 y=294.07px 不变，释放后补丁应用 |
| 小量并发更新 | Electron 八次实际段落补丁、58 次相机回调，目标正文未卸载，结束无布局 pending；相机阶段含收尾约 1.37 秒，仅作负载有效性证据 |
| 真正关窗后的任务 | 窗口 1 销毁、窗口数 0，同一 worker tick 59 → 72；窗口 2 通过只读 IPC 取得 tick 73，starts 始终为 1 |
| 明确退出 | 等待 worker 正常退出；外部进程探测确认 worker 与能力核查 utility 均已不存在 |
| WK 原样选文 | Range 有文字，Selection 返回空；临时增加 `-webkit-user-select:text` 后 Selection 返回同一真实文字 |

本轮未验证物理中文 IME、真实触控板、物理键盘／鼠标手感、跨平台、正式持久恢复或性能优劣。

## 证据与执行条件

- [results.json](results.json)：最终机器结果，含每阶段 500 个真实 article 的 DOM 矩形、重叠、正文变化、焦点／选区、相机、宿主生命周期、完整版本、进程输出和 SHA-256。
- [runtime-integrity.json](runtime-integrity.json)：Electron 40.10.6 官方发布压缩包与 npm 包内校验表相符，SHA-256 `24e3b1a13ff7243f6b9036ebb743b6f62b19e4a925242d27eaa2be90de90a691`。只读复制已有下载缓存到本目录安装，未使用 Codex.app 二进制。
- [setup-attempt.json](setup-attempt.json)：首次未下载运行时而缺少 `path.txt` 的真实失败。查询时 npm 最新版本为 45.0.0；该包没有 postinstall，需显式安装器。显式下载未在本次预算内完成，因此取消，改用已缓存的 40.10.6。没有取得 45 的运行结果。
- [initial-observation.json](initial-observation.json)：第一次真实窗口观察，`backgroundThrottling:true`。保留相机 rAF 为 0、合成字符未进入 MathLive 等失败；原选文断言曾误把 WK 的空选文当通过，**该项无效**，最终探针已要求非空选文。
- [focused-observation.json](focused-observation.json)：补充焦点、关闭后台节流后的中间观察。还包含探针残留单元编辑焦点导致延迟补丁未释放的失败；最终脚本先把焦点移到工具栏，再进行正文选文／释放检查。
- [wk-recheck.json](wk-recheck.json)：最终一次仅 WK 的抽查与 CSS 诊断。主 runner 在把 `TMPDIR` 指向项目内目录后，Swift 编译收到 `SIGTRAP` 且无诊断文本；随后仅使用专用短路径临时目录重编译成功，没有重跑 Electron，也没有确定 SIGTRAP 根因。失败原样保留在 `results.json.wkCompilation`，成功复查在 `wkRecheck`。最终 `run.mjs` 已改为相同短路径策略；`executedRunnerHash` 保留 Electron 那轮执行时 runner 的 hash，`finalScriptHashes` 列出交付脚本 hash，Electron 宿主／renderer 脚本在此后未改。

每次使用新建 `userData`／session 目录和随机 loopback 只读文件服务。服务启动相邻原 `start.py`，不连接已有 8772，不接管用户浏览器。HTTP 仅为复用既有内容，**不决定正式产品使用 HTTP、IPC 或自定义协议**。任务状态通过另一条受限 IPC 验证。

宿主环境：macOS **27.0.1 / 26A434**，Apple Silicon / Apple M5；Electron **40.10.6**，Chromium **144.0.7559.236**，随包 Node **24.15.0**；Swift **6.4**，系统 WebKit framework bundle **22625.1.29.11.28**、短版本 **22625**。完整 UA 另见机器结果；不能把 UA 中兼容性字符串 `605.1.15` 当作实际 framework 构建版本。

两条路径均创建真实可见原生窗口，无 headless。请求内容尺寸 1440×1000，最终 Electron 实际为 **1249×810 CSS px**，最终 WK 为 **1440×810 CSS px**，均 **DPR 2**；本机窗口条件导致实际大小与请求不同，记录保留实际 bounds，亦不满足同视口性能对比条件。前两次 WK 曾为 1249×810。没有假报成旧 headless 基准的 1440×1000 / DPR 1。窗口 isVisible、isKey／focused 与 document.visibilityState 不是同一条件；均以实际记录解释。

Electron 最终轮显式激活 app／BrowserWindow／webContents，并设置 `backgroundThrottling:false`。第一轮与最终轮同时改变了焦点和节流条件，**不能将差异单独归因给其中之一**，更不能拿它做性能比较。第一轮仅记录了起始 visibility，不能断言全过程始终可见；最终轮额外记录相机期间的 visibility 事件。

## 实际验证范围

正文仍由原 `ReviewContentProvider` 渲染，不替换成占位卡片。探针检查 500 个实际 article，阅读景只挂载少量完整重正文；保存首段真实文本、字符数和真实矩形。材料展开调用原生 `HTMLSummaryElement.click()`；更新通过既有 probe 修改真实段落并触发 ResizeObserver 投影，检查所有 article 的真实矩形，而非只检查布局变量。

MathLive 先经其 API 写入 `x+1+2`，检查可编辑、DOM 身份、焦点、光标 selection 与增长后的状态；Electron 另经 `webContents.sendInputEvent` 发送合成字符 `7`，检查实际值变化。正文选文采用 Text／Range，必须有非空 `Selection.toString()`，同段修改期间保留原 Text 与选文，结束选区后核对延迟补丁真正进入 DOM。最后仅做八次正文更新和少量持续相机移动，记录实际相机与正文结果，**不是 FPS、输入延迟或资源基准**。

本场景不额外导航去覆盖图片／PDF／复杂实验。初始目标正文的 `images` 列表为空时，`assetErrors=[]` 只说明原页面 ready 检查没有发现失败，**不能据此宣称图片路径、PDF 并排或所有实验已验收**。

## 关闭、重开与明确退出

主进程仅创建一个确定性 Python worker：每 100ms 前进一步，目标 600 步，`checksum = 17 * tick * (tick + 1) / 2`，只在内存中记录状态，不读写课程。它不是实际生成任务，也不是持久恢复实现。

测试使用真实 `BrowserWindow.close()`，等待 `closed`，确认窗口总数为 0，等待 1.2 秒，核对同一 PID／jobId 的 tick 增长。随后创建不同窗口 ID；preload 只暴露 `getTaskStatus()`，通过 `ipcRenderer.invoke` 读取主进程已有快照，没有 start／restart API。主进程核对 sender 和精确页面 URL，renderer 不获得 `require` 或任意 IPC。重开窗口还将返回的 jobId／tick／starts 实际显示在页面中，[截图](electron-reopened.png)保留外部可见结果。

明确退出调用 `app.quit()`，`before-quit` 等待 worker 的 SIGTERM 收尾；超过 1.5 秒才对该子进程 SIGKILL。外部 Node runner 在宿主退出后再检查 worker PID 已不存在。能力核查用的 utility process 另行结束。不把主进程、窗口或进程状态变量作为进程已退出的唯一证据。

这只证明本次单子进程路径；不证明整个后代进程树、强制杀宿主、崩溃、休眠、断电、升级或跨次应用启动的恢复。关窗后状态保存在仍活着的宿主内存；完全退出后不会自动重建本任务。生产系统仍需持久任务记录、取消与检查点协议。

## 内置 Node／SQLite 独立能力核查

[sqlite-capability.cjs](sqlite-capability.cjs) 同时在真实 Electron 主进程与 `utilityProcess.fork()` 内运行，完整 `process.versions` 分别写入 `electron.nodeCapabilities.main`／`utility`。没有借本机 runner Node 的版本替代随包版本，也没有创建数据库。

| 被测进程 | Node | SQLite | `require('node:sqlite')` | `Database` | `DatabaseSync` |
| --- | --- | --- | --- | --- | --- |
| Electron 主进程（`process.type=browser`） | 24.15.0 | 3.51.3 | 成功 | `undefined` | `function` |
| utility process（`process.type=utility`） | 24.15.0 | 3.51.3 | 成功 | `undefined` | `function` |

导出列表还包括 `StatementSync`、`Session`、`constants`、`backup`。这只证明该随包运行时可加载及实际命名，不能推出性能、存储可靠性或 API 长期稳定性；Node 26.12.1 的文档状态也不能替代本次 Node 24 的运行事实。同步数据库操作将来是否放 utility process，应由课程核心的负载与故障边界决定，本轮没有新增存储实验。

## WKWebView 与下一步判别条件

[wk-host.swift](wk-host.swift) 使用本机现成 Swift／AppKit／WKWebView，非持久 `WKWebsiteDataStore`，加载完全相同 URL 和相同共享探针。没有安装 Xcode／Rust／Tauri。它是 **Tauri macOS 渲染器的风险证据，不是完整 Tauri app 验收**；没有验证 Tauri command、权限、sidecar、打包、窗口生命周期或 Windows WebView2。

原样页面的 WK 正文 `Range.toString()` 有字，`Selection.toString()` 却为空。机器结果保存从段落到 HTML 的 computed style：正文继承 `-webkit-user-select:none`，当前仅有无前缀 `user-select:text` 的覆盖未产生同样效果。最终轮单独记录临时注入 `.unit-body{-webkit-user-select:text}` 后，computed style 变为 `text`，非空 Selection 成功返回“位置记数法（positi”；**原样路径失败检查不因此改成通过**。诊断 CSS 只存在于临时页面，随后移除，未修改原 source／bundle。最终 WK 的相机阶段记录 visible／hasFocus=true，38 次回调、八次正文补丁和结束 0 重叠；这些数字不与 Electron 排名比较。

下一步先在独立渲染候选中核对该前缀覆盖与真正鼠标选文，再覆盖中文 IME、MathLive 复杂光标与输入法、物理触控板、并排 PDF；这些通过后，才值得做完整 Tauri 宿主与 Electron 的等负载离线交付／资源比较。若 WK 缺陷可用小范围兼容补丁消除，应继续保留 Tauri；若仍阻断核心阅读编辑且修复成本高，才形成偏向 Electron 的更强证据。单次相机回调差异不能决定框架。

Windows 确定后续必做，本轮只留设计边界：课程数据／任务身份不携带平台 PID 或绝对路径；窗口、数据位置、快捷键与工作进程结束由平台宿主处理。当前 SIGTERM 实验不能直接移作 Windows 终止语义。后续须真实验证 WebView2 或所选 Electron、中文 IME、Windows worker 树终止、课程路径／锁、安装更新与跨平台课程迁移；本轮没有实现或宣称跨平台通过。

## 复现与文件

在本目录运行，所有依赖／下载缓存／安装临时目录均在本目录；固定 Electron 40.10.6 使用其 postinstall 下载运行时：

```sh
mkdir -p .install-temp
TMPDIR="$PWD/.install-temp" ELECTRON_CACHE="$PWD/.runtime-cache" \
  electron_config_cache="$PWD/.runtime-cache" npm_config_cache="$PWD/.npm-cache" \
  npm ci --no-audit --no-fund
npm run probe
```

只复查 WK 而不安装或重跑 Electron：`node wk-recheck.mjs`，结果另存；原样选文阻点仍会使其非零退出。该脚本不自动更新主结果聚合。

若有该官方发布 zip，可只读复制到专用 `.runtime-cache` 的对应缓存子目录；本轮使用这一方式，并额外核对包内 SHA-256。复现无需修改原样例或安装原样例依赖。脚本自带边界时间，失败也保存结果；存在失败 check 时返回非零，WK 失败不会被改写成通过。正常结束会删除本轮 `node_modules`、下载／npm 缓存、编译缓存、二进制、临时 userData／sessionData，并关闭专用服务和窗口。npm 安装阶段若单独失败，残留目录需要同样清理。

- `run.mjs`：独立服务、两个宿主、版本／哈希、退出核验和清理。
- `electron-main.cjs`、`preload.cjs`：窗口／后台任务／有限只读 IPC。
- `renderer-probe.js`：共享真实内容交互检查。
- `worker.py`：确定性模拟工作；`sqlite-capability.cjs`：独立运行时能力核查。
- `wk-host.swift`：最小 WK 兼容性宿主。
- `wk-recheck.mjs`：有界 WK 单独复查，无 npm 依赖。
- `package.json`／`package-lock.json`：仅开发时使用的 Electron MIT 测试依赖，锁文件中的依赖许可为 MIT／ISC／Apache-2.0；未再分发 Electron runtime。实际产品分发仍须保留其及随包第三方许可。
- `electron-content.png`、`electron-reopened.png`、`wk-content.png`：内容／任务面板截图，不能代替 DOM 与进程证据。

实现依据：[Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)、[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/)。这些资料说明接口与渲染器边界，实际结果以本目录机器记录为准。

原 source SHA-256：`b09584560822405d6d4aca1d9295e6f2fa8399540b782099660340f4520a80ed`；原 bundle：`09d2dceb53d0c1ddbb0d2f83578ed8ec64c852ef5b1f66264692dc4e1069448f`。完整 47 文件清单与逐项比对结果见 `hashes.architecture`／`finalSourceVerification`。
