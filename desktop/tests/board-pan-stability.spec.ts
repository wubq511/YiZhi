import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance as nodePerformance } from 'node:perf_hooks';
import { boardWheelPoint, cameraMovementGaps, finishPanProbe, resizeBoardWindow, startPanProbe, type PanProbeData } from './board-test-helpers';
import { createCanvas, loadImage } from '@napi-rs/canvas';

function panLongTaskStalls(probe:PanProbeData) {
  const gaps=cameraMovementGaps(probe.samples.map(s=>({...s,t:s.now})));
  return probe.longtasks.filter(task=>task.duration>=100&&gaps.some(g=>g.gap>=100&&Math.min(g.end,task.start+task.duration)-Math.max(g.start,task.start)>100));
}

for(const gesture of ['drag','wheel'] as const)test(`overview ${gesture} keeps the renderer and fixed controls stable`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-pan-stability-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();await resizeBoardWindow(app,page,1024,768);
    await page.getByRole('button',{name:'全图',exact:true}).click();
    await expect(page.locator('.board-route-ink').first()).toBeAttached();
    const point=await boardWheelPoint(page);
    const clock=async()=>{const before=nodePerformance.now(),pageTime=await page.evaluate(()=>performance.now()),after=nodePerformance.now();return {before,after,pageTime,uncertainty:(after-before)/2};};
    const native=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({focused:w.isFocused(),visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds()})));
    const nativeBefore=await native(),clockBefore=await clock();
    await page.mouse.move(point.x,point.y);if(gesture==='drag')await page.mouse.down();
    await startPanProbe(page);const commands:Array<{step:number;sent:number;done:number}>=[];
    for(let i=1;i<=80;i++){const sent=nodePerformance.now();if(gesture==='drag')await page.mouse.move(point.x+i*2,point.y+i);else await page.mouse.wheel(2,1);commands.push({step:i,sent,done:nodePerformance.now()});}
    if(gesture==='drag')await page.mouse.up();await page.waitForTimeout(100);
    const probe=await finishPanProbe(page),result=probe.samples,clockAfter=await clock(),nativeAfter=await native();
    // Screencast JPEG encoding and CDP acknowledgements compete with input and rAF on hosted runners.
    // Observe frame pacing first, then exercise the same gesture while checking the fixed shell visually.
    const cdp=await page.context().newCDPSession(page),frames:string[]=[],screenTimes:Array<{at:number;timestamp?:number}>=[],ackErrors:string[]=[];
    let stopping=false;
    cdp.on('Page.screencastFrame',frame=>{if(frames.length<200){frames.push(frame.data);screenTimes.push({at:nodePerformance.now(),timestamp:frame.metadata?.timestamp});}void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId}).catch(error=>{if(!stopping)ackErrors.push(String(error));});});
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,everyNthFrame:1});
    await page.mouse.move(point.x,point.y);if(gesture==='drag')await page.mouse.down();
    for(let i=1;i<=80;i++){if(gesture==='drag')await page.mouse.move(point.x+i*2,point.y+i);else await page.mouse.wheel(2,1);}
    if(gesture==='drag')await page.mouse.up();await page.waitForTimeout(100);
    stopping=true;await cdp.send('Page.stopScreencast');await cdp.detach();
    const shellSamples:number[][]=[];
    for(const frame of frames){const image=await loadImage(Buffer.from(frame,'base64')),canvas=createCanvas(10,30),ctx=canvas.getContext('2d');ctx.drawImage(image,8,100,48,300,0,0,10,30);shellSamples.push([...ctx.getImageData(0,0,10,30).data]);}
    const differences=shellSamples.slice(1).map(s=>s.reduce((sum,v,i)=>sum+Math.abs(v-shellSamples[0][i]),0)/s.length);
    const gaps=cameraMovementGaps(result);
    const direction=gesture==='drag'?1:-1;
    const reversals=result.slice(1).filter((s,i)=>(s.x-result[i].x)*direction < -1||(s.y-result[i].y)*direction < -1);
    const sortedGaps=gaps.map(g=>g.gap).sort((a,b)=>a-b);
    const p95Gap=sortedGaps[Math.ceil(sortedGaps.length*.95)-1]??0;
    const maxGap=sortedGaps.at(-1)??0,maxInputGap=Math.max(0,...probe.inputs.slice(1).map((e,i)=>e.now-probe.inputs[i].now));
    const maxCommand=Math.max(0,...commands.map(c=>c.done-c.sent)),maxShellDifference=Math.max(0,...differences);
    const hostDelayed=maxInputGap>=100||maxCommand>=100,blockingTasks=panLongTaskStalls(probe);
    console.log(JSON.stringify({frames:result.length,screenFrames:frames.length,maxShellDifference,p95Gap,maxGap,maxInputGap,maxCommand,hostDelayed,blockingTasks:blockingTasks.length,reversals:reversals.length,first:result[0],last:result.at(-1)}));
    if(p95Gap>=50||maxGap>=100||hostDelayed||blockingTasks.length||result.length<=5||gaps.length<=20||frames.length<=5||reversals.length||maxShellDifference>=15||ackErrors.length)
      await test.info().attach('pan-timing.json',{body:JSON.stringify({gesture,point,probe,commands,clockBefore,clockAfter,nativeBefore,nativeAfter,screenTimes,ackErrors,p95Gap,maxGap,maxInputGap,maxCommand,hostDelayed,blockingTasks,maxShellDifference,reversals:reversals.length}),contentType:'application/json'});
    expect(result.length).toBeGreaterThan(5);
    expect(gaps.length).toBeGreaterThan(20);
    expect(probe.longTasksSupported).toBe(true);
    expect((result.at(-1)!.x-result[0].x)*direction).toBeGreaterThan(60);
    expect(reversals).toHaveLength(0);
    // Keep the single-frame gate when input and command delivery are prompt. If either
    // is delayed, check sustained cadence and reject renderer long tasks instead.
    if(hostDelayed){expect(p95Gap).toBeLessThan(50);expect(maxGap).toBeLessThan(250);}
    else expect(maxGap).toBeLessThan(100);
    expect(blockingTasks).toHaveLength(0);
    expect(frames.length).toBeGreaterThan(5);
    expect(ackErrors).toHaveLength(0);
    expect(maxShellDifference).toBeLessThan(15);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

