'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const plan = require('./plan.cjs');
const {hash,buildFixture,makeWorkload} = require('./fixture.cjs');
const {staticCheck} = require('./check.cjs');
function usage() {
  console.log('Preparation only: node check.cjs\nAfter explicit main-agent notification ONLY:\nnode run.cjs --runtime /absolute/path/to/Electron --measurement-window MAIN_AGENT_WINDOW_ID\nNo dependency installation, automatic runtime discovery, or ungated benchmark.');
}
const args=process.argv.slice(2);
if(!args.length || args.includes('--help')) {usage();process.exit(0);}
if(args.length===1 && args[0]==='--check') {console.log(JSON.stringify(staticCheck(),null,2));process.exit(0);}
assert.equal(args.length,4,'Expected --runtime PATH --measurement-window WINDOW_ID');
const options={};
for(let i=0;i<args.length;i+=2) {assert(['--runtime','--measurement-window'].includes(args[i]));assert(!options[args[i]]);options[args[i]]=args[i+1];}
assert(options['--measurement-window']?.trim(),'Main agent must explicitly open the window; supply its notification ID');
assert(path.isAbsolute(options['--runtime']||''),'Supply actual absolute binary, not package directory or npx');
const runtime=fs.realpathSync(options['--runtime']);
assert(!/Codex\.app|ChatGPT\.app/i.test(runtime),'Do not reuse the running assistant application runtime');
assert(fs.statSync(runtime).isFile());fs.accessSync(runtime,fs.constants.X_OK);
if(process.platform==='win32')throw new Error('Current RSS sampler is macOS/Linux only; Windows results are not claimed');
const before=staticCheck(false);
const prepared=JSON.parse(fs.readFileSync(path.join(__dirname,'preparation.json'),'utf8'));
assert.deepEqual(before.inputHashes,prepared.inputHashes,'Inputs changed since preparation; recheck before scheduling a window');
const temporary=fs.mkdtempSync(path.join(__dirname,'.tmp-core-placement-'));
const runId=path.basename(temporary).replace('.tmp-core-placement-','run-');
const outputPath=path.join(__dirname,`${runId}.json`);
const result={status:'running',runId,startedAt:new Date().toISOString(),
  measurementWindow:options['--measurement-window'],runtime,runtimeSha256:hash(fs.readFileSync(runtime)),
  plan,environment:{os:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model,
    launcherNode:process.version,logicalCpus:os.cpus().length},
  sourceHashesBefore:before.inputHashes,codeHashes:before.codeHashes,trials:[],failures:[],cleanup:{}};
