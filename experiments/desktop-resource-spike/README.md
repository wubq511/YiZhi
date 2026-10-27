# Electron / 系统 WKWebView：500 单元原型资源实测

2026-10-27，macOS 27.0.1 / 26A434，Apple M5，16 GiB RAM，10 logical CPU。

**同条件补测已得到明确取舍，不能把 WK 的较小体积／较低负载占用直接当成等效果胜出。** 在当前同一原型中，静态阅读反而是 Electron 的短时 footprint 与 CPU 更低；增长＋相机阶段 WK footprint 更低，但每轮都有 16 个超过 50ms 的 rAF 间隔，P99 为 91–92ms，Electron 同阶段 P99 约 17.6–17.7ms、没有超过 33.4ms 的间隔。若要求保持该负载下的连续交互效果，当前证据偏向 Electron 的回调长尾表现；不能仅凭 WK 较小的宿主或较低 CPU 选型。rAF 不等于实际呈现帧、硬件 FPS 或物理输入延迟。

正式比较仅使用 [results-v2.json](results-v2.json) 的 **3 对／6 运行**。每个前台阶段开始前只激活一次，500ms 后连续三次检查稳定，再开始采样；中途焦点／视口／可见性变化会立即记录失败并结束该次运行，不自动重新抢焦点。Electron 使用默认 `backgroundThrottling=true`，WK 使用默认调度。全部 **18 个阶段就绪检查、8,451 个 rAF 状态样本**均满足 **1000×700 CSS px、DPR 2、visible、hasFocus=true**，全部正文更新实际应用。没有补测后的追加轮次。

## 真实内容与结论适用范围

这是**相同现有原型负载，不是两条路径各自最小化的正式产品**。复用现成的 `/?count=500&mode=managed&dynamic=1`，没有重建或改动原 fixture、HTML、CSS、bundle、provider 或正式 app。先读旧 desktop-host-spike 的 README／runner／Swift 宿主／探针再独立实现；旧架构 47 文件、旧宿主 20 文件的前后 SHA-256 清单一致。

`architecture-spike/src/main.jsx:12` 完整 fetch 84 单元 fixture，23–32 行 `structuredClone` 为 500 份完整正文并常驻。`managed` 只减少 DOM 挂载，**没有按需从核心读取正文**。每次实测 500 个 article，3 个完整重正文，KU-001 初始正文 2,901 字符。500 份样本由 84 份真实课程派生，不是 500 篇独立编写的课程。按需读取正文可作为不牺牲内容完整性的轻量化方向，本次没有改 fixture 增加对照。

原型已有常驻 rAF 探针与每秒 DOM 计数，阅读阶段是该原型的空闲阅读状态，不能当优化后产品的 idle。没有真实个人 DB、Agent 调用、后台核心、完整 Tauri、物理 IME 或额外产品功能测试。没有做选文，本次未注入 `-webkit-user-select` 或任何兼容 CSS。

Electron **40.10.6**／Chromium **144.0.7559.236**／随包 Node **24.15.0**，来自校验过的现有官方缓存，不使用 Codex.app。系统 WK framework build **22625.1.29.11.28**；Swift/AppKit/WKWebView 是最小宿主，**不是 Tauri 完整 app**。

## 同条件补测结果

以下为每次约 8 秒阶段的**进程组 footprint 中位数**，范围表示三轮各自的中位数范围；CPU 是一个逻辑核的百分比（100% = 一核），按实际外部端点时长计算。更完整的每轮中位数／最大采样值／原始进程值在 JSON；最大采样值不等于连续瞬时峰值。

| 阶段 | Electron footprint MiB | WK footprint MiB | Electron CPU % | WK CPU % |
| --- | ---: | ---: | ---: | ---: |
| 空窗口 | 84.33–84.59 | 70.31–74.05 | 3.50–3.79 | 5.89–6.16 |
| 内容阅读 | 247.87–251.60 | 285.03–297.57 | 7.06–7.89 | 11.03–11.78 |
| 正文增长＋相机 | 609.74–615.48 | 391.07–397.69 | 61.95–64.75 | 50.29–50.99 |
| 关学习窗口、宿主保留 | 86.85–89.44 | 48.77–49.55 | 0.09–0.55 | 0.07–0.08 |

阅读阶段 Electron footprint 每对低 33.44–47.09 MiB；增长＋相机阶段则每对高 212.05–222.25 MiB，最大采样 footprint 为 Electron 630.60–643.02 MiB、WK 409.05–424.91 MiB。**不能用空宿主尺寸推导真实页面成本，也不能只看内存而忽略效果。** 这些是短窗口内核记账观察，尚不能推出长期稳态、泄漏、GC 根因或各自最小化产品的占用。