for(const stall of ['during','after','input'] as const)test(`pan timing ${stall==='during'?'detects a stall while moving':stall==='after'?'excludes a stall after movement':'records an input pause while frames continue'}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-pan-boundary-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();await resizeBoardWindow(app,page,1024,768);
    await page.getByRole('button',{name:'全图',exact:true}).click();await expect(page.locator('.board-route-ink').first()).toBeAttached();
    const point=await boardWheelPoint(page);await page.mouse.move(point.x,point.y);await page.mouse.down();
    await startPanProbe(page);
    const nextFrame=()=>page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    const inject=()=>page.evaluate(()=>new Promise<{start:number;end:number}>(done=>setTimeout(()=>{const start=performance.now();while(performance.now()-start<150){}done({start,end:performance.now()});},0)));
    let block:{start:number;end:number}|undefined;
    for(let i=1;i<=40;i++){
      await page.mouse.move(point.x+i*2,point.y+i);
      if(stall==='during'&&i===20){await nextFrame();block=await inject();}
      if(stall==='input'&&i===20){const start=await page.evaluate(()=>performance.now());await page.waitForTimeout(150);block={start,end:await page.evaluate(()=>performance.now())};}
    }
    await page.mouse.up();if(stall==='after'){await nextFrame();block=await inject();await nextFrame();}await page.waitForTimeout(100);
    const probe=await finishPanProbe(page),samples=probe.samples;
    // Compare the injected block with callback times from the same performance.now() clock.
    const all=samples.slice(1).map((sample,i)=>({start:samples[i].now,end:sample.now,gap:sample.now-samples[i].now}));
    const movement=cameraMovementGaps(samples.map(s=>({...s,t:s.now})));expect(movement.length).toBeGreaterThan(0);
    const includesInjected=(gap:{start:number;end:number;gap:number})=>gap.gap>100&&Math.min(gap.end,block!.end)-Math.max(gap.start,block!.start)>100;
    expect(probe.longTasksSupported).toBe(true);
    const injectedTask=probe.longtasks.find(task=>task.duration>=100&&Math.min(task.start+task.duration,block!.end)-Math.max(task.start,block!.start)>100);
    expect(Boolean(injectedTask)).toBe(stall!=='input');
    expect(injectedTask?panLongTaskStalls(probe).includes(injectedTask):false).toBe(stall==='during');
    if(stall==='input'){
      const events=probe.inputs.filter(e=>e.type==='pointermove');
      expect(events.slice(1).some((e,i)=>events[i].now<=block!.start+20&&e.now>=block!.end-20)).toBe(true);
      expect(samples.filter(s=>s.now>block!.start+20&&s.now<block!.end-20).length).toBeGreaterThan(1);
    }else{
      expect(all.some(includesInjected)).toBe(true);
      expect(movement.some(includesInjected)).toBe(stall==='during');
    }
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
