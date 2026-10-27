# 有界 Electron 核心放置比较实验

本实验用真实 Electron 40.10.6 / Node 24.15.0 的 `node:sqlite`，比较同一数据库适配和短事务负载放在 host main、worker_threads 与 utilityProcess 的承载成本。运行需要独立 Electron runtime，并避免与其他资源实验同时执行，以减少测量干扰。

2026-10-27，**首次完整运行 18/18 场景通过，未修复重跑或挑选数据。** 三臂均执行真实 DatabaseSync 事务，最终内容、历史和回执完全一致。utility 相比 worker 的 prepared idle physFootprint 约多 **11 MiB**；短事务 timer 负载结果接近 idle 噪声，没有稳定的 utility 响应优势，**也不能说实测证明 worker 隔离性能优越**。这支持把同进程 worker 保留为更轻的核心承载候选，而不是因本次性能证据默认选择 utility；native crash 隔离仍是独立取舍。

完整逐场景表见 [results.md](results.md)，原始运行证据见 [run-KanJGk.json](run-KanJGk.json)，[results.json](results.json) 保存状态及指针。`preparation.json` 仅是首测前的静态记录，不代替实测。外部 Node v26 用于驱动和离线核对，数据库由嵌入 Node 24.15.0 执行；Python 仅作 footprint 测量 helper。

## 本次实际结果

运行标识 `run-KanJGk`，测量批次 `HOST-RESOURCE-V2-COMPLETE-20261027`；北京时间 21:19:44 至 21:21:22，总执行约 97.6 s，包含建库、准备、采样和校验，不是负载吞吐时间。环境为 Apple M5 / arm64、10 个逻辑 CPU、Darwin 27.0.0；所有场景实测 Electron **40.10.6**、嵌入 Node **24.15.0**、SQLite **3.51.3**。实际 WAL / FULL 等 PRAGMA 三臂相同，具体值和 SQLite build options 保留在原始记录。

以下内存数值为每场景 5 次采样的中位数在全部 6 个场景（三轮 × 两种节奏）中的范围，单位 MiB；不是合并样本的置信区间。host+core 按唯一 PID 计，worker 不另加一次 RSS；“含 helpers”包括本次 Electron host 的全部已登记辅助进程，不是完整学习 App。

|承载|host+core footprint prepared|host+core footprint post|含 helpers footprint prepared|含 helpers footprint post|host+core RSS prepared|
|---|---:|---:|---:|---:|---:|
|host|34.33–34.61|38.83–39.13|48.33–48.64|52.89–53.10|120.50–120.70|
|worker|40.41–40.50|45.47–45.86|54.47–54.55|59.57–59.86|126.81–126.92|
|utility|51.27–51.50|56.63–57.02|65.35–65.54|70.66–71.08|190.03–190.19|

同轮同节奏配对，prepared idle 的 utility − worker 差为 host+core footprint **10.83–11.05 MiB**、含 helpers footprint **10.88–10.99 MiB**。host+core RSS 差约 **63 MiB**，含重复 shared pages；不能把它写成 utility 多消耗约 63 MiB 物理内存。负载后含 helpers footprint 的配对差为 10.94–11.44 MiB。本次 270 次内存快照共 870 次 PID footprint 读取全部成功，无缺失值或补零。

正常节奏 `paced` 的三轮结果如下，时间均为 ms；表内范围是各轮 P95 的最小至最大，不是把不同轮次合并后的 P95。

|承载|保存确认 RTT P95|COMMIT 调用 P95|idle timer excess P95|load timer excess P95|
|---|---:|---:|---:|---:|
|host|0.820–0.935|0.492–0.551|2.659–2.680|3.022–3.057|
|worker|0.999–1.098|0.474–0.540|2.658–2.697|3.046–3.096|
|utility|0.510–1.179|0.196–0.526|2.623–2.680|2.901–3.144|