关窗后两端均销毁学习 WebView 并记录零窗口，未运行后台任务；Electron 留下 Browser/GPU/Network utility 三进程，WK 留下宿主和自己的 GPU 两进程。此列仅说明短时保留开销，不替代后台核心放置实验。

### rAF 长尾，不能只看 P95

增长＋相机期间三轮各 16 次段落更新均应用，正文实例保留，重正文挂载仍为 3。两端执行同一按实时时间变化的相机函数；实际 rAF／相机回调次数不同是输出表现差异，**不是完成了等量呈现工作的证明**。因此 WK 较低 CPU 不能被解释成在同等连续效果下更高效。

| 负载运行 | rAF 回调数 | P95 ms | P99 ms | max ms | >33.4ms | >50ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| r1 Electron | 480 | 17.6 | 17.7 | 17.7 | 0 | 0 |
| r1 WK | 417 | 18 | 91 | 94 | 16 | 16 |
| r2 WK | 417 | 18 | 92 | 94 | 16 | 16 |
| r2 Electron | 480 | 17.5 | 17.6 | 17.7 | 0 | 0 |
| r3 Electron | 480 | 17.6 | 17.6 | 17.7 | 0 | 0 |
| r3 WK | 416 | 18 | 92 | 94 | 16 | 16 |

WK 少量长间隔约占 4%，P95 为 18ms 会掩盖它们。静态阅读两端每轮均为 480 个 rAF 回调，Electron P99 约 17.6ms、max 17.7ms；WK P99 18ms、max 18–19ms，均没有 >33.4ms／>50ms 间隔。没有做 profiler 或呈现链路测量，不能把停顿具体归因于 WebKit、MathLive、布局或某一代码路径。

[frame-tails-v2.json](frame-tails-v2.json) 覆盖所有阶段；P99 从已保存 raw intervals 取 nearest rank `ceil(n*0.99)`，排除首个 null 间隔。阈值严格比较前将毫秒舍入至六位小数，避免 `33.40000000000009` 的二进制误差被算成 >33.4ms。没有新增采样来取得这些指标。

## 固定程序与统一口径

补测时间 21:10:06–21:15:05（Asia/Shanghai，含编译／清理），严格顺序：**E→WK、WK→E、E→WK**。始终只有一个被测宿主；确认前一宿主及归属进程退出后，再开始下一个。每次 fresh userData/session 或 WK nonpersistent store，同一 loopback 只读服务、同一实际内容与源码 hash。

1. 空窗口：最小 HTML，稳定后等待 2 秒，名义采样 8 秒。
2. 内容阅读：fixture ready、fonts、相机稳定后再等待 3 秒，名义采样 8 秒。
3. 负载：8 秒内按 500ms 计划执行 16 次真实段落增长（原段落重复 4→19 次），相机按同一 rAF 时间函数小范围移动。保存逐次实际应用、正文高度、相机状态和同一正文身份。
4. 关学习窗：真实关闭并销毁 WebView，等待 2 秒后名义采样 8 秒，保留宿主；随后完整退出。

相同 Python 外部采样器使用单调时钟，每 0.5 秒尽力采样，额外采 begin/end 端点，共 **578 份**原始进程快照，实际采集时长保留。前台阶段外部窗口 8.032–8.075 秒；WK 关窗约 8.44–8.46 秒、Electron 约 8.04 秒，包含 native HTTP 回调调度。CPU 使用实际 elapsed 归一化，没有假报严格同为 8.000 秒。采样器／只读 HTTP 服务自身不计入任何宿主成本。

