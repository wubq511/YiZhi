# Electron / 系统 WKWebView 有界资源实测

2026-10-27，macOS 27.0.1 / 26A434，Apple M5，16 GiB RAM、10 logical CPU。

**三对已完成，但不能据本轮给出前台阅读／负载的框架性能排名。** 两端实际内容视口都稳定为 **1000×700 CSS px、DPR 2、`visibilityState=visible`**，而所有已采样帧的 **`document.hasFocus()` 均为 false**。Electron 使用显式 `backgroundThrottling=false`，WK 使用默认调度；这没有满足预设的前台焦点条件。窗口最初 key/focused=true 不能代替整个采样窗口保持焦点。失焦原因不从这些资源数据中臆断。

统一的 `phys_footprint` 与 CPU 计时本身可用；WK 子进程归属也已确认。下表保留原始观察，避免把执行成功误写成公平性通过。`results.json.failures=[]` 表示 runner 没有异常，**不是验收通过**；`analysis` 将 blank／reading／load 的三对均判为不可比较。原定三对不重跑、不挑最好结果。

本轮能支持的窄结论：关闭学习窗口、销毁 WebView 且宿主仍存活时，Electron 进程组 footprint 中位数为 92.08–96.85 MiB，WK 最小宿主进程组为 49.53–50.55 MiB，三对差值为 46.30、42.55、44.60 MiB。该阶段两端均为零窗口，没有运行后台任务；这只是本机短时关窗后的保留开销，不能替代真实后台核心、完整产品或前台阅读成本。

## 同一原型负载与边界

先阅读旧 `desktop-host-spike/README.md`、runner、Swift 宿主与 renderer 探针，再在此新目录独立实现。没有修改正式 app、`architecture-spike`、旧 `desktop-host-spike` 或其结果；原架构 47 文件、旧宿主 20 文件的前后 SHA-256 清单一致。

使用完全相同的现有 `/?count=500&mode=managed&dynamic=1` 页面与官方 Electron **40.10.6** 缓存。Electron 随包 Chromium **144.0.7559.236**、Node **24.15.0**；WK framework build **22625.1.29.11.28**。Swift/AppKit/WKWebView 是最小原生宿主，**不是 Tauri 完整 app**。

**这测的是相同现有原型负载，不是两条路径各自最小化的正式产品。** `architecture-spike/src/main.jsx:12` 完整 fetch 84 单元 fixture，23–32 行 `structuredClone` 为 500 份完整内容并常驻。`managed` 只缩小 DOM 挂载，没有按需从核心获取正文。每个运行实际有 500 个 article、3 个完整重正文，KU-001 初始正文 2,901 字符。500 份样本不是 500 篇独立编写的课程。按需读取正文可以作为不牺牲内容完整性的后续轻量化方向；本次没有为此改 fixture 或增加对照。

原页面已有常驻 rAF 探针及每秒 DOM 计数，所以“阅读”也是当前原型的空闲阅读状态，不能当成优化后产品的 idle。没有实际 Agent 调用、个人数据库、后台核心实验、完整 Tauri、物理 IME 或新增产品功能测试。没有执行选文测试，因此未注入 `-webkit-user-select` 前缀，也未改临时 HTML/CSS。

## 固定程序

只执行以下预定顺序，总计 6 次宿主运行，约 4 分 50 秒（20:54:38–20:59:28，Asia/Shanghai，含准备与清理）。任何时刻只有一个被测宿主，前一宿主及归属进程退出后才开始下一个。

| 配对轮次 | 顺序 |
| --- | --- |
| 1 | Electron → WK |
| 2 | WK → Electron |
| 3 | Electron → WK |

每次新建 userData/session 或 WK nonpersistent store；loopback 服务独立随机端口，只读提供既有 fixture、bundle、provider、vendor 等 14 个实际访问文件。没有 npm 安装、网络下载或重建原 bundle。