三臂 load timer 的 P95 都约 3 ms，idle 本身已约 2.6–2.7 ms，负载指标靠近该基线噪声，不能证明 worker 隔离性能优越。host 的单轮 timer 最大 excess 为 3.489–5.496 ms，worker 为 3.385–3.453 ms，utility 为 3.066–3.416 ms；这条短轨迹没有足够证据把少数最大值差异推广为稳定优势，更不能等同输入延迟。保留 host 作为对照，不因其确认耗时更小就推荐主线程同步作为默认。

空载派发/往返 P95 为 host 0.015–0.020 ms、worker 0.039–0.046 ms、utility 0.057–0.067 ms；host 无 IPC。承载 ready 时间为 host 0.764–0.843 ms、worker 18.771–21.341 ms、utility 63.385–72.756 ms，均从创建承载至 hello，不含整个 Electron 启动。带载 RTT 与 COMMIT 已分开保存；utility 某轮确认更快不能抹掉另外两轮，也不等于更低的 IPC 成本。

`bulk` 的 240 请求批次仅持续 28.24–59.56 ms，逐请求同样 yield，没有 host 独占长循环；每场景只有 **7–13 个 timer ticks**，nearest-rank P95 此时等于最大值，不能用来稳定比较尾延迟。它是明确标记的突发批次，不是用户打字场景。

**测量限制：该 runtime 的 idle/load `eventLoopUtilization` 全部返回 active=0、idle=0、utilization=0。** 该指标不可用，不能解释成无 CPU 活动或零阻塞；原值保留，不修成有效指标，结论只使用实际 timer ticks 与保存分项。不因此扩大测试或重跑。`passed` 表示本次事务、内容和清理验证通过，不表示每个可选指标都有效。

18 场景合计 **4320 次已确认短提交**；每库 500 单元、7732 个 baseline/current 对象、240 个 operations、160 条变化历史、8 个 latest drafts、80 个消息。每场景在全部负载/内存采样后通过重复 ID、变 payload 拒绝和 SQLite foreign-key error 787 的全表回滚检查；worker/utility 真实退出后重开，最后已确认操作的重复回执相同，integrity/foreign-key 和独立 oracle 全部通过。worker 的主动 terminate 返回 code 1，utility 返回 code 0；前者不是未处理失败，也不是 native crash 注入。18 个 host 进程均 code 0、无 stderr，最终完整内容 SHA-256 一致：

```text
980b0edb66187a8ca555dd69ef573fe9a811ad6f423e450dd480d993c75a615e
```

5 个只读输入/参考文件的前后 hash 相同，seed 文件末尾 hash 核对通过；本次临时树已删除，observed PID 无残留。本实验交回 shared runtime 后，宿主资源实验已完成其最终清理，见 [final-cleanup.json](../desktop-resource-spike/final-cleanup.json)。没有仍需 runtime 的已知失败或检查，不追加测量。

## 要回答的问题和边界

同一份 `node:sqlite` / `DatabaseSync` 适配及同一条短事务轨迹，分别放在 Electron host main 线程、`node:worker_threads` worker、Electron `utilityProcess`。判断 worker 对这条工作负载是否已足够隔离同步数据库工作，以及 utility 的额外内存、往返和承载成本。**host 同步只作对照，不作为默认架构建议。**

不创建学习 renderer，不加载课程 UI、不调用模型、不使用正式 Service，不接触个人数据库或真实对话。因此测的是 host 的 event-loop 定时器响应与核心承载成本，**不是键盘/输入延迟，不是整 App 资源，也不是最终桌面实现的验收**。无渲染的 Electron 辅助进程仍计入观察，外部实验驱动 Node 的资源不计入被测 host。

worker 可隔离 JS event-loop 上的同步工作，但与 host 共用进程；独立 utility 有不同的 native crash 隔离边界。本实验不制造 native crash，不宣称证明 host 必崩或 utility 的所有故障都能恢复。按已确认信息，不另做 SQLite WAL-reset bug 测试。

## 依赖与运行命令

