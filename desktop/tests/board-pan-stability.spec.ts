import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boardWheelPoint, resizeBoardWindow } from './board-test-helpers';
import { createCanvas, loadImage } from '@napi-rs/canvas';

for(const gesture of ['drag','wheel'] as const)test(`overview ${gesture} keeps the renderer and fixed controls stable`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-pan-stability-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();await resizeBoardWindow(app,page,1024,768);
    await page.getByRole('button',{name:'全图',exact:true}).click();
    await expect(page.locator('.board-route-ink').first()).toBeAttached();
    const cdp=await page.context().newCDPSession(page),frames:string[]=[];
    cdp.on('Page.screencastFrame',frame=>{if(frames.length<200)frames.push(frame.data);void cdp.send('Page.screencastFrameAck',{sessionId:frame.sessionId});});
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:75,everyNthFrame:1});
    const point=await boardWheelPoint(page);
    await page.mouse.move(point.x,point.y);if(gesture==='drag')await page.mouse.down();
    await page.evaluate(()=>{
      const samples:Array<{t:number;x:number;y:number;zoom:number}>=[];
      (window as any).__panProbe={samples,running:true};
      const tick=(t:number)=>{const probe=(window as any).__panProbe;if(!probe.running)return;
        const el=document.querySelector<HTMLElement>('.react-flow__viewport')!,v=Array.from((el as any).attributeStyleMap.get('transform')) as any[];
        samples.push({t,x:v[0].x.value,y:v[0].y.value,zoom:v[1].x.value});requestAnimationFrame(tick);};requestAnimationFrame(tick);
    });
    for(let i=1;i<=80;i++)if(gesture==='drag')await page.mouse.move(point.x+i*2,point.y+i);else await page.mouse.wheel(2,1);
    if(gesture==='drag')await page.mouse.up();await page.waitForTimeout(100);
    const result=await page.evaluate(()=>{const p=(window as any).__panProbe;p.running=false;return p.samples as Array<{t:number;x:number;y:number;zoom:number}>;});
    await cdp.send('Page.stopScreencast');await cdp.detach();
    const shellSamples:number[][]=[];
    for(const frame of frames){const image=await loadImage(Buffer.from(frame,'base64')),canvas=createCanvas(10,30),ctx=canvas.getContext('2d');ctx.drawImage(image,8,100,48,300,0,0,10,30);shellSamples.push([...ctx.getImageData(0,0,10,30).data]);}
    const differences=shellSamples.slice(1).map(s=>s.reduce((sum,v,i)=>sum+Math.abs(v-shellSamples[0][i]),0)/s.length);
    const gaps=result.slice(1).map((s,i)=>s.t-result[i].t);
    const direction=gesture==='drag'?1:-1;
    const reversals=result.slice(1).filter((s,i)=>(s.x-result[i].x)*direction < -1||(s.y-result[i].y)*direction < -1);
    console.log(JSON.stringify({frames:result.length,screenFrames:frames.length,maxShellDifference:Math.max(0,...differences),maxGap:Math.max(...gaps),reversals:reversals.length,first:result[0],last:result.at(-1)}));
    expect(result.length).toBeGreaterThan(5);
    expect((result.at(-1)!.x-result[0].x)*direction).toBeGreaterThan(60);
    expect(reversals).toHaveLength(0);
    expect(Math.max(...gaps)).toBeLessThan(100);
    expect(frames.length).toBeGreaterThan(5);
    expect(Math.max(...differences)).toBeLessThan(15);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
