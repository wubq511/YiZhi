#!/usr/bin/env node
/** Isolated, opt-in pan diagnosis. Never connect to a user's running app or course. */
import { createRequire } from 'node:module';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, appendFile, rm, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cpus, loadavg, hostname } from 'node:os';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(project,'desktop/package.json'));
const { _electron:electron, chromium }=require('@playwright/test');
const sleep=ms=>delay(ms);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>performance.now();
const usage=`Usage: node tools/desktop/diagnose-pan.mjs --app /absolute/isolated/YiZhi.app --course /absolute/test-course --out /absolute/evidence [options]
  --cold N --hot N        First gesture after N launches; then N warm gestures (default 1, 0)
  --capture on|off        CDP screencast (default on)
  --retain-screen on|off  Keep up to 200 compressed frames in memory, matching the original test (default on)
  --trace on|off          Continuous bounded Chromium trace (default off)
  --driver playwright|cdp|paced (default playwright)
  --launch playwright|native   (default playwright)
  --focus unchanged|front|blur (default unchanged; explicit focus requires Playwright launch)
  --focus-wait-ms N       Diagnostic pause before verifying front focus (default 0)
  --pair capture|retention|trace|driver|cadence|launch|focus --pairs N   Alternate paired comparisons (default N=20)
  --calibrate on|off      Check renderer, driver and screencast-ack injections (default off)
  --inject none|renderer|driver|ack (default none; calibration only)
  --reset-zoom N          Zoom-out clicks after fit (default 2)
  --stop-on-gap N         Stop after a gesture reaches N ms (default 0: disabled)
  --stop-on-command N     Stop after a mouse command reaches N ms (default 0: disabled)
  --max-minutes N         Maximum collection time (default 30)
  --expected-themes N     Optional fixture assertion
  --expected-members N    Optional fixture assertion
No screenshots, traces, course data or logs are sent anywhere.`;
function argumentsOf(args){
 const flags={cold:'1',hot:'0',capture:'on','retain-screen':'on',trace:'off',driver:'playwright',launch:'playwright',focus:'unchanged','focus-wait-ms':'0',calibrate:'off',inject:'none',pairs:'20','reset-zoom':'2','stop-on-gap':'0','stop-on-command':'0','max-minutes':'30'};
 for(let i=0;i<args.length;i++){
  const key=args[i];if(key==='--help'){console.log(usage);process.exit(0);}
  if(!key.startsWith('--')||i+1>=args.length||args[i+1].startsWith('--'))throw Error('Expected option and value: '+key);
  flags[key.slice(2)]=args[++i];
 }
 const allowed=new Set(['app','course','out','cold','hot','capture','retain-screen','trace','driver','launch','focus','focus-wait-ms','pair','pairs','calibrate','inject','reset-zoom','stop-on-gap','stop-on-command','max-minutes','expected-themes','expected-members']);
 for(const key of Object.keys(flags))if(!allowed.has(key))throw Error('Unknown option --'+key);
 for(const key of ['app','course','out'])if(!flags[key]||!flags[key].startsWith('/'))throw Error('--'+key+' requires an absolute path');
 for(const key of ['cold','hot','pairs','reset-zoom','focus-wait-ms','stop-on-gap','stop-on-command','max-minutes','expected-themes','expected-members'])if(flags[key]!==undefined){
  const n=Number(flags[key]);if(!Number.isFinite(n)||n<0||(['cold','hot','pairs','reset-zoom','expected-themes','expected-members'].includes(key)&&!Number.isInteger(n)))throw Error('Invalid --'+key);
  flags[key]=n;
 }
 if(!flags.cold&&!flags.hot&&!flags.pair&&flags.calibrate!=='on')throw Error('Choose at least one gesture');
 if(!flags['max-minutes'])throw Error('--max-minutes must be positive');
 if(flags.pair&&!['capture','retention','trace','driver','cadence','launch','focus'].includes(flags.pair))throw Error('Invalid --pair');
 if(flags.pair&&!flags.pairs)throw Error('--pairs must be positive');
 for(const [key,allowedValues] of Object.entries({capture:['on','off'],'retain-screen':['on','off'],trace:['on','off'],driver:['playwright','cdp','paced'],launch:['playwright','native'],focus:['unchanged','front','blur'],calibrate:['on','off'],inject:['none','renderer','driver','ack']}))if(!allowedValues.includes(flags[key]))throw Error('Invalid --'+key);
 if(flags.launch==='native'&&flags.focus!=='unchanged')throw Error('Native launch cannot verify OS focus; use Playwright launch for focus experiments');
 if(flags.pair==='focus'&&flags.launch==='native')throw Error('Focus pairs require Playwright launch for native-state verification');
 if(flags.pair==='launch'&&flags.focus!=='unchanged')throw Error('Launch pairs cannot verify OS focus on the native-launch side');
 if(flags.inject==='ack'&&flags.capture!=='on')throw Error('ack injection requires capture=on');
 return flags;
}
const options=argumentsOf(process.argv.slice(2));
const appPath=resolve(options.app),coursePath=resolve(options.course),outPath=resolve(options.out);
const executable=join(appPath,'Contents/MacOS/YiZhi'),manifestFile=join(appPath,'Contents/Resources/app/package-manifest.json');
const scratchRoot=join(project,'artifacts/scratch/pan-diagnostic');
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const workRoot=join(scratchRoot,runId);
const inside=(parent,child)=>{const r=relative(parent,child);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!r.startsWith('/'));};
if(inside(coursePath,outPath)||inside(outPath,coursePath)||inside(appPath,outPath)||inside(outPath,appPath))throw Error('App, course and output must be independent directories');
await stat(executable);await stat(join(coursePath,'course.sqlite'));
if(await realpath(appPath)==='/Applications/YiZhi.app')throw Error('Use an isolated app copy; never instrument the user installation');
const wal=join(coursePath,'course.sqlite-wal');
if(existsSync(wal)&&(await stat(wal)).size)throw Error('Input course has a nonempty WAL; use a stopped, checkpointed copy');
await mkdir(outPath,{recursive:true});await mkdir(workRoot,{recursive:true});
const manifest=await readFile(manifestFile);const manifestHash=hash(manifest);
const executableHash=hash(await readFile(executable)),infoPlistHash=hash(await readFile(join(appPath,'Contents/Info.plist')));
const courseHash=hash(await readFile(join(coursePath,'course.sqlite')));
const runMeta={schema:'yizhi-pan-diagnosis-1',runId,startedAt:new Date().toISOString(),options,manifestHash,executableHash,infoPlistHash,courseHash,
 runtime:{node:process.versions.node,platform:process.platform,arch:process.arch,cpus:cpus().length,cpu:cpus()[0]?.model,host:hostname()},
 limits:{events:4096,thresholdMs:100,retainContextMs:50},inputIsPhysical:false};