1. 空内容窗口：最小 HTML，等待 2 秒，名义采样 8 秒。
2. 内容阅读：等待 fixture ready、fonts 与相机稳定，再等待 3 秒，名义采样 8 秒。
3. 负载：8 秒内 16 次实际 KU-001 段落补丁，原段落重复倍数 4→19；同一 rAF 上按相同时间函数移动相机，保留逐次应用结果和正文高度。两端全部 16/16 应用，同一正文实例保留，挂载重正文数仍为 3。
4. 关学习窗：真实关闭并销毁 WebView，宿主继续存在；等待 2 秒，再名义采样 8 秒，均记录零窗口。

CPU 端点与内存快照均由相同 Python 外部采样器采集。每 0.5 秒尽力轮询，额外保留 begin/end 端点；共 **524 份原始进程快照**，实际间隔及采集开销均有单调时钟。页面阶段外部窗口约 8.03–8.08 秒；关窗 Electron 约 8.07 秒、WK 约 8.46–8.49 秒，包含 native HTTP 回调调度。CPU 按各自**实际外部时长**归一化，不把名义 8 秒当实测时长。

## 口径与公平性

- 内存主指标：所有确认归属 PID 统一调用 `proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint`，单位 byte。SDK struct 字段已核对；没有权限错误或缺失样本。每张快照求进程组总和，再报告阶段中位数／最大采样值。后者不是连续瞬时峰值。
- `phys_footprint` 是内核按 task 记账的 footprint，包含压缩等记账语义，**不是单纯驻留物理 RAM，更不是扣除共享系统服务后的独占增量**。共享 WindowServer、驱动、OS 服务未分摊给任何一端。
- `ps RSS` 仅作辅助原始值。总 RSS 会重复计入共享页，不可把它解释为真实物理内存需求；也不能拿 Electron RSS 与 WK footprint 混比。
- CPU：每 PID 的 `ri_user_time + ri_system_time` 增量，经本机 Mach timebase **125/3 ns per tick** 换算，再求归属进程总和／外部实际 elapsed。**100% 代表一个逻辑核**。实测校准 `time.process_time` 增量 **0.199935 秒**，换算后的 rusage 增量 **0.199935208 秒**，比例 **1.000001042**，故单位换算成立。若校准偏差超过 2%，分析器会禁止 CPU 比较。各阶段归属进程集合均稳定，没有靠漏掉退出 PID 降低 CPU。
- Electron：进程树递归确认 Browser/GPU/Network utility/Renderer，关窗后前三者仍在。`getAppMetrics()` 的 PID/type/memory 原样保存，仅作辅助。它的 CPU lifetime、resident/private/shared memory 等字段不是跨引擎 `phys_footprint` 口径，本轮没有据此排名，也没有把 JS heap 当完整内存。
- WK：XPC 子进程 `PPID=1` 时不能靠父子树计数。用系统 `responsibility_get_pid_responsible_for_pid` 与独立 LaunchServices 宿主 PID 相等确认；原始数据保留每次所有 WebKit 候选、responsible PID、preexisting 与 included。三次均明确计入 WebContent、GPU、Networking，关窗后宿主与自己的 GPU 留存。12 个预先存在的用户 WebKit 进程全部排除，没有归属不明的新 WK/GPU 进程被默算为 0。该责任归属接口为 macOS 私有诊断接口，不能当作正式产品的稳定 API。
- 每一 rAF 样本保留真实 viewport/DPR/visibility/focus，另有阶段前后状态、原生 bounds/key、visibility/focus 事件与原始间隔。**全部采样帧均失焦**，不是字段缺失或只在一帧发生偏差。两端 observable focus 同为 false，但 Electron 关闭后台节流而 WK 默认调度，故不据此前台性能排名；也不把两端未聚焦的调度策略假定相同。
- rAF 是回调间隔，不是屏幕实际呈现 FPS 或输入延迟。负载 WK 每轮 416 回调，Electron 为 476/480/481；全部正文补丁应用并不消除焦点／调度差异，不能据此判流畅度优劣。
- 本机其他用户应用保持存在，只排除它们的进程记账，没有声称整个系统空闲、冷缓存、热状态一致或三对有统计显著性。

