import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';

const root=path.dirname(fileURLToPath(import.meta.url)), architecture=path.resolve(root,'../architecture-spike');
const temporary=await mkdtemp(path.join(os.tmpdir(),'desktop-host-spike-'));
const result={capturedAt:new Date().toISOString(),scope:'Bounded macOS desktop host experiment; no formal application changes',
  sample:'Existing built 500 managed dynamic page, derived from 84 real units',
  environment:{os:execFileSync('sw_vers',[],{encoding:'utf8'}).trim(),kernel:os.release(),arch:os.arch(),cpu:os.cpus()[0].model,node:process.version},
  cleanup:{},checks:[],hashes:{},failures:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,evidence)=>result.checks.push({name,pass:Boolean(pass),evidence});
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
async function manifest(dir,prefix='') {
  const map={};
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const relative=path.join(prefix,entry.name);
    if(entry.isDirectory())Object.assign(map,await manifest(path.join(dir,entry.name),relative));
    else if(entry.isFile())map[relative]=await sha(path.join(dir,entry.name));
  }
  return map;
}
const before=await manifest(architecture);
result.hashes.architecture=before;
for(const relative of ['../style-math-prototype/vendor/mathlive/mathlive.min.js','../../legacy/review-board/web/content/provider.js']) {
  // Shared assets get explicit hashes where resolvable, without copying or modifying them.
  const full=path.resolve(architecture,relative);
  result.hashes[relative]=await sha(full);
}
let server, electron, wk;
function run(command,args,options={}) {
  const child=spawn(command,args,{cwd:root,stdio:['ignore','pipe','pipe'],...options});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  let timer;
  const completion=new Promise(resolve=>{
    child.once('error',error=>resolve({error:String(error),stdout,stderr}));
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
    timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();},80000);
  });
  return {child,completion};
}
try {
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
  const port=socket.address().port;await new Promise(r=>socket.close(r));
  const serverRun=run('python3',['-u',path.join(architecture,'start.py'),'--port',String(port)]);
  server=serverRun.child;
  const origin=`http://127.0.0.1:${port}`;
  const url=origin+'/?count=500&mode=managed&dynamic=1';result.url=url;
  let ready=false;
  for(let i=0;i<60;i++){try{if((await fetch(origin)).ok){ready=true;break;}}catch{}await delay(50);}
  if(!ready)throw new Error('Dedicated readonly service unavailable');
  const executable=(await readFile(path.join(root,'node_modules/electron/path.txt'),'utf8')).trim();
  const binary=path.join(root,'node_modules/electron/dist',executable);
  result.electronBinary='Locally installed npm electron runtime; never Codex.app';
  const env={...process.env,SPIKE_TEMP:temporary,SPIKE_URL:url};delete env.ELECTRON_RUN_AS_NODE;
  const electronRun=run(binary,[path.join(root,'electron-main.cjs')],{env});electron=electronRun.child;
  result.electronProcess=await electronRun.completion;
  try{result.electron=JSON.parse(await readFile(path.join(temporary,'electron.json'),'utf8'));}catch(e){result.failures.push('Electron output: '+e);}
  if(result.electron){
    const pid=result.electron.finalTask?.workerPid;let alive=false;
    if(pid)try{process.kill(pid,0);alive=true;}catch{}
    result.cleanup.workerPid=pid;result.cleanup.workerAliveAfterHostExit=alive;
    check('Electron host exited and managed worker absent',result.electronProcess.code===0 && Boolean(pid) && !alive);
    if(alive)process.kill(pid,'SIGTERM');
  }

  // No Xcode or Rust installation: compile only with the already available CLT.
  try{
    result.environment.swift=execFileSync('swift',['--version'],{encoding:'utf8'}).trim();
    const compilation=run('swiftc',['-module-cache-path',path.join(temporary,'swift-cache'),path.join(root,'wk-host.swift'),'-o',path.join(temporary,'wk-host')],{env:{...process.env,TMPDIR:temporary}});
    result.wkCompilation=await compilation.completion;
    if(result.wkCompilation.code===0){
      const wkRun=run(path.join(temporary,'wk-host'),[url,path.join(root,'renderer-probe.js'),path.join(temporary,'wk.json'),path.join(root,'wk-content.png')]);
      wk=wkRun.child;result.wkProcess=await wkRun.completion;
      result.wk=JSON.parse(await readFile(path.join(temporary,'wk.json'),'utf8'));
    }else result.failures.push('Swift compile failed; see wkCompilation');
  }catch(e){result.failures.push('WKWebView unavailable: '+String(e));}
  server.kill('SIGTERM');result.serverProcess=await serverRun.completion;
}catch(e){result.failures.push(String(e.stack||e));}
finally{
  for(const child of [electron,wk,server])if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
  check('Original architecture tree byte-for-byte unchanged',JSON.stringify(await manifest(architecture))===JSON.stringify(before));
  for(const file of ['run.mjs','renderer-probe.js','electron-main.cjs','preload.cjs','worker.py','wk-host.swift','sqlite-capability.cjs','package.json','package-lock.json'])result.hashes[file]=await sha(path.join(root,file));
  await rm(temporary,{recursive:true,force:true});result.cleanup.runTemporaryDirectoryRemoved=true;
  // npm runtime/dependency caches are explicitly temporary for this experiment.
  for(const name of ['node_modules','.runtime-cache','.npm-cache','.install-temp','.compile-temp'])await rm(path.join(root,name),{recursive:true,force:true});
  result.cleanup.dependenciesAndCachesRemoved=true;
  result.completedAt=new Date().toISOString();
  await writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({checks:result.checks,electron:result.electron?.checks,renderer:result.electron?.renderer?.checks,
  electronFailure:result.electron?.failure,rendererFailure:result.electron?.renderer?.failure,
  wk:result.wk?.renderer?.checks,wkFailure:result.wk?.failure||result.wk?.renderer?.failure,failures:result.failures},null,2));
if(result.failures.length || result.checks.some(x=>!x.pass) || result.electron?.failure || result.electron?.renderer?.failure ||
 result.electron?.checks.some(x=>!x.pass) || result.electron?.renderer?.checks.some(x=>!x.pass) ||
 result.wk?.failure || result.wk?.renderer?.failure || result.wk?.renderer?.checks.some(x=>!x.pass))process.exitCode=1;
