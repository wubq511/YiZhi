'use strict';
// Do not even initialize Electron unless the launcher has an explicit window token.
if (process.env.CORE_PLACEMENT_WINDOW !== 'explicitly-open' || !process.env.CORE_PLACEMENT_CONFIG) {
  throw new Error('Use run.cjs only after the main agent opens the measurement window');
}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {app} = require('electron');
const plan = require('./plan.cjs');
const {hash,canonical,buildFixture,makeWorkload} = require('./fixture.cjs');
const {createCarrier} = require('./carrier.cjs');
const {sleep,distribution,memorySamples,monitor,workload} = require('./metrics.cjs');
const config = JSON.parse(fs.readFileSync(process.env.CORE_PLACEMENT_CONFIG,'utf8'));
function assertScratchPath(file) {
  const relative=path.relative(__dirname,path.resolve(file));
  assert(/^\.tmp-core-placement-[^/\\]+[/\\]/.test(relative) && !relative.split(path.sep).includes('..'),
    'All generated files and SQLite databases must stay in this spike temporary tree');
}
for(const file of [config.scratch,config.output,config.database,config.warmupDatabase].filter(Boolean))assertScratchPath(file);
for (const name of ['userData','sessionData','logs','crashDumps']) {
  const folder = path.join(config.scratch,name); fs.mkdirSync(folder,{recursive:true}); app.setPath(name,folder);
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
const out = {mode:config.mode,arm:config.arm,round:config.round,scenario:config.scenario,
  windowToken:config.windowToken,versions:process.versions,pid:process.pid,execPath:process.execPath,
  renderer:false,failures:[]};
let carrier, dbOpen = false;
const watchdog = setTimeout(() => {out.failures.push('trial watchdog'); finish(1);},plan.trialTimeoutMs);
let finished = false;
function finish(code) {
  if (finished) return; finished=true;
  clearTimeout(watchdog);
  fs.writeFileSync(config.output,JSON.stringify(out,null,2)+'\n');
  app.exit(code);
}
app.whenReady().then(async () => {
  assert.equal(process.versions.electron,plan.electron);
  assert.equal(process.versions.node,plan.node);
  const fixtureBytes = fs.readFileSync(plan.fixture);
  out.fixtureSha256 = hash(fixtureBytes);
  if (config.mode === 'seed') {
    const seed = buildFixture(JSON.parse(fixtureBytes));
    const commands = makeWorkload(seed);
    out.seed = require('./adapter.cjs').seedDatabase(config.database,seed);
    out.commandSha256 = hash(commands);
    out.databaseSha256 = hash(fs.readFileSync(config.database));
    assert(!fs.existsSync(config.database+'-wal') || fs.statSync(config.database+'-wal').size===0);
    finish(0); return;
  }
  const commands = JSON.parse(fs.readFileSync(config.commands,'utf8'));
  out.commandSha256 = hash(commands);
  assert.equal(commands.length,plan.operations);
  // No building the 500-unit model or importing SQLite into host for worker/utility
  // before its memory and responsiveness measurements.
  out.memory = {emptyHost:await memorySamples(app)};
  const created = performance.now();
  carrier = await createCarrier(config.arm);
  out.core = await carrier.call('hello');
  out.carrierReadyMs = performance.now()-created;
  assert.equal(out.core.versions.electron,plan.electron);
  assert.equal(out.core.versions.node,plan.node);
  // Equal warm-up on a disposable, byte-identical clone, then open untouched trial DB.
  await carrier.call('open',config.warmupDatabase); dbOpen=true;
  for (const c of commands.slice(0,plan.warmupOperations)) await carrier.call('apply',c);
  await carrier.call('close'); dbOpen=false;
  out.database = await carrier.call('open',config.database); dbOpen=true;
  // Same request type/size and receipt envelope without DB work, separate IPC control.
  const echo = [];
  for (const c of commands.slice(0,plan.echoCount)) {
    await new Promise(resolve => setImmediate(resolve));
    const start = performance.now(); await carrier.call('echo',c);
    echo.push({kind:c.kind,requestBytes:Buffer.byteLength(canonical(c)),roundTripMs:performance.now()-start});
  }
  out.echo = {samples:echo,roundTripMs:distribution(echo.map(s => s.roundTripMs)),
    interpretation:config.arm==='host'?'in-process dispatch control; no IPC':'empty handler RTT; not a subtractable constant'};
  out.memory.preparedIdle = await memorySamples(app,out.core.pid);
  const stopIdleMonitor=monitor(); await sleep(plan.idleMs);
  out.idleEventLoop=await stopIdleMonitor();
  out.load = await workload(carrier,commands,config.scenario);
  out.memory.afterLoadIdle = await memorySamples(app,out.core.pid);
  out.filesBeforeClose = Object.fromEntries(['','-wal','-shm'].map(s => [s||'database',
    fs.existsSync(config.database+s)?fs.statSync(config.database+s).size:0]));
  // Full-table snapshot/canonical/hash allocations are validation-only: do not
  // create them before any memory or timing samples. Probe the loaded trial DB.
  const priorHash = await carrier.call('snapshot-hash');
  const original = commands[0];
  const duplicate = await carrier.call('apply',original);
  assert(duplicate.duplicate); assert.deepEqual(duplicate.receipt,out.load.operations[0].receipt);
  let changedRejected = false;
  try { await carrier.call('apply',{...original,unexpected:'same ID changed payload'}); }
  catch (e) { changedRejected = e.message==='operation_payload_changed'; }
  assert(changedRejected);
  assert.equal(await carrier.call('snapshot-hash'),priorHash);
  out.bindingProbe = {duplicateReceipt:duplicate.receipt,changedPayloadRejected:changedRejected,
    sqliteError:await carrier.call('probe-error')};
  // End a real worker/process WITH its connection open, AFTER all writes were ACKed.
  // This is termination after acknowledgement, not injected native crash evidence.
  if (config.arm==='host') { await carrier.call('close'); dbOpen=false; }
  out.termination = await carrier.stop(); carrier=undefined; dbOpen=false;
  // Reopen only after worker/utility has emitted exit; out of all measured windows.
  const {Adapter} = require('./adapter.cjs');
  const seed = buildFixture(JSON.parse(fixtureBytes));
  const verifier = new Adapter(config.database);
  try {
    const beforeRetry = verifier.verify(seed,commands);
    const replay = verifier.apply(commands.at(-1));
    assert(replay.duplicate);
    assert.deepEqual(replay.receipt,out.load.lastResponse.receipt);
    out.reopen = {afterCarrierExit:config.arm!=='host',knownAcknowledgedReceipt:replay.receipt,
      duplicate:true,...verifier.verify(seed,commands)};
    assert.equal(beforeRetry.snapshotSha256,out.reopen.snapshotSha256);
  } finally {verifier.close();}
  out.temporaryWorkerDatabase='removed by parent launcher after host exit';
  finish(0);
}).catch(async e => {
  out.failures.push(e.stack || String(e));
  if (carrier) {
    if (dbOpen) try {await carrier.call('close');} catch {}
    try {out.termination = await carrier.stop();} catch (stopError) {out.failures.push(String(stopError));}
  }
  finish(1);
});