- 外部 Node.js 22+ 运行驱动和静态检查；不以其 SQLite/Node 版本代替嵌入版本。本机发现 `/opt/homebrew/bin/node` v26.0.0。
- 独立 **Electron 40.10.6 可执行文件的绝对路径**；嵌入 **Node 24.15.0**，三臂均在真实运行时断言版本并记录 SQLite 版本、build options 和实际 PRAGMA。路径不能是 npm 包目录、`npx` 或当前 Codex.app。
- macOS / POSIX `ps -o pid=,rss= -p PID,...`。本次仅在上述 macOS 环境实测，本版 RSS 采样器不支持 Windows。
- `python3` 标准库 `ctypes` 和 macOS `/usr/lib/libSystem.B.dylib`，仅用于内存采样 helper 的 `proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint`。这是实验测量依赖，不是产品 Python 依赖，不执行 Python 数据库负载；非 macOS 或读取失败时明确记录 footprint 错误。
- 项目现有只读 `../architecture-spike/fixture.json`；只读参考 `../history-spike/{spike.py,README.md}` 和 `../storage-spike/{spike.py,README.md}`。不执行这些 Python 脚本。
- 不需要 npm 包、原生 addon 编译器、Python SQLite 或数据库服务器；不下载 runtime。

静态检查（项目根目录）：

```sh
node docs/复习工具调研/04-演示/core-placement-spike/check.cjs
```

复现命令（替换为本机 runtime 路径，并为本次测量填写唯一标识）：

```sh
node docs/复习工具调研/04-演示/core-placement-spike/run.cjs \
  --runtime '/absolute/path/to/Electron.app/Contents/MacOS/Electron' \
  --measurement-window 'core-placement-reproduction-001'
```

macOS 路径应具体到 `Electron.app/Contents/MacOS/Electron`。运行时应暂停其他资源测试；`--measurement-window` 保存实际测量批次标识，用于追溯和协调并行实验，**不是永久授权或审批流程**。驱动保留该必填参数，并设置底层入口需要的窗口环境标志；无参数仅打印帮助，缺少标识或绝对 runtime 路径会拒绝启动。`run.cjs --check` 同样只检查静态状态。

驱动先核对本次输入与准备时的 hash。若上游文件变化，应重新静态检查并更新负载说明后再测。每次运行保存独立 `run-*.json`，失败记录也保留，`results.json` 指向最后一次，`results.md` 列出逐轮结果，不挑最快轮。

## 固定计划：相同粒度、相同调度

三轮顺序预定于 `plan.cjs`，每种承载各占一次首、中、尾位置；不按观测数字临时换顺序：

|轮|承载顺序|每个承载内的独立场景|
|---|---|---|
|1|host → worker → utility|paced，再 bulk|
|2|worker → utility → host|paced，再 bulk|
|3|utility → host → worker|paced，再 bulk|

合计 18 个独立 Electron host，每个场景都从相同 seed 新复制；前臂退出、相关进程回收后才启动下一臂。场景顺序固定而未随机，文件页缓存不清空，不能声称冷启动或消除了所有时间漂移。两场景分别比较，不合并成一个体验分数。

**三臂都逐请求调用同一个 adapter，每请求一个短事务，最多一条在途，每条请求之前都 `await setImmediate`。没有把 host 的 240 条塞入一个不让出 event loop 的同步循环。** host 直接派发，worker/utility 经各自消息接口派发；这是需要比较的承载差别。

- `paced`：相同绝对预定到达时间，每 10 ms 一条。若上一条尚未完成，遵循相同背压规则延迟发送，并记录每条 scheduled/sent 时间和 lateness；不凭空丢请求或并发追赶。10 ms 是本实验节奏，不等同真实打字轨迹。
- `bulk`：同一粒度，连续单请求突发、逐请求 `setImmediate`、相同背压。标注为 **bulk 批次压力**，不是打字场景，也不是单条巨事务。