let active, interrupted;
const children=new Set(), observedPids=new Set();
const abort=signal=>{interrupted=signal;if(active)killGroup(active);};
process.on('SIGINT',abort);process.on('SIGTERM',abort);
function killGroup(child) {
  try {process.kill(-child.pid,'SIGKILL');} catch {try{child.kill('SIGKILL');}catch{}}
}
function alive(pid) {try {process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
async function electron(config) {
  if(interrupted)throw new Error(`Interrupted: ${interrupted}`);
  fs.mkdirSync(config.scratch,{recursive:true});
  const configPath=path.join(config.scratch,'config.json');
  fs.writeFileSync(configPath,JSON.stringify(config));
  const env={...process.env,CORE_PLACEMENT_WINDOW:'explicitly-open',CORE_PLACEMENT_CONFIG:configPath,
    TMPDIR:config.scratch,TMP:config.scratch,TEMP:config.scratch,XDG_CACHE_HOME:path.join(config.scratch,'cache')};
  delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const child=spawn(runtime,[path.join(__dirname,'electron-main.cjs')],{cwd:__dirname,env,detached:true,stdio:['ignore','pipe','pipe']});
  active=child;children.add(child);
  let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout=(stdout+b.toString()).slice(-16000);});
  child.stderr.on('data',b=>{stderr=(stderr+b.toString()).slice(-24000);});
  let timer;
  const exit=await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
    timer=setTimeout(()=>killGroup(child),plan.trialTimeoutMs+10000);
  }).finally(()=>{
    clearTimeout(timer);
    // Each trial owns a dedicated process group. Reap any leftover helper/core
    // even if a watchdog or startup error prevented its normal exit handling.
    killGroup(child);active=undefined;children.delete(child);
  });
  let evidence;
  try {evidence=JSON.parse(fs.readFileSync(config.output,'utf8'));}
  catch(e){throw new Error(`Missing Electron output (${exit.code}/${exit.signal}): ${stderr}\n${e}`);}
  if(evidence.pid)observedPids.add(evidence.pid);
  if(evidence.core?.pid)observedPids.add(evidence.core.pid);
  for(const phase of Object.values(evidence.memory||{}))for(const sample of phase.samples||[])for(const p of sample.processes)observedPids.add(p.pid);
  evidence.process={...exit,stdout,stderr};
  if(exit.code!==0 || evidence.failures.length) {
    result.trials.push(evidence); throw new Error(`Electron ${config.mode}/${config.arm}: ${JSON.stringify(evidence.failures)}`);
  }
  return evidence;
}
const overall=setTimeout(()=>abort('total timeout'),plan.totalTimeoutMs);
(async()=>{
  try {
    const database=path.join(temporary,'seed.sqlite');
    result.seed=await electron({mode:'seed',database,scratch:path.join(temporary,'seed-host'),
      output:path.join(temporary,'seed-output.json'),windowToken:result.measurementWindow});
    const seed=buildFixture(JSON.parse(fs.readFileSync(plan.fixture,'utf8')));
    const commands=makeWorkload(seed);
    const commandsPath=path.join(temporary,'commands.json');fs.writeFileSync(commandsPath,JSON.stringify(commands));
    assert.equal(hash(commands),result.seed.commandSha256);
    result.seedDatabaseSha256=hash(fs.readFileSync(database));
    let index=0;
    for(let round=0;round<plan.rounds.length;round++) for(const arm of plan.rounds[round]) for(const scenario of ['paced','bulk']) {
      if(interrupted)throw new Error(interrupted);
      const name=`${++index}-${round+1}-${arm}-${scenario}`,folder=path.join(temporary,name);
      fs.mkdirSync(folder);
      const db=path.join(folder,'trial.sqlite'),warmup=path.join(folder,'warmup.sqlite');
      fs.copyFileSync(database,db);fs.copyFileSync(database,warmup);
      assert.equal(hash(fs.readFileSync(db)),result.seedDatabaseSha256);
      assert.equal(hash(fs.readFileSync(warmup)),result.seedDatabaseSha256);
      const trial=await electron({mode:'trial',arm,round:round+1,scenario,database:db,warmupDatabase:warmup,
        commands:commandsPath,scratch:path.join(folder,'host'),output:path.join(folder,'trial.json'),windowToken:result.measurementWindow});
      assert.equal(trial.commandSha256,result.seed.commandSha256);
      assert.equal(trial.database.sqlite,result.seed.seed.sqlite);
      assert.deepEqual(trial.database.pragmas,result.seed.seed.pragmas);
      result.trials.push(trial);
      fs.rmSync(folder,{recursive:true,force:true});
    }
    assert.equal(result.trials.length,18);
    const finalHashes=new Set(result.trials.map(t=>t.reopen.snapshotSha256));
    assert.equal(finalHashes.size,1,'All carrier/scenario/round final contents must match');
    assert.equal(hash(fs.readFileSync(database)),result.seedDatabaseSha256,'Prebuilt DB unchanged');
    result.finalSnapshotSha256=[...finalHashes][0];
    result.status='passed';
  } catch(e) {result.status='failed';result.failures.push(e.stack||String(e));}
  finally {
    clearTimeout(overall);
    for(const child of children)killGroup(child);
    // Any previously observed core/helper left behind is part of this run only.
    // Do not report a successful cleanup while it is still present.
    for(let i=0;i<20 && [...observedPids].some(alive);i++)await new Promise(r=>setTimeout(r,100));
    const remaining=[...observedPids].filter(alive);
    result.cleanup.remainingObservedPids=remaining;
    if(remaining.length){result.status='failed';result.failures.push(`Observed child PIDs still alive: ${remaining}`);}
    try {
      result.sourceHashesAfter=staticCheck(false).inputHashes;
      assert.deepEqual(result.sourceHashesAfter,result.sourceHashesBefore);
      result.cleanup.sourceFilesUnchanged=true;
    } catch(e){result.status='failed';result.failures.push(String(e));}
    try {fs.rmSync(temporary,{recursive:true,force:true});result.cleanup.temporaryDirectoryRemoved=!fs.existsSync(temporary);}
    catch(e){result.status='failed';result.failures.push(String(e));}
    result.finishedAt=new Date().toISOString();
    fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
    // Stable pointer, append-only run files retain failed attempts instead of cherry-picking.
    fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify({status:result.status,runFile:path.basename(outputPath),
      measurementWindow:result.measurementWindow,finalSnapshotSha256:result.finalSnapshotSha256,cleanup:result.cleanup,failures:result.failures},null,2)+'\n');
    fs.writeFileSync(path.join(__dirname,'results.md'),require('./report.cjs').report(result)+'\n');
    console.log(JSON.stringify({status:result.status,outputPath,cleanup:result.cleanup,failures:result.failures},null,2));
    if(result.status!=='passed')process.exitCode=1;
  }
})();
