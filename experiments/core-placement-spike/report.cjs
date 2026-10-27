'use strict';
function report(result) {
  const number = x => Number.isFinite(x) ? x.toFixed(3) : '—';
  const mib = x => Number.isFinite(x) ? number(x/1048576) : '—';
  const lines = [
    '# Core placement：真实 Electron node:sqlite 结果', '',
    `状态：${result.status}。测量窗口：${result.measurementWindow}。原始证据：[${result.runId}.json](${result.runId}.json)。`, '',
    '无学习 renderer；以下是核心放置和 host 定时器响应，不是输入延迟或整 App 资源。host 同步只作对照。', '',
    '同一 84→500 单元 seed 的独立副本；每条命令各一次 BEGIN IMMEDIATE / FULL COMMIT；三轮预定顺序，paced/bulk 各自独立 host。', '',
    '|轮|场景|承载|确认 P95 ms|adapter P95 ms|COMMIT P95 ms|空载 RTT P95 ms|idle timer excess P95 ms|load timer excess P95/max ms|host+core RSS idle→post MiB|host+core physFootprint idle→post MiB|',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for(const t of result.trials) {
    if(!t.load || !t.memory?.afterLoadIdle)continue;
    const s=t.load.summaries.all,e=t.load.eventLoop.excessMs;
    lines.push(`|${t.round}|${t.scenario}|${t.arm}|${number(s.roundTripMs.p95)}|${number(s.adapterMs.p95)}|${number(s.commitCallMs.p95)}|${number(t.echo.roundTripMs.p95)}|${number(t.idleEventLoop.excessMs.p95)}|${number(e.p95)}/${number(e.max)}|${mib(t.memory.preparedIdle.hostAndCoreRssSum.p50)}→${mib(t.memory.afterLoadIdle.hostAndCoreRssSum.p50)}|${mib(t.memory.preparedIdle.hostAndCorePhysFootprintSum?.p50)}→${mib(t.memory.afterLoadIdle.hostAndCorePhysFootprintSum?.p50)}|`);
  }
  lines.push('',
    'RSS 由 ps 按唯一 PID 采样。worker 共享 host RSS，未另加；RSS sum 含重复 shared pages，不能解释为物理总内存。原始 JSON 同时保留 Electron helpers 的逐 PID 值与 appRssSum。', '',
    'physFootprint 由测量专用 Python 标准库 helper 读取 libSystem proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint，按相同归属 PID 去重求和。它是 macOS 进程内存记账口径，不等于全系统唯一物理页。任何样本读取失败时保留错误、总和为 null，该组不计算部分样本分位数，表中显示 —，不补零或据此排序。', '',
    'paced 为预定 10 ms 请求间隔、最多一条在途；迟到值保留。bulk 为同一请求粒度、逐请求 setImmediate 的连续突发，不是用户打字场景。', '',
    'COMMIT 是调用持续时间，可能含 SQLite 自动 checkpoint；不是单次物理 fsync。带载 RTT 减 adapter 的 residual 含消息序列化、队列、主线程派发和调度，不能当纯 IPC。', '',
    `最终内容/历史/回执摘要：${result.finalSnapshotSha256 || '未形成全部三臂一致的证据'}。`, '',
    `清理：${JSON.stringify(result.cleanup)}。`, '',
    '结果只用于判断此条有限短事务负载下 worker 是否足够避免 host 阻塞，以及 utility 增加的承载成本。不能据此宣布任意 CPU/native 工作都能隔离；worker 没有独立进程 native crash 边界，utility 的进程隔离价值也未通过制造 native crash 来测量。',
  );
  if(result.failures.length)lines.push('', '失败保留：', ...result.failures.map(e=>'```text\n'+e+'\n```'));
  return lines.join('\n');
}
module.exports={report};
