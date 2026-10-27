// One bounded WK-only check after the recorded compiler SIGTRAP. Never reruns Electron.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const temp=await mkdtemp(path.join(os.tmpdir(),'desktop-host-spike-wk-'));
const result={capturedAt:new Date().toISOString(),scope:'WK-only bounded compiler/selection diagnostic',hashes:{}};
let server,host;
function run(command,args,env=process.env){
  const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  let timer;
  const done=new Promise(resolve=>{
    child.once('error',e=>{clearTimeout(timer);resolve({error:String(e),stdout,stderr});});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
    timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  });
  return {child,done};
}
try{
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const serving=run('python3',['-u',path.resolve(root,'../architecture-spike/start.py'),'--port',String(port)]);server=serving.child;
  const url=`http://127.0.0.1:${port}/?count=500&mode=managed&dynamic=1`;result.url=url;
  let ready=false;
  for(let i=0;i<60;i++){try{if((await fetch(url)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  if(!ready)throw new Error('Service unavailable');
  const compilation=run('swiftc',['-module-cache-path',path.join(temp,'swift-cache'),path.join(root,'wk-host.swift'),'-o',path.join(temp,'wk-host')],{...process.env,TMPDIR:temp});
  result.compilation=await compilation.done;
  if(result.compilation.code!==0)throw new Error('WK compiler failed again; no further retries');
  const running=run(path.join(temp,'wk-host'),[url,path.join(root,'renderer-probe.js'),path.join(temp,'wk.json'),path.join(root,'wk-content.png')],{...process.env,TMPDIR:temp});host=running.child;
  result.process=await running.done;
  result.wk=JSON.parse(await readFile(path.join(temp,'wk.json'),'utf8'));
  server.kill('SIGTERM');result.server=await serving.done;
}catch(e){result.failure=String(e.stack||e);}
finally{
  for(const child of [server,host])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  await rm(temp,{recursive:true,force:true});result.cleaned=true;
  for(const name of ['wk-recheck.mjs','wk-host.swift','renderer-probe.js'])result.hashes[name]=createHash('sha256').update(await readFile(path.join(root,name))).digest('hex');
  await writeFile(path.join(root,'wk-recheck.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({compilation:result.compilation,failure:result.failure,checks:result.wk?.renderer?.checks.map(({name,pass})=>({name,pass})),diagnostic:result.wk?.renderer?.selectionPrefixDiagnostic},null,2));
if(result.failure||result.wk?.failure||result.wk?.renderer?.failure||result.wk?.renderer?.checks.some(x=>!x.pass))process.exitCode=1;