## 保留观察值（前三阶段未通过前台条件）

MiB = 2^20 bytes；每格为阶段进程组 `phys_footprint` **中位数 / 最大采样值**。前三阶段仅作本轮未聚焦观察，**不可据表排序前台产品**。关窗列仅表示上文限定的短时保留成本。

| 运行 | 空窗口 MiB | 内容阅读 MiB | 增长＋相机 MiB | 关窗 MiB |
| --- | ---: | ---: | ---: | ---: |
| r1 Electron | 85.11 / 85.36 | 260.83 / 300.10 | 631.12 / 652.55 | 96.85 / 96.99 |
| r1 WK | 69.35 / 112.53 | 290.12 / 290.19 | 382.24 / 398.74 | 50.55 / 50.66 |
| r2 WK | 70.52 / 113.89 | 292.68 / 293.21 | 369.95 / 394.58 | 49.53 / 49.67 |
| r2 Electron | 84.05 / 84.36 | 247.91 / 287.82 | 618.17 / 639.21 | 92.08 / 92.24 |
| r3 Electron | 88.75 / 89.24 | 255.53 / 294.47 | 625.27 / 634.74 | 94.68 / 94.82 |
| r3 WK | 70.90 / 113.86 | 290.74 / 291.21 | 373.35 / 386.18 | 50.08 / 50.24 |

CPU 为按上述外部端点计算的单核百分比，同样保留而不作前三阶段排名：

| 运行 | 空窗口 CPU % | 阅读 CPU % | 负载 CPU % | 关窗 CPU % |
| --- | ---: | ---: | ---: | ---: |
| r1 Electron | 3.20 | 6.53 | 61.57 | 0.68 |
| r1 WK | 4.48 | 8.96 | 53.04 | 0.09 |
| r2 WK | 4.29 | 8.99 | 53.26 | 0.08 |
| r2 Electron | 3.04 | 7.09 | 61.60 | 0.59 |
| r3 Electron | 3.16 | 6.82 | 63.57 | 0.72 |
| r3 WK | 4.21 | 8.49 | 51.95 | 0.07 |

因此，本轮**不能回答哪个框架在公平前台条件下读取这 500 单元更省内存／CPU或更流畅**。磁盘差异与关窗后进程留存已有窄证据；前台选择仍缺公平条件下的证据，不能由负载中更大的某个数直接拍板。

## 实测磁盘：运行时与下载分开

| 对象 | 本机实测 | 解释 |
| --- | --- | --- |
| 官方 Electron ZIP 下载缓存 | **114,353,947 bytes（109.056 MiB）** | 原缓存只读复制；原缓存未删除／更改 |
| 展开 `Electron.app` | **271,600,117 logical bytes（259.018 MiB）**；`du -sk` 为 266,092 KiB | 不含 ZIP、不含 app 外的 release license 文件 |
| 完整展开 release（app＋随包 LICENSE、version、Chromium notices） | **287,317,180 logical bytes（约 274.007 MiB）**；regular files 分配 288,202,752 bytes | 排除下载 ZIP；分配数不含目录／文件系统元数据，非通用安装体积 |
| Swift 最小 WK `.app` | **143,951 logical bytes**；`du -sk` 148 KiB | 本次编译参数下的小宿主，不是 Tauri 包体，也未内含课程／后台核心 |
| 系统 WebKit | **独立可归属 runtime 体积未知** | 可遍历 framework 文件逻辑总量 7,012,700 bytes；该路径 `du` 报 0，涉及系统重定向／共享缓存，不能把这两个数当 WebKit 全运行时体积，更不能记为 0 资源 |

WK 依赖 OS 安装的 WebKit／共享库／dyld shared cache，这些已有磁盘和运行时资源，没有被打入小宿主包，不表示消失。本轮没有分摊整套 OS shared cache。双方均不是正式完整产品包体；不据这些数字推导完整下载／安装／更新成本。

