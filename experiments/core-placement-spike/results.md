# Core placement：真实 Electron node:sqlite 结果

状态：passed。测量窗口：HOST-RESOURCE-V2-COMPLETE-20261027。原始证据：[run-KanJGk.json](run-KanJGk.json)。

首次预定 18 场景全部完成，未修复重测。4320 次提交、完整内容/历史/回执 oracle 与清理均通过；270 次内存快照的 870 次 PID footprint 读取成功。详细解释见 [README](README.md)。

同轮同节奏的 prepared idle，utility 比 worker 多约 11 MiB physFootprint（host+core 10.83–11.05 MiB；含 helpers 10.88–10.99 MiB）。约 63 MiB 的 host+core RSS 差含共享页重复记账，不能据此夸大新增物理内存。

短事务 load timer excess P95 约 3 ms，idle 本身约 2.6–2.7 ms，负载结果靠近基线噪声，不能说实测证明 worker 隔离性能优越，utility 也没有稳定 timer 优势。bulk 仅有 7–13 个 ticks，P95 等于 max，不足以作稳定尾延迟排序。

本 runtime 的 idle/load ELU 全部为零，视为不可用指标；保留原始值，不能解释为零阻塞或零 CPU。后续不扩大或重复测量。

无学习 renderer；以下是核心放置和 host 定时器响应，不是输入延迟或整 App 资源。host 同步只作对照。

同一 84→500 单元 seed 的独立副本；每条命令各一次 BEGIN IMMEDIATE / FULL COMMIT；三轮预定顺序，paced/bulk 各自独立 host。

|轮|场景|承载|确认 P95 ms|adapter P95 ms|COMMIT P95 ms|空载 RTT P95 ms|idle timer excess P95 ms|load timer excess P95/max ms|host+core RSS idle→post MiB|host+core physFootprint idle→post MiB|
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
|1|paced|host|0.935|0.932|0.551|0.017|2.659|3.041/3.489|120.672→127.906|34.611→39.064|
|1|bulk|host|0.294|0.291|0.171|0.020|2.613|2.566/2.566|120.500→125.250|34.330→38.830|
|1|paced|worker|1.098|0.923|0.540|0.041|2.658|3.096/3.453|126.813→134.953|40.439→45.830|
|1|bulk|worker|0.410|0.340|0.189|0.039|2.690|2.581/2.581|126.828→132.281|40.439→45.533|
|1|paced|utility|0.510|0.359|0.196|0.063|2.623|2.901/3.066|190.031→198.953|51.269→56.894|
|1|bulk|utility|0.442|0.325|0.182|0.064|2.663|2.417/2.417|190.078→196.344|51.331→56.628|
|2|paced|worker|1.016|0.843|0.474|0.041|2.677|3.064/3.435|126.906→134.984|40.486→45.861|
|2|bulk|worker|0.190|0.155|0.090|0.040|2.620|2.553/2.553|126.875→132.297|40.455→45.517|
|2|paced|utility|1.179|0.858|0.526|0.057|2.672|3.006/3.409|190.172→198.813|51.393→56.722|
|2|bulk|utility|0.419|0.303|0.180|0.067|2.658|2.566/2.566|190.188→196.359|51.503→56.722|
|2|paced|host|0.852|0.847|0.492|0.018|2.680|3.022/5.338|120.641→127.969|34.486→39.048|
|2|bulk|host|0.320|0.319|0.200|0.015|2.662|2.148/2.148|120.703→125.422|34.611→39.049|
|3|paced|utility|1.136|0.874|0.483|0.059|2.680|3.144/3.416|190.156→199.047|51.409→57.019|
|3|bulk|utility|0.372|0.245|0.154|0.062|2.654|2.087/2.087|190.125→196.359|51.362→56.644|
|3|paced|host|0.820|0.816|0.496|0.018|2.676|3.057/5.496|120.516→128.016|34.377→39.127|
|3|bulk|host|0.341|0.339|0.195|0.019|2.675|1.550/1.550|120.531→125.250|34.408→38.861|
|3|paced|worker|0.999|0.833|0.480|0.046|2.697|3.046/3.385|126.922→134.797|40.502→45.674|
|3|bulk|worker|0.382|0.321|0.194|0.045|2.693|2.042/2.042|126.859→132.281|40.408→45.470|

RSS 由 ps 按唯一 PID 采样。worker 共享 host RSS，未另加；RSS sum 含重复 shared pages，不能解释为物理总内存。原始 JSON 同时保留 Electron helpers 的逐 PID 值与 appRssSum。

physFootprint 由测量专用 Python 标准库 helper 读取 libSystem proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint，按相同归属 PID 去重求和。它是 macOS 进程内存记账口径，不等于全系统唯一物理页。任何样本读取失败时保留错误、总和为 null，该组不计算部分样本分位数，表中显示 —，不补零或据此排序。

paced 为预定 10 ms 请求间隔、最多一条在途；迟到值保留。bulk 为同一请求粒度、逐请求 setImmediate 的连续突发，不是用户打字场景。

COMMIT 是调用持续时间，可能含 SQLite 自动 checkpoint；不是单次物理 fsync。带载 RTT 减 adapter 的 residual 含消息序列化、队列、主线程派发和调度，不能当纯 IPC。

最终内容/历史/回执摘要：980b0edb66187a8ca555dd69ef573fe9a811ad6f423e450dd480d993c75a615e。

清理：{"remainingObservedPids":[],"sourceFilesUnchanged":true,"temporaryDirectoryRemoved":true}。

结果只用于判断此条有限短事务负载下 worker 是否足够避免 host 阻塞，以及 utility 增加的承载成本。不能据此宣布任意 CPU/native 工作都能隔离；worker 没有独立进程 native crash 边界，utility 的进程隔离价值也未通过制造 native crash 来测量。