await writeFile(join(outPath,runId+'-meta.json'),JSON.stringify(runMeta,null,2)+'\n',{flag:'wx'});
const recordsPath=join(outPath,runId+'-runs.jsonl');
let sessionNo=0,gestureNo=0,abnormal=0,unexpectedAbnormal=0,completed=0,errors=0,stop=false,stopReason=null;const calibrationChecks=[];
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stop=true;stopReason='interrupted';});
const start=now(),allGaps=[];

function samplesCpu(){return cpus().map(c=>c.times);}
function cpuDifference(a,b){let busy=0,total=0;for(let i=0;i<a.length;i++){const x=a[i],y=b[i],d=(y.user+y.nice+y.sys+y.idle+y.irq)-(x.user+x.nice+x.sys+x.idle+x.irq);total+=d;busy+=d-(y.idle-x.idle);}return total?busy/total:0;}
async function cloneCourse(to){
 await cp(coursePath,to,{recursive:true,filter:source=>!/(?:^|\/)(?:ownership\.sqlite(?:-wal|-shm)?|course\.sqlite-(?:wal|shm)|backup-(?:manifest|complete)\.json)$/.test(source)});
 const db=new DatabaseSync(join(to,'course.sqlite'));
 try{const res=db.prepare("UPDATE metadata SET value=? WHERE key='courseId'").run('pan-diagnostic-'+randomUUID());if(Number(res.changes)!==1)throw Error('Input course has no courseId');}
 finally{db.close();}
}
async function nativeLaunch(profile,course){
 const child=spawn(executable,[`--course=${course}`,'--remote-debugging-port=0'],{env:{...process.env,YIZHI_OBSERVE:'1',YIZHI_DATA_HOME:profile,YIZHI_CODEX_PATH:join(profile,'missing-cli')},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>{stderr=(stderr+d.toString()).slice(-8000);});child.stdout.resume();
 let port,endpoint,browser;
 try{
 for(let i=0;i<200;i++){
  if(child.exitCode!==null)throw Error('Native app exited early: '+stderr.slice(-1000));
  const file=join(profile,'DevToolsActivePort');
  if(existsSync(file)){const parts=(await readFile(file,'utf8')).trim().split('\n');port=Number(parts[0]);endpoint=`http://127.0.0.1:${port}`;break;}
  const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){endpoint=match[1];break;}
  await sleep(100);
 }
 if(!endpoint)throw Error('Native app did not expose its isolated DevTools port: '+stderr.slice(-1000));
 browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0];
 let page=context.pages().find(p=>p.url().startsWith('yizhi-app:'));
 for(let i=0;!page&&i<150;i++){await sleep(100);page=context.pages().find(p=>p.url().startsWith('yizhi-app:'));}
 if(!page)throw Error('Native app has no course page');
 return {browser,context,page,child,app:null};
 }catch(error){
  await browser?.close().catch(()=>{});
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(3000)]);}
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}
  throw error;
 }
}
async function launch(){
 const session=++sessionNo,base=join(workRoot,'session-'+session),profile=join(base,'profile'),course=join(base,'course');
 await mkdir(base,{recursive:true});await cloneCourse(course);
 if(options.launch==='native')return {...await nativeLaunch(profile,course),base,session};
 const app=await electron.launch({executablePath:executable,args:[`--course=${course}`],env:{...process.env,YIZHI_OBSERVE:'1',YIZHI_DATA_HOME:profile,YIZHI_CODEX_PATH:join(profile,'missing-cli')}});
 return {app,context:app.context(),page:await app.firstWindow(),child:app.process(),base,session,browser:null};
}
async function close(launched){
 if(launched.app){await launched.app.close();}
 else {
  await launched.browser.close().catch(()=>{});
  if(launched.child.exitCode===null){launched.child.kill('SIGTERM');await Promise.race([new Promise(r=>launched.child.once('exit',r)),sleep(3000)]);}
  if(launched.child.exitCode===null){launched.child.kill('SIGKILL');await new Promise(r=>launched.child.once('exit',r));}
 }
 await rm(launched.base,{recursive:true,force:true});
}
async function nativeState(launched){
 if(!launched.app)return {available:false};
 return launched.app.evaluate(({BrowserWindow,app})=>({available:true,windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused(),minimized:w.isMinimized(),bounds:w.getBounds(),content:w.getContentSize()})),metrics:app.getAppMetrics().map(m=>({pid:m.pid,type:m.type,cpu:m.cpu}))}));
}
async function initWindow(l){
 const {page,app,context}=l;await page.locator('.workspace').waitFor({state:'visible',timeout:30000});
 await page.waitForFunction(()=>document.querySelector('.workspace')?.getAttribute('aria-busy')==='false',null,{timeout:30000});
 if(app)await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1024,768));
 else {
  const size=await page.evaluate(()=>{window.resizeTo(1024,768);return {outer:[outerWidth,outerHeight],inner:[innerWidth,innerHeight]};});
  if(size.outer[0]!==1024||size.outer[1]!==768)throw Error('Native window resize unavailable: '+JSON.stringify(size));
 }
 if(app&&options.pair==='focus'&&process.platform==='darwin')await app.evaluate(({app})=>app.setActivationPolicy('regular'));
 if(options.focus==='front'){if(app)await app.evaluate(({BrowserWindow,app})=>{const w=BrowserWindow.getAllWindows()[0];app.focus({steal:true});w.show();w.moveTop();w.focus();});else await page.bringToFront();}
 if(options.focus==='blur')await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].blur());
 await page.locator('.board-route-ink').first().waitFor({state:'attached',timeout:30000});
 return nativeState(l);
}
async function prepareView(page){
 await page.getByRole('button',{name:'全图',exact:true}).click();
 for(let i=0;i<options['reset-zoom'];i++)await page.getByRole('button',{name:'缩小画板'}).click();
 let last=-1,stable=0;
 for(let i=0;i<40&&stable<2;i++){
  const count=await page.evaluate(()=>window.__yizhiObservation?.()['board.labelLayouts']?.count??0);
  stable=count===last?stable+1:0;last=count;await sleep(80);
 }
 if(stable<2)throw Error('Label layout did not settle');
 const state=await page.evaluate(()=>({themes:document.querySelectorAll('.board-theme').length,
  members:[...document.querySelectorAll('.board-route')].flatMap(e=>JSON.parse(e.getAttribute('data-members')||'[]')).length,
  labels:document.querySelectorAll('.board-route-label').length,inner:[innerWidth,innerHeight],dpr:devicePixelRatio,
  zoom:document.querySelector('.canvas-zoom')?.textContent,visibility:document.visibilityState,focused:document.hasFocus()}));
 if(options['expected-themes']!==undefined&&state.themes!==options['expected-themes'])throw Error('Unexpected theme count: '+state.themes);
 if(options['expected-members']!==undefined&&state.members!==options['expected-members'])throw Error('Unexpected relation member count: '+state.members);
 const point=await page.evaluate(()=>{
  const board=document.querySelector('main.board'),rect=board.getBoundingClientRect();
  const left=Math.max(12,rect.left+12),right=Math.min(innerWidth-12,rect.right-12),top=Math.max(12,rect.top+12),bottom=Math.min(innerHeight-12,rect.bottom-12);
  const blocked='.board-tools, .relations-panel, .source-dialog, .react-flow__minimap, .drawing-tools, .drawing-entry, .follow-control, input, select, textarea, button, .mux, .builtin-formula-editor, math-field';
  for(const y of [top+(bottom-top)/2,top+(bottom-top)*.75,top+(bottom-top)/3])for(const x of [left+38,(left+right)/2,right-24]){
   const hit=document.elementFromPoint(x,y);if(x>=left&&x<=right&&y>=top&&y<=bottom&&hit?.closest('main.board')===board&&!hit.closest(blocked)&&!hit.closest('[inert]'))return {x,y};
  }throw Error('No unobstructed board point');
 });
 // The original failing production scenario performed this short pan first.
 await page.mouse.move(point.x,point.y);await page.mouse.down();for(let i=1;i<=6;i++)await page.mouse.move(point.x+i*2,point.y+i);await page.mouse.up();
 await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 return {state,point};
}
async function calibrate(page){
 const attempts=[];
 for(let i=0;i<5;i++){
  const before=now(),result=await page.evaluate(()=>({page:performance.now(),timeOrigin:performance.timeOrigin,wall:Date.now()})),after=now();
  attempts.push({before,after,page:result.page,timeOrigin:result.timeOrigin,wall:result.wall,offset:result.page-(before+after)/2,uncertainty:(after-before)/2});
 }
 return attempts.sort((a,b)=>a.uncertainty-b.uncertainty)[0];
}
async function beginProbe(page){
 await page.evaluate(()=>{
  const p={frames:[],inputs:[],longtasks:[],visibility:[],timers:[],dropped:{frames:0,inputs:0,longtasks:0,visibility:0,timers:0},running:true};
  const push=(k,v)=>{if(p[k].length<4096)p[k].push(v);else p.dropped[k]++;};
  window.__panDiagnosis=p;
  p.observer=new PerformanceObserver(list=>{for(const e of list.getEntries())push('longtasks',{start:e.startTime,duration:e.duration});});
  try{p.observer.observe({type:'longtask',buffered:false});}catch{p.longTaskUnavailable=true;}
  p.input=e=>push('inputs',{now:performance.now(),eventTime:e.timeStamp,x:e.clientX,y:e.clientY,buttons:e.buttons,type:e.type});
  p.visible=()=>push('visibility',{now:performance.now(),visible:document.visibilityState,focused:document.hasFocus()});
  document.addEventListener('pointermove',p.input,{capture:true,passive:true});
  document.addEventListener('visibilitychange',p.visible);window.addEventListener('focus',p.visible);window.addEventListener('blur',p.visible);
  p.timer=setInterval(()=>push('timers',performance.now()),10);
  performance.mark('pan-diagnosis-start');
  const tick=t=>{if(!p.running)return;const el=document.querySelector('.react-flow__viewport'),v=el&&Array.from(el.attributeStyleMap.get('transform'));
   if(v?.length===2)push('frames',{t,now:performance.now(),x:v[0].x.value,y:v[0].y.value,zoom:v[1].x.value});requestAnimationFrame(tick);};
  requestAnimationFrame(tick);
 });
}
async function endProbe(page){
 return page.evaluate(()=>{const p=window.__panDiagnosis;p.running=false;clearInterval(p.timer);performance.mark('pan-diagnosis-end');
  p.observer.disconnect();document.removeEventListener('pointermove',p.input,true);document.removeEventListener('visibilitychange',p.visible);window.removeEventListener('focus',p.visible);window.removeEventListener('blur',p.visible);
  return {frames:p.frames,inputs:p.inputs,longtasks:p.longtasks,visibility:p.visibility,timers:p.timers,dropped:p.dropped,longTaskUnavailable:p.longTaskUnavailable??false};});
}
function gapsFor(samples){
 let first=-1,last=-1;for(let i=1;i<samples.length;i++)if(samples[i].x!==samples[i-1].x||samples[i].y!==samples[i-1].y){if(first<0)first=i;last=i;}
 if(first<0)return [];
 return samples.slice(first,last+1).map((s,j)=>{const prev=samples[first+j-1];return {start:prev.t,end:s.t,gap:s.t-prev.t,callbackStart:prev.now,callbackEnd:s.now,callbackGap:s.now-prev.now};});
}
function cameraChangeGaps(samples){
 const changes=samples.filter((s,i)=>i>0&&(s.x!==samples[i-1].x||s.y!==samples[i-1].y));
 return changes.slice(1).map((s,i)=>({start:changes[i].now,end:s.now,gap:s.now-changes[i].now,
  from:{x:changes[i].x,y:changes[i].y},to:{x:s.x,y:s.y}})).sort((a,b)=>b.gap-a.gap);
}
async function gesture(l){
 const {page,context}=l,id=++gestureNo,{state,point}=await prepareView(page);
 if(options.focus==='front'){if(l.app)await l.app.evaluate(({BrowserWindow,app})=>{const w=BrowserWindow.getAllWindows()[0];app.focus({steal:true});w.moveTop();w.focus();});else await page.bringToFront();}
 if(options.focus==='blur')await l.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].blur());
 if(options.focus==='front'&&options['focus-wait-ms']){console.log('[pan-focus-wait]',JSON.stringify({session:l.session,milliseconds:options['focus-wait-ms']}));await sleep(options['focus-wait-ms']);}
 if(l.app&&options.focus!=='unchanged'){
  let correct=false;
  for(let i=0;i<10;i++){
   const focused=await l.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFocused());
   if(focused===(options.focus==='front')){correct=true;break;}
   await l.app.evaluate(({BrowserWindow,app},mode)=>{const w=BrowserWindow.getAllWindows()[0];if(mode==='front'){app.focus({steal:true});w.show();w.moveTop();w.focus();}else w.blur();},options.focus);
   await sleep(100);
  }
  if(!correct)throw Error('Native focus did not reach requested state: '+options.focus);
 }
 Object.assign(state,await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus()})));
 const nativeBefore=await nativeState(l);
 const cdp=await context.newCDPSession(page),screen=[],retainedFrames=[],acks=[],traceEvents=[];let moving=false,ackInjected=false,traceStarted=false,traceUnavailable=null,traceComplete;
 const onScreen=frame=>{
  if(screen.length<4096)screen.push({at:now(),timestamp:frame.metadata?.timestamp,sessionId:frame.sessionId});
  if(options['retain-screen']==='on'&&retainedFrames.length<200)retainedFrames.push(frame.data);
  const at=now(),injected=options.inject==='ack'&&moving&&!ackInjected;if(injected)ackInjected=true;
  const send=()=>{const sent=now();void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).then(()=>{if(acks.length<4096)acks.push({at,sent,done:now(),injected});}).catch(()=>{});};
  if(injected)setTimeout(send,150);else send();
 };
 if(options.capture==='on'){cdp.on('Page.screencastFrame',onScreen);await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,everyNthFrame:1});}
 if(options.trace==='on'){
  try{
   const categories=await cdp.send('Tracing.getCategories'),wanted=['devtools','devtools.timeline','disabled-by-default-devtools.timeline.frame','blink','blink.user_timing','cc','gpu','viz','input','latency','toplevel','renderer.scheduler','v8'];
   // Some Electron builds return no categories until tracing has started. An
   // empty filter would enable all default categories and distort the sample.
   const discovered=categories.categories.flatMap(x=>x.split(','));
   traceComplete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
   await cdp.send('Tracing.start',{traceConfig:{recordMode:'recordContinuously',traceBufferSizeInKb:65536,includedCategories:wanted},transferMode:'ReturnAsStream'});
   traceStarted=true;
   let afterStart=[],discoveryError=null;
   try{afterStart=(await cdp.send('Tracing.getCategories')).categories.flatMap(x=>x.split(','));}catch(error){discoveryError=String(error);}
   traceEvents.push({requested:wanted,discovered,afterStart,available:wanted.filter(x=>afterStart.includes(x)),discoveryEmpty:discovered.length===0&&afterStart.length===0,discoveryError});
  }catch(e){traceUnavailable=String(e);}
 }
 const loop=monitorEventLoopDelay({resolution:10});loop.enable();let cpuPrevious=samplesCpu();const host=[],loopTicks=[];let tickExpected=now()+20;
 const hostTimer=setInterval(()=>{const t=now(),next=samplesCpu();if(host.length<4096)host.push({t,busy:cpuDifference(cpuPrevious,next),load:loadavg()});cpuPrevious=next;},200);
 const loopTimer=setInterval(()=>{const t=now();if(loopTicks.length<4096)loopTicks.push({t,late:Math.max(0,t-tickExpected)});tickExpected=t+20;},20);
 l.disarm=()=>{clearInterval(hostTimer);clearInterval(loopTimer);loop.disable();};
 const before=await calibrate(page),driver=[],gestureStartedAt=new Date().toISOString();
 await page.mouse.move(point.x,point.y);await page.mouse.down();await beginProbe(page);moving=true;
 const cdpMove=(x,y)=>cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x,y,force:.5});
 let nextPacedSend=now();
 for(let i=1;i<=80;i++){
  if(options.driver==='paced'){const remaining=nextPacedSend-now();if(remaining>0)await sleep(remaining);}
  const sent=now();if(options.driver==='paced')nextPacedSend=sent+16.667;
  if(options.driver==='playwright')await page.mouse.move(point.x+i*2,point.y+i);else await cdpMove(point.x+i*2,point.y+i);
  driver.push({i,sent,done:now()});
  if(i===40&&options.inject==='driver')await sleep(150);
  if(i===40&&options.inject==='renderer')await page.evaluate(()=>new Promise(resolve=>setTimeout(()=>{const t=performance.now();while(performance.now()-t<150){}resolve();},0)));
 }
 await page.mouse.up();moving=false;await sleep(100);const data=await endProbe(page);const after=await calibrate(page);
 l.disarm();
 const gaps=gapsFor(data.frames).sort((a,b)=>b.gap-a.gap),changes=cameraChangeGaps(data.frames),max=gaps[0]?.gap??null;
 let traceMeta=null;
 if(traceStarted){
  await cdp.send('Tracing.end');const complete=await traceComplete;traceMeta={...traceEvents[0],dataLossOccurred:complete.dataLossOccurred??null,stream:!!complete.stream};
  const callbackMax=Math.max(0,...gaps.map(g=>g.callbackGap));
  const commandMax=Math.max(0,...driver.map(d=>d.done-d.sent));
  if(complete.stream){
   if((max??0)>=50||callbackMax>=50||commandMax>=50||(changes[0]?.gap??0)>=50||options.inject!=='none'){
    const file=join(outPath,`${runId}-gesture-${id}-trace.json`),chunks=[];
    for(;;){const read=await cdp.send('IO.read',{handle:complete.stream});chunks.push(read.base64Encoded?Buffer.from(read.data,'base64'):Buffer.from(read.data));if(read.eof)break;}
    await writeFile(file,Buffer.concat(chunks));traceMeta.file=file;
   }
   await cdp.send('IO.close',{handle:complete.stream});
  }
 }
 if(options.capture==='on'){await cdp.send('Page.stopScreencast');cdp.off('Page.screencastFrame',onScreen);}
 await cdp.detach();const nativeAfter=await nativeState(l);
 const withContext=g=>({...g,
  inputsBetweenFrameTimes:data.inputs.filter(e=>e.now>=g.start&&e.now<=g.end),
  inputsBetweenCallbacks:data.inputs.filter(e=>e.now>=g.callbackStart&&e.now<=g.callbackEnd),
  timersBetweenCallbacks:data.timers.filter(t=>t>=g.callbackStart&&t<=g.callbackEnd).length,
  longtasksAcrossCallbacks:data.longtasks.filter(e=>e.start<g.callbackEnd&&e.start+e.duration>g.callbackStart)});
 const largest=gaps.slice(0,8).map(withContext),largestCallbacks=[...gaps].sort((a,b)=>b.callbackGap-a.callbackGap).slice(0,8).map(withContext);
 const desiredFocus=options.focus==='unchanged'?null:options.focus==='front';
 const nativeFocusVerified=desiredFocus===null?null:nativeBefore.available&&nativeAfter.available&&
  nativeBefore.windows[0]?.focused===desiredFocus&&nativeAfter.windows[0]?.focused===desiredFocus;
 const outcome={schema:'yizhi-pan-gesture-1',runId,id,session:l.session,pair:l.pair??null,startedAt:gestureStartedAt,mode:{capture:options.capture,retainScreen:options['retain-screen'],trace:options.trace,driver:options.driver,launch:options.launch,focus:options.focus,inject:options.inject},
  state,point,nativeBefore,nativeAfter,nativeFocusVerified,calibration:{before,after,offsetDrift:after.offset-before.offset},maxGapMs:max,maxCameraChangeGapMs:changes[0]?.gap??null,cameraChangeGaps:changes.slice(0,8),maxCommandMs:Math.max(0,...driver.map(d=>d.done-d.sent)),largest,largestCallbacks,screen,retainedFrameCount:retainedFrames.length,acks,driver,host,loopTicks,
  eventLoopDelay:{meanMs:Number.isFinite(loop.mean)?loop.mean/1e6:null,maxMs:loop.max/1e6,p99Ms:loop.percentile(99)/1e6},data,trace:traceMeta,traceUnavailable};
 await appendFile(recordsPath,JSON.stringify(outcome)+'\n');completed++;if(max!==null)allGaps.push(max);if(max!==null&&max>=100){abnormal++;if(options.inject==='none')unexpectedAbnormal++;}
 console.log(JSON.stringify({runId,id,session:l.session,maxGapMs:max,maxCallbackGapMs:largestCallbacks[0]?.callbackGap??null,maxCameraChangeGapMs:outcome.maxCameraChangeGapMs,maxCommandMs:outcome.maxCommandMs,frames:data.frames.length,inputs:data.inputs.length,screenFrames:screen.length,longtasks:data.longtasks,focus:state.focused,trace:traceMeta?.file??traceUnavailable,inject:options.inject}));
 if(max===null)throw Error('No camera movement observed');
 if(nativeFocusVerified===false){errors++;stop=true;stopReason='focus-changed';}
 if(options['stop-on-gap']&&max>=options['stop-on-gap']){stop=true;stopReason='frame-gap';}
 if(options['stop-on-command']&&outcome.maxCommandMs>=options['stop-on-command']){stop=true;stopReason??='command-delay';}
 return outcome;
}
async function safeGesture(l){try{return await gesture(l);}catch(error){errors++;stop=true;stopReason='error';const failure={schema:'yizhi-pan-error-1',runId,id:gestureNo,session:l.session,message:String(error?.stack??error)};await appendFile(recordsPath,JSON.stringify(failure)+'\n');console.error(JSON.stringify(failure));}finally{l.disarm?.();}}
try{
 if(options.calibrate==='on'){
  const prior={capture:options.capture,trace:options.trace,inject:options.inject};
  options.capture='on';options.trace='on';const l=await launch();
  try{await initWindow(l);for(const kind of ['renderer','driver','ack']){
   options.inject=kind;const result=await safeGesture(l);if(!result)break;
   const test=kind==='renderer'?result.data.longtasks.some(t=>t.duration>=140)&&result.maxGapMs>=100
    :kind==='driver'?result.driver[40].sent-result.driver[39].done>=140
    :result.acks.some(a=>a.injected&&a.sent-a.at>=140);
   const traceOK=!!result.trace?.file&&!result.trace.dataLossOccurred;
   calibrationChecks.push({kind,pass:test&&traceOK,signal:test,traceOK});
   if(!test||!traceOK){errors++;stop=true;stopReason='calibration-failed';break;}
  }}finally{await close(l);Object.assign(options,prior);}
 }
 for(let i=0;i<options.cold&&!stop;i++){
  if((now()-start)/60000>=options['max-minutes']){stop=true;stopReason='max-time';break;}
  const l=await launch();try{await initWindow(l);await safeGesture(l);}finally{await close(l);}
 }
 if(options.hot&&!stop){const l=await launch();try{await initWindow(l);for(let i=0;i<options.hot&&!stop;i++){
  if((now()-start)/60000>=options['max-minutes']){stop=true;stopReason='max-time';break;}await safeGesture(l);
 }}finally{await close(l);}}
 if(options.pair&&!stop){
  const variants={capture:[{capture:'on'},{capture:'off'}],retention:[{capture:'on','retain-screen':'on'},{capture:'on','retain-screen':'off'}],
   trace:[{trace:'on'},{trace:'off'}],driver:[{driver:'playwright'},{driver:'cdp'}],cadence:[{driver:'cdp'},{driver:'paced'}],
   launch:[{launch:'playwright',driver:'cdp'},{launch:'native',driver:'cdp'}],focus:[{focus:'front'},{focus:'blur'}]}[options.pair];
  for(let i=0;i<options.pairs&&!stop;i++){
   if((now()-start)/60000>=options['max-minutes']){stop=true;stopReason='max-time';break;}
   const sequence=i%2?[variants[1],variants[0]]:variants;
   if(options.pair==='launch'){
    for(const variant of sequence){Object.assign(options,variant);const l=await launch();l.pair={factor:options.pair,index:i+1};try{await initWindow(l);await safeGesture(l);}finally{await close(l);}if(stop)break;}
   }else{
    Object.assign(options,sequence[0]);const l=await launch();l.pair={factor:options.pair,index:i+1};try{await initWindow(l);for(const variant of sequence){Object.assign(options,variant);await safeGesture(l);if(stop)break;}}finally{await close(l);}
   }
  }
 }
}catch(error){
 errors++;const failure={schema:'yizhi-pan-error-1',runId,id:gestureNo,session:sessionNo,stage:'launch-or-session',message:String(error?.stack??error)};
 await appendFile(recordsPath,JSON.stringify(failure)+'\n');console.error(JSON.stringify(failure));
}finally{
 await rm(workRoot,{recursive:true,force:true});
 const sorted=[...allGaps].sort((a,b)=>a-b),percentile=q=>sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(q*sorted.length)-1)]:null;
 const summary={schema:'yizhi-pan-summary-1',runId,completed,errors,abnormal,unexpectedAbnormal,calibrationChecks,stopped:stop,stopReason,elapsedSeconds:(now()-start)/1000,maxGapMs:sorted.at(-1)??null,p50Ms:percentile(.5),p95Ms:percentile(.95),recordsPath,manifestHash,courseHash};
 await writeFile(join(outPath,runId+'-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log('[pan-summary]',JSON.stringify(summary));
 if((options.calibrate==='on'?unexpectedAbnormal:abnormal)||errors||completed===0||stopReason==='max-time'||stopReason==='interrupted')process.exitCode=1;
}