不得通过仅更改一臂的调用批次、yield 或人为延时制造“main 必卡”的结论。固定调度器在 `metrics.cjs`，host 的 async 调用也必须经过它。

## 数据、准备和真实提交

只读 fixture 中 84 个真实单元及其全部嵌套块/metadata，复制到 500 个完整结构单元；不是 500 个独立知识主题。沿用 storage 实验的精确字符串 ID 重映射：首批身份不变，后批稳定 `~copyN` 后缀，末批缺席对象的关系仍指向首批。建库前检查关系端点存在，原始 84 个单元全部规范化→重建后逐值相等。来源路径只作为内容字段保留，不读取真实图片或 PDF。

用 Electron 内的 `DatabaseSync` 仅创建一次 seed：当前对象＋同形初始 baseline，checkpoint 完成并关闭连接，确认无待复制 WAL；随后每个场景按字节复制同一文件并校验 SHA-256。seed 文件在结束时再次核对 hash。

每臂相同准备：同字节 warm-up 副本仅执行前 12 条相同的正常短操作，关闭该连接，再打开从未修改的场景副本、准备相同语句。重复 ID、变 payload 拒绝及全表回滚校验均在负载和 `afterLoadIdle` 全部测完之后、承载终止之前，针对场景库执行；校验不先全量加载 baseline/current，避免其临时对象、canonical/hash 和 GC 行为污染常驻内存比较。warm-up/建库/复制/校验/最终 oracle 不计入负载耗时。worker/utility 场景的 host 在测量前不导入 SQLite 或构建 500 单元的参考模型；它只持有相同的命令数组和 fixture 原始字节。

每场景 240 次保存 = 以下三条重复 80 组：

|命令|实际事务内容|
|---|---|
|group|改两个真实 paragraph 的 `payload.text`，更新 current；仅为这两个变化对象追加 before/after 与 prior revision；同事务写 operation 请求/hash/receipt|
|draft|对 8 个 key 轮流覆盖 latest draft，input sequence 递增；保留未完成公式原文；同事务写 operation 的完整 request/hash/receipt，不冒充正文改动|
|message|按 UTF-8 字节偏移追加合成 message chunk，拒绝错误 offset；同事务写 operation 的完整 request/hash/receipt，不重写完整对话|

group 在 32 个目标间轮换并反复编辑，实际产生历史链；不执行全课快照、undo/redo、任务回撤、压缩、readSet 或复杂结构历史算法。每次操作的规范请求与顺序完全相同，有全轨迹 SHA-256。操作只有在 `COMMIT` 返回后才确认 `saved=true`。

**所有 draft/message 操作也在 `operations` 留存完整 request，这是三臂相同的实验负载，不是正式的最新草稿持久策略。** 虽然 `drafts` 表只保留 8 个最新值，旧草稿原文仍会随 operations 累积；message chunk 也同时存在于消息表和 operation request 中。因此本次数据库增长包含请求留存及重复载荷，不能据此确定生产环境的历史、草稿或对话增长策略，也不能推断“只保留最新草稿”已经使总体存储有界。