- **内存主指标**：所有确认归属 PID 统一通过 `proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint` 取 byte，再求进程组和；SDK 字段已核对。两组均没有 API 权限错误或缺失样本。`phys_footprint` 是内核按 task 的记账，包含压缩等语义，**不是单纯驻留物理 RAM，也不是精确的全机唯一物理页总量或独占整机增量**；WindowServer、驱动与共享 OS 服务未分摊。
- **RSS 仅辅助**：保存 `ps RSS` 和 `ri_resident_size`，不用于主要结论。进程组总 RSS 重复计入共享页，不能当真实物理内存需求；不混用 WK footprint 和 Electron RSS。
- **CPU 校准**：每 PID 的 `ri_user_time + ri_system_time` 增量，经本机 Mach timebase **125/3 ns per tick** 换算后求和。补测 `time.process_time` 增量 **0.199857 秒**，换算 rusage 增量 **0.199853417 秒**，比例 **0.999982071**，量级吻合。校准误差超过 2% 或阶段 PID 集合变化时，分析器禁止 CPU 比较；本轮各阶段进程集合均稳定。不会将已经退出进程的 CPU 默算为 0。
- **Electron 全进程**：递归 Browser 后代，保存 Renderer／GPU／Network utility 的 PID、命令与统一 rusage。`getAppMetrics()` 保存原始 PID/type/memory，只作辅助；其 lifetime CPU、resident/private/shared 等字段不是跨引擎 `phys_footprint`，JS heap 也不是完整应用内存。本轮没有拿这些 API 字段代替主要口径。
- **WK 责任归属**：WebKit XPC 常见 PPID=1，不能只用父子树。用 `responsibility_get_pid_responsible_for_pid` 与独立 LaunchServices 宿主 PID 确认；每次快照保留全部候选及 included／preexisting／responsible PID。三次均确认自己的 WebContent、GPU、Networking；既有 12 个用户 WebKit 进程全部排除，没有归属不明的新 WK/GPU 被按 0 计。此为 macOS 私有诊断接口，不是产品稳定 API。
- **公平性与局限**：每帧及阶段端点记录 viewport／DPR／visible／focus，另有 native key/bounds。所有补测采样帧通过，不持续强制 focus。其他用户应用仍存在，未宣称全机空闲、冷缓存、热状态一致、统计显著或跨平台结论。

## 初轮失败与短诊断：完整保留

[results.json](results.json) 是第一次预定三对的完整原始记录，**没有被新结果覆盖或改成通过**，文件 SHA-256 保持：

```text
90c1caec240fd337140d06545fe6165ecd865a595b0577d7020b5914e9256e6a
```

初轮 524 份进程快照，viewport 全部 1000×700／DPR 2／visible，但所有帧 `hasFocus=false`，Electron 还使用 `backgroundThrottling=false`。其 `frameConditionsAllMatch=false` 不是字段缺失，`failures=[]` 只表示执行没有异常，不等于公平性通过。初轮阅读／负载不排名，也不与补测拼成六对统计。原报告保存在 [README-first-trial.md](README-first-trial.md)。

[frame-tails-first-trial.json](frame-tails-first-trial.json) 是从旧 raw 离线补算的长尾，旧原始 JSON 不变：初轮 WK 负载 P99 91ms、max 93–94ms、每轮 >50ms 16 次；Electron 第一轮 max 83.4ms、>50ms 1 次，其余两轮无 >50ms。它们仅说明方法需要 P99/max/阈值计数，**不据此比较两端效果**。

初轮条件失败后做一次短诊断：[focus-diagnostic.json](focus-diagnostic.json)，每宿主一次激活、约 4 秒／20 样本。两端 native key 和 document focus 全部为 true。WK 汇总曾错误使用旁路 observer 的 `com.github.Electron`，与 WK 原生采样的 `local.robert.desktop-focus-diagnostic` 冲突；已用 WK 的进程内 NSWorkspace 原始采样修正，并在 `summaryCorrection.priorSummaries` 保留误汇总。旁路 observer 没有运行 AppKit RunLoop，跨应用切换的 timeline 不能作为 WK 的可靠 foreground 证据。

短诊断只证明单次激活可以保持约 4 秒焦点，**不能证明初轮失焦由某个异步 activate 竞态导致**。再针对已知测量缺陷补测固定三对；同时恢复默认节流、每阶段激活和稳定检查，不能单独归因于其中一个改动。补测结束后不再追加。

## 磁盘：下载缓存、运行时、小宿主分别记

| 对象 | 本机实测 | 范围 |
| --- | --- | --- |
| 官方 Electron ZIP 下载缓存 | **114,353,947 bytes / 109.056 MiB** | 原缓存只读复制，原缓存未动 |
| 展开 Electron.app | **271,600,117 logical bytes / 259.018 MiB**；du 266,092 KiB | 排除 ZIP 和 app 外许可文件 |
| 完整展开 release | **287,317,180 logical bytes / 274.007 MiB**；regular files 分配 288,202,752 bytes | app＋LICENSE/version/Chromium notices，排除 ZIP；分配数不含目录等元数据 |
| 补测 Swift WK 最小 app | **143,759 logical bytes**；du 144 KiB | 原轮 143,951 bytes；均不是 Tauri 包体／完整产品 |
| 系统 WebKit runtime | **独立可归属体积未知** | 可遍历 framework 文件逻辑和 7,012,700 bytes；该路径 du=0，不表示 WebKit 0 资源 |

系统 WebKit 使用 OS 中的 framework、共享库和 dyld shared cache。小宿主没有把这些打入包，不表示没有磁盘／内存成本；本次不分摊完整 OS shared cache。双方数字都不包含正式课程、核心、安装更新系统，不能报成完整产品下载／安装体积。