## 文件、原始数据与复现

- `run.py`：独立只读服务、官方 ZIP 校验／展开、Swift 编译、固定三对、有界超时、统一跨 PID 采样及清理。
- `electron.cjs`／`wk.swift`：各自的最小可见宿主；不启动 worker 或后台核心。
- `renderer.js`：两端同一段页面阶段、确定性增长／相机和逐帧条件记录。
- `results.json`：全部原始 524 快照、事件／rAF／负载、进程命令与排除项、执行输出、磁盘值、源码与 fixture hashes；`analysis` 单独解释公平性，原始采集字段保留。命令行摘要不打印整段原始进程表。
- `analyze.py`：只读重新计算公平性；`--save` 将分析追加回同一结果，校验源保留。`audit.py`：仅核对源码／旧目录、专用 PID／端口、保留 runtime 与磁盘补充。
- `focus.py`、`focus.swift`、`focus-electron.cjs`／`focus-diagnostic.json`：在原三对之后，经用户单独允许的短焦点诊断；与资源结果分开，不将旧失败改为通过。

复现资源实验须显式重新安排独占测量窗口；以下命令会运行**新**三对并覆盖本目录 `results.json`，不应当作为“修复失败”的自动重试：

```sh
python3 run.py --retain-runtime
python3 audit.py
python3 analyze.py --save
```

无 npm／Rust／Tauri 依赖；需要当前 macOS 的 CLT/Swift、Python 3 和现有官方 Electron ZIP。`--cache /absolute/path/electron-v40.10.6-darwin-arm64.zip` 可指定只读源缓存，必须匹配锁定 SHA-256。省略 `--retain-runtime` 时会清理自己创建的整个临时目录。不要删除用户原缓存。

关键 SHA-256：

```text
Electron official ZIP  24e3b1a13ff7243f6b9036ebb743b6f62b19e4a925242d27eaa2be90de90a691
fixture.json          ff896778b0ff0d81be6a5859c86746fa04ddc89dd6397cf870aa9b29c325ae4b
src/main.jsx          b09584560822405d6d4aca1d9295e6f2fa8399540b782099660340f4520a80ed
dist/app.js           09d2dceb53d0c1ddbb0d2f83578ed8ec64c852ef5b1f66264692dc4e1069448f
dist/app.css          b03dd66938a9e9ea0b9fd405cb3880a3db6f6d03ece76f2e854ff8a12304af50
```

`hashes.experiment` 保留采集结束时源码 hashes；实际采集用的四个文件均在 `postMeasurement.collectionSourceHashes` 复核一致。后处理分析器改进与原采集脚本分开记 hash，`analysisMetadata.rawEvidenceCanonicalSha256` 绑定原始数据字段。

## 清理与 runtime 交接

已关闭全部六次专用宿主与确认归属进程；每轮没有残留，再启动下一轮。`audit.py` 复核旧 PID/start identity 均已消失、专用端口已关闭、userData/session/logs 与 Swift 编译缓存／最小宿主二进制全部删除。旧实验依赖、用户浏览器和原官方缓存未动。

按用户追加授权，**仅以下专用 runtime 及复制的 ZIP／许可留存**，供 `core-placement-spike` 只读复用，依赖 owner 仍为本实验，等待主 agent 通知后清理。该留存是明确的清理待办，不声称已全部删除：

```text
/var/folders/nn/s5g8qnt93l30cz_m3svlc3gm0000gn/T/desktop-resource-4fefz5ln/runtime/
/var/folders/nn/s5g8qnt93l30cz_m3svlc3gm0000gn/T/desktop-resource-4fefz5ln/runtime/Electron.app/Contents/MacOS/Electron
```

本地实验源码／README／原始结果留在此目录；临时依赖不混入这里。后续共同可见未聚焦或真正前台场景若另获授权，必须独立记录调度设置与结果，不能覆写本轮失败。
