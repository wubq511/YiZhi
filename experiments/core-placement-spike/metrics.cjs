'use strict';
const {performance} = require('node:perf_hooks');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const plan = require('./plan.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
function distribution(values) {
  if (!values.length) return {count:0};
  const xs = [...values].sort((a,b) => a-b), n = xs.length;
  return {count:n,p50: n % 2 ? xs[(n-1)/2] : (xs[n/2-1]+xs[n/2])/2,
    p95:xs[Math.ceil(n*.95)-1],max:xs[n-1]};
}
function physFootprints(pids) {
  try {
    const data=JSON.parse(execFileSync('python3',['-B',path.join(__dirname,'phys-footprint.py'),...pids.map(String)],
      {encoding:'utf8',timeout:5000,maxBuffer:1024*1024}));
    return pids.map(pid => {
      const row=data.processes.find(p => p.pid===pid);
      if(row && !row.error && Number.isFinite(row.physFootprintBytes) && row.physFootprintBytes>=0)return row;
      return {pid,physFootprintBytes:null,error:row?.error || {message:'Missing or invalid physical footprint result'}};
    });
  } catch(e) {
    return pids.map(pid => ({pid,physFootprintBytes:null,error:{message:e.message,code:e.code,
      stderr:e.stderr?.toString()}}));
  }
}
function footprintSummary(samples,field) {
  const validCount=samples.filter(s => Number.isFinite(s[field])).length;
  // Do not silently omit failed samples or rank carriers using partial/zero data.
  if(validCount!==samples.length)return {status:'incomplete',count:samples.length,validCount,p50:null,p95:null,max:null};
  return {status:'complete',validCount,...distribution(samples.map(s => s[field]))};
}
async function memorySamples(app, corePid) {
  // OS RSS collected once per unique PID; worker RSS belongs to host PID.
  // ps runs outside latency/ELU windows. Its PID is not part of app.getAppMetrics().
  if (process.platform === 'win32') throw new Error('This prepared RSS collector requires macOS/Linux ps; Windows not measured');
  await sleep(plan.idleMs);
  const samples = [];
  for (let i=0;i<5;i++) {
    const metrics = app.getAppMetrics();
    const pids = [...new Set([process.pid,corePid,...metrics.map(p => p.pid)])].filter(Boolean).sort((a,b) => a-b);
    const output = execFileSync('ps',['-o','pid=,rss=','-p',pids.join(',')],{encoding:'utf8'});
    const rows = output.trim().split('\n').filter(Boolean).map(line => {
      const [pid,rssKiB] = line.trim().split(/\s+/).map(Number);
      return {pid,rssBytes:rssKiB*1024,role:pid===process.pid ? 'host (includes worker threads)' : pid===corePid ? 'utility core' : 'Electron helper',
        type:metrics.find(p => p.pid===pid)?.type || 'unknown'};
    });
    if (!rows.some(r => r.pid===process.pid) || (corePid && !rows.some(r => r.pid===corePid))) throw new Error('Missing host/core RSS');
    // Same selected PIDs as RSS; the short-lived Python sampler itself is excluded.
    // Both collectors run only in idle memory phases, never inside RTT/ELU windows.
    const physical=physFootprints(pids);
    const byPid=new Map(physical.map(p => [p.pid,p]));
    for(const row of rows) {
      const p=byPid.get(row.pid);
      row.physFootprintBytes=p.physFootprintBytes;
      if(p.error)row.physFootprintError=p.error;
    }
    const sumFootprint=selected => {
      const values=selected.map(pid => byPid.get(pid));
      return values.every(p => !p.error && Number.isFinite(p.physFootprintBytes)) ?
        values.reduce((sum,p) => sum+p.physFootprintBytes,0) : null;
    };
    samples.push({processes:rows,rssSumBytes:rows.reduce((sum,p) => sum+p.rssBytes,0),
      hostAndCoreRssSumBytes:rows.filter(p => p.pid===process.pid || p.pid===corePid).reduce((sum,p) => sum+p.rssBytes,0),
      physFootprintProcesses:physical,physFootprintErrors:physical.filter(p => p.error),
      physFootprintSumBytes:sumFootprint(pids),
      hostAndCorePhysFootprintSumBytes:sumFootprint([...new Set([process.pid,corePid].filter(Boolean))])});
    await sleep(50);
  }
  return {method:'ps RSS KiB * 1024 + libSystem proc_pid_rusage(RUSAGE_INFO_V2).ri_phys_footprint; unique PIDs; no forced GC',settleMs:plan.idleMs,samples,
    appRssSum:distribution(samples.map(s => s.rssSumBytes)),
    hostAndCoreRssSum:distribution(samples.map(s => s.hostAndCoreRssSumBytes)),
    appPhysFootprintSum:footprintSummary(samples,'physFootprintSumBytes'),
    hostAndCorePhysFootprintSum:footprintSummary(samples,'hostAndCorePhysFootprintSumBytes'),
    caveat:'RSS sums double-count shared pages. physFootprint is macOS per-process accounting, not PSS or unique system physical pages; neither measures the whole learning app. Missing footprint is null with errors, never zero.'};
}
function monitor() {
  const start = performance.now(), initialElu = performance.eventLoopUtilization();
  const ticks = []; let previous = start;
  const timer = setInterval(() => {
    const now = performance.now(); ticks.push({atMs:now-start,gapMs:now-previous,excessMs:Math.max(0,now-previous-plan.timerPeriodMs)}); previous=now;
  },plan.timerPeriodMs);
  return async () => {
    // Permit a timer delayed by the final synchronous commit to fire before stopping.
    await sleep(plan.timerPeriodMs*2);
    clearInterval(timer);
    return {periodMs:plan.timerPeriodMs,durationMs:performance.now()-start,ticks,
      excessMs:distribution(ticks.map(t => t.excessMs)),gapMs:distribution(ticks.map(t => t.gapMs)),
      elu:performance.eventLoopUtilization(initialElu)};
  };
}
async function workload(carrier, commands, scenario) {
  const periodMs = scenario === 'paced' ? 10 : 0;
  const stopMonitor = monitor();
  await yieldTurn();
  const start = performance.now(), cpu = process.cpuUsage(), operations = [];
  let response;
  try {
    for (let i=0;i<commands.length;i++) {
      const due = start + i*periodMs;
      // Identical scheduling in ALL arms, including synchronous host.
      // Bulk is serialized with backpressure and one setImmediate per request.
      await yieldTurn();
      if (performance.now()<due) await sleep(due-performance.now());
      const sent = performance.now();
      response = await carrier.call('apply',commands[i]);
      const received = performance.now();
      if (response.receipt.operation !== commands[i].id || response.receipt.seq !== i+1 || !response.receipt.saved || response.duplicate) throw new Error('Unexpected receipt');
      operations.push({id:commands[i].id,kind:commands[i].kind,scheduledAtMs:due-start,sentAtMs:sent-start,
        schedulingLatenessMs:Math.max(0,sent-due),roundTripMs:received-sent,
        adapterMs:response.adapterMs,transactionMs:response.transactionMs,commitCallMs:response.commitCallMs,
        transportAndDispatchResidualMs:(received-sent)-response.adapterMs,receipt:response.receipt});
    }
    const elapsedMs = performance.now()-start, hostCpu = process.cpuUsage(cpu);
    const eventLoop = await stopMonitor();
    const summaries = Object.fromEntries(['all','group','draft','message'].map(kind => {
      const rows = operations.filter(r => kind==='all' || r.kind===kind);
      return [kind,Object.fromEntries(['roundTripMs','adapterMs','transactionMs','commitCallMs','schedulingLatenessMs','transportAndDispatchResidualMs']
        .map(k => [k,distribution(rows.map(r => r[k]))]))];
    }));
    return {scenario,periodMs,maxInFlight:1,scheduler:'one setImmediate per command; absolute due time; same in all carriers',
      elapsedMs,hostCpuMicroseconds:hostCpu,eventLoop,operations,summaries,lastResponse:response};
  } catch (e) { await stopMonitor(); throw e; }
}
module.exports = {sleep,yieldTurn,distribution,memorySamples,monitor,workload};