## 源码、hash、复现和清理

`run.py / electron.cjs / wk.swift / renderer.js` 对应初轮；`run-v2.py / electron-v2.cjs / wk-v2.swift / renderer-v2.js` 对应最后三对。两套采集源码都留存。`analyze.py` 只从原始 JSON 计算公平性及长尾；`audit.py` 只核对旧目录、源码、旧 PID/start identity、端口、runtime 与磁盘，不再运行宿主。`focus.py / focus.swift / focus-electron.cjs` 仅短诊断。

`results-v2.json` 保存完整原始样本／进程命令／rAF／事件／失败／输出及 `analysis`。`hashes.protectedBefore/After` 绑定原架构与旧宿主，`hashes.servedFiles` 绑定 14 个实际访问文件，`postMeasurement.collectionSourceHashes` 与采集结束的源码 hash 一致。后处理脚本 hash 独立保存；`analysisMetadata.rawEvidenceCanonicalSha256` 绑定未改动的原始采集字段。命令行与用户摘要不大段打印原始进程命令。

关键 SHA-256：

```text
Electron ZIP   24e3b1a13ff7243f6b9036ebb743b6f62b19e4a925242d27eaa2be90de90a691
fixture.json   ff896778b0ff0d81be6a5859c86746fa04ddc89dd6397cf870aa9b29c325ae4b
src/main.jsx   b09584560822405d6d4aca1d9295e6f2fa8399540b782099660340f4520a80ed
dist/app.js    09d2dceb53d0c1ddbb0d2f83578ed8ec64c852ef5b1f66264692dc4e1069448f
dist/app.css   b03dd66938a9e9ea0b9fd405cb3880a3db6f6d03ece76f2e854ff8a12304af50
```

当前所有测量已结束，**不应为挑数值自动执行以下资源命令**。复现时使用独占测量窗口避免并行负载，并先备份原结果：

```sh
# 最后三对方案；只读复用已校验的 runtime，无 npm／Rust／Tauri 依赖
python3 run-v2.py --runtime-app /absolute/path/Electron.app
python3 audit.py --input results-v2.json
python3 analyze.py --input results-v2.json --save --frame-output frame-tails-v2.json
# 只离线分析初轮，不改其完整原始文件
python3 analyze.py --input results.json --frame-output frame-tails-first-trial.json
```

原方案 `python3 run.py --retain-runtime` 会复制现有官方 ZIP 并运行初轮方案，不应用于公平比较。两个 runner 都有有界超时，失败保留；分析器的公平性字段而非退出码决定能否比较。需要本机 CLT/Swift、Python 3、现有官方 Electron 40.10.6 ZIP，不连接旧 8772 服务。所有临时数据独立，未使用个人 DB 或 Agent API。

两轮全部专用宿主／归属进程、窗口、HTTP 服务／端口均退出，userData/session/logs、Swift cache、临时最小宿主二进制已删除。旧目录 byte-for-byte 不变；个人浏览器和用户原缓存未动。

核心实验 `run-KanJGk` 完成后，共用 runtime 已不再需要。**现已删除本实验拥有的整个临时父目录**，包括 Electron.app、复制的 ZIP 和许可文件；删除了 401,671,127 logical bytes，没有删除或修改用户原 Library 下载缓存。

已删除路径（不再可供复用）：

```text
/var/folders/nn/s5g8qnt93l30cz_m3svlc3gm0000gn/T/desktop-resource-4fefz5ln/
```

系统解析后的 `/private/var/folders/...` 是同一目录，两种路径均已不存在。复现时需要从保留的官方原缓存，在独立临时目录重新展开经过校验的 runtime，再传给上述命令；不要使用已经删除的旧路径。

最终证据见 [final-cleanup.json](final-cleanup.json)：`passed=true`、`runtimeCleanupPending=false`，确认已观察的专用 PID/start identity 全部不存在、专用命令匹配数为 0，55375／57442／56703 三个端口均未监听，初轮／补测／短诊断临时目录均不存在，本目录无残留 `__pycache__` 或 `.pyc`。原 Library ZIP 的 SHA-256、inode、大小与修改时间保持一致；原架构／旧宿主目录仍 byte-for-byte 不变。

初轮 `results.json`、补测 `results-v2.json`、诊断与长尾数据均保持原字节；其中旧 `cleanup.runtimeRetained`／`runtimeCleanupPending` 是当时交接状态的历史快照，**最终清理状态以单独的 final-cleanup.json 为准**。实验源码、报告与原始结果继续保留；此次收尾没有启动任何宿主或负载，runtime 清理待办已关闭。