设置统一为 WAL、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout=5000`、`wal_autocheckpoint=1000`、4096-byte page，`fullfsync=0`、`checkpoint_fullfsync=0`；各连接读取设置并比对。自动 checkpoint 保留在相同实际写入路径，不隐藏其可能产生的长尾。

## 分开记录什么

|记录|区间与解释|
|---|---|
|`carrierReadyMs`|创建承载至 hello 完成，不含整个 Electron 启动；不得与保存 RTT 混用|
|`echo` RTT|同类型命令载荷、同 receipt envelope 的无数据库往返；host 为本进程派发对照，无 IPC|
|`roundTripMs`|主进程发出一次操作至收到 durable receipt，包括派发/IPC、数据库与响应调度|
|`adapterMs`|承载内开始规范化/hash 至 COMMIT 返回，包括校验、语句和事务|
|`transactionMs`|调用 BEGIN IMMEDIATE 前至 COMMIT 返回，包括可能的等锁|
|`commitCallMs`|真实 `db.exec('COMMIT')` 调用持续时间，可能包含自动 checkpoint；不是物理 fsync 的直接测量|
|`transportAndDispatchResidualMs`|每次 RTT − adapter；含序列化、调度和消息派发，不命名为“纯 IPC”，不拿 echo P95 直接相减|
|`idleEventLoop` / `load.eventLoop`|host 5 ms 定时器每次实际间隔、超过 5 ms 的 excess、原始 ticks 及 ELU；不是输入延迟|
|`schedulingLatenessMs`|相对相同预定到达时间的发出迟到量，辅助解释背压|

载荷开始前先启用 host 定时器并让出一轮；末条返回后保留 10 ms 让迟到的 timer 被记录，再停止，避免同步尾部阻塞被漏掉。逐操作数据全部保存，按全部/各命令统计 median、nearest-rank P95、max。host CPU 样本只代表 host 进程（worker 共享该进程，utility 不在内），不能比较成三臂整体 CPU。

## 内存口径

每个独立 host 采三阶段：空 host、完成相同 warm-up 且场景 DB 打开后的 prepared idle、240 次负载后的 idle。后两者都保持实际 DB/承载打开，都先静置 400 ms，再以相同方式采 5 次、每次采集后间隔 50 ms；不强制 GC。`app.getAppMetrics`、`ps` 及 Python footprint helper 全部在延迟/ELU 测量窗口外执行。

逐 PID 记录 RSS，分别保留 host+core 与 app 所有已登记 Electron helpers 的 RSS sums。**worker 线程与 host 同 PID，`process.memoryUsage().rss` 是全进程值，不能加一次“worker RSS”；本脚本只从 OS 按唯一 PID 采一次。** utility 的独立 PID 才另计。helpers 的出现与消失保留在样本中，不能只挑 core 最小值。

RSS sum 可能重复计入 shared pages，**不是物理内存总量、PSS、footprint 或整 App 内存**；prepared→post 的差也只是在本口径下的短时变化。没有持续负载内峰值、长期泄漏或多年历史测试。不以 isolate heap 冒充宿主整体资源。

另按上述完全相同的归属 PID 集合，使用 Python 标准库 helper 调用 libSystem `proc_pid_rusage(pid, RUSAGE_INFO_V2, ...)`，记录逐进程 `ri_phys_footprint` 字节数。结构布局沿用本机已验证的 [desktop-resource-spike/run.py](../desktop-resource-spike/run.py)，不导入、不执行或修改该实验。helper 自身不加入被测 PID 集合；worker 与 host 同 PID，只计一次。RSS 与 footprint 相继读取，不视为同一瞬间的原子快照。

每次样本记录 `physFootprintSumBytes`（全部归属进程）及 `hostAndCorePhysFootprintSumBytes`，各阶段另给 `appPhysFootprintSum` / `hostAndCorePhysFootprintSum` 分位数。footprint 用于补充 RSS，避免把跨进程重复 RSS 直接解释为 utility 新增物理内存；它是 macOS 的进程内存记账值，**仍不等于全系统唯一物理页或 PSS**。

任何 PID 获取失败都会保留错误信息（API 返回码/errno，或 helper 启动/解析错误），其读数及所属范围的总和为 `null`，不降为 0。某范围的 5 次样本中只要有缺失，该范围摘要标为 `incomplete`，不挑选剩余样本计算分位数；结果表显示 `—`，不据缺失值对承载排序。逐 PID/逐样本错误保留在原始 JSON 中。

## Binding 与内容验证

每次运行在真实 Electron 内执行以下验证；是否通过以对应运行记录为准：

1. 负载中逐条核对 saved/id/seq，无重复确认；完成负载及 `afterLoadIdle` 内存采样之后，才开始以下 binding 探针。
2. 在场景库上重放 `commands[0]`，取得与负载中首次确认完全相同的持久化 receipt，不新增事实；同 ID 改 payload 拒绝，所有表的摘要保持不变。
3. 同一场景库内事务先修改一条 current，再向不存在的对象写 draft，引发真实 SQLite foreign-key error；显式 ROLLBACK，比较所有表与错误前相同。探针不改变最终逻辑状态，全表读取/校验均不进入内存和计时样本。随后在连接尚开着时结束 worker/utility，并等待真实 exit。**没有制造 native crash；utility 使用正常终止 API。** host 对照先关闭 DB。
4. core 结束后 host 重开 DB，运行 integrity/foreign-key checks；独立内存 oracle 比较所有 current、baseline、160 条变化历史、240 个 operations 请求/hash/receipt、8 个 latest drafts、80 个消息及 UTF-8 offsets 的完整内容。
5. 重试最后一个已确认 operation，收到与退出前完全相同的 receipt，快照不变；18 个场景的最终完整内容 SHA-256 必须相同。

逻辑摘要相同要求内容、历史、回执全相同，不要求不同运行的 SQLite 页布局或 WAL 文件 hash 相同。进程退出后可重开不证明掉电持久性。

## 文件与清理

|文件|作用|
|---|---|
|`plan.cjs`|固定版本、负载规模、顺序和上限|
|`fixture.cjs`|只读 fixture 复制/规范化、相同请求及独立内容 oracle|
|`adapter.cjs`|三臂共用的真实 DatabaseSync schema/事务/错误探针|
|`service.cjs`、`carrier.cjs`、`core-entry.cjs`|相同命令接口及三种实际承载|
|`metrics.cjs`|统一请求调度、往返/事务分项、host loop、去重 RSS|
|`phys-footprint.py`|仅在内存阶段按同一 PID 集合读取 macOS physFootprint，保留错误|
|`electron-main.cjs`|一个隔离场景的准备、测量、结束及重开验证|
|`run.cjs`|记录测量批次的串行总控，独立进程组、超时和清理|
|`check.cjs`、`preparation.json`|仅静态检查及准备证据|
|`report.cjs`|由真实运行证据生成 results.md，不填造数值|

数据库、WAL/SHM、warm-up、临时 Electron profile/cache/logs/crashDumps 均在本目录 `.tmp-core-placement-*` 下；入口拒绝该树以外的数据库/输出路径。正常结束、错误和捕获 SIGINT/SIGTERM 时均回收本次独立进程组、移除临时树，结果记录剩余 observed PID 和清理状态。不可捕获的驱动 SIGKILL/主机断电无法承诺 finally；遇到残留必须在非测量窗口人工核对，只删除本次临时目录，不能清理其他 agent 的 runtime。

单 RPC 15 s、单场景 60 s、总计划 12 min 超时；这是退出上限，不是 SLA 或通过阈值。原始输入及参考脚本在前后核对 SHA-256。本目录之外不写文件；不改其他 spike、不提交 Git、不更新个人 memory。

## 结果如何用于决策

先看真实绑定、重开、oracle 和清理是否全部通过，再按相同场景、同轮顺序看 loop 长尾、保存分项、host+core RSS 与完整 helper 口径。三轮是有界复查，不能抹掉一轮反例或宣布统计显著。若短事务本身很短、worker 与 utility 的 loop 差异接近 idle 噪声，只能说本负载未显示额外隔离收益；不能扩大到任意同步 CPU 工作。

worker 是否足够与 utility 的 native crash 隔离是两个维度。即使 worker 成本更小，是否仍为 native crash 边界采用 utility，也需结合正式核心执行何种 native 工作来判断；这份结果不会自动指定默认值。

API 核对依据：[Node 24.15.0 DatabaseSync](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)、[Node 24.15.0 worker_threads](https://nodejs.org/download/release/v24.15.0/docs/api/worker_threads.html)、[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)、[Electron parentPort](https://www.electronjs.org/docs/latest/api/parent-port)。文档用于核对 API，实际可用性以指定 runtime 的三臂执行证据为准。
