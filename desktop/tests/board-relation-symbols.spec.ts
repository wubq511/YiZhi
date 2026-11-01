import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';

test('a clear theme relation uses a clickable curve and yields to an obstacle', async ({ page }) => {
  const bundle=await build({bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),sourcefile:'relation-curve.tsx',loader:'tsx',contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
    import { BoardRoutes } from './src/renderer/board-edge';
    const edge={id:'curve',source:'a',target:'b',type:'requires',directed:true,memberIds:['member'],kind:'theme',label:'requires',points:[{x:100,y:100},{x:140,y:100},{x:140,y:300},{x:500,y:300}]};
    function App(){const [blocked,setBlocked]=React.useState(false);const theme={themeId:'blocker',title:'阻挡',x:250,y:160,width:100,height:100,units:[]};
      return <ReactFlowProvider><button id="block" onClick={()=>setBlocked(true)}>block</button><div style={{width:700,height:450}}><ReactFlow nodes={[]} edges={[]} viewport={{x:0,y:0,zoom:1}}>
        <BoardRoutes scene={{themes:blocked?[theme]:[],units:[],edges:[edge]}} viewport={{x:0,y:0,zoom:1}} width={700} height={450} onActivate={ids=>document.body.dataset.activated=ids.join(',')} />
      </ReactFlow></div></ReactFlowProvider>}
    createRoot(document.getElementById('root')!).render(<App/>);
  `}});
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({content:await readFile('node_modules/@xyflow/react/dist/style.css','utf8')});
  await page.addStyleTag({content:await readFile('src/renderer/board-scene.css','utf8')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const ink=page.locator('.board-route-ink');await expect(ink).toHaveAttribute('data-curve','direct');
  const hit=page.locator('.board-route-hit');
  const midpoint=await hit.evaluate(element=>{
    const path=element as SVGPathElement,point=path.getPointAtLength(path.getTotalLength()/2),m=path.getScreenCTM()!;
    return {x:m.a*point.x+m.c*point.y+m.e,y:m.b*point.x+m.d*point.y+m.f};
  });
  await page.mouse.move(midpoint.x,midpoint.y);
  await expect(ink).toHaveCSS('stroke','rgb(101, 85, 190)');
  await page.mouse.click(midpoint.x,midpoint.y);
  await expect(page.locator('body')).toHaveAttribute('data-activated','member');
  await page.locator('#block').click();
  await expect(ink).toHaveAttribute('data-curve','routed');
});

test('a distant solid relation remains visibly continuous and curved', async ({ page }) => {
  await page.setViewportSize({width:1024,height:768});
  const bundle=await build({bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),sourcefile:'relation-overview-ink.tsx',loader:'tsx',contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
    import { BoardRoutes } from './src/renderer/board-edge';
    const scene={themes:[],units:[],edges:[{id:'line',source:'a',target:'b',type:'requires',directed:true,memberIds:['line'],kind:'unit',label:'requires',points:[{x:100,y:250},{x:500,y:250}]}]};
    createRoot(document.getElementById('root')!).render(<ReactFlowProvider><div style={{width:1024,height:700}}><ReactFlow nodes={[]} edges={[]} viewport={{x:0,y:0,zoom:.1}}><BoardRoutes scene={scene} viewport={{x:0,y:0,zoom:.1}} width={1024} height={700} onActivate={()=>{}} /></ReactFlow></div></ReactFlowProvider>);
  `}});
  await page.setContent('<style>html,body{margin:0;background:white}</style><div id="root"></div>');
  await page.addStyleTag({content:await readFile('node_modules/@xyflow/react/dist/style.css','utf8')});
  await page.addStyleTag({content:await readFile('src/renderer/board-scene.css','utf8')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const route=page.locator('.board-route');await expect(route).toBeAttached();
  const origin=await route.evaluate(element=>{const m=(element as SVGGraphicsElement).getScreenCTM()!;return {x:m.e,y:m.f};});
  const shot=await loadImage(await page.screenshot()),canvas=createCanvas(shot.width,shot.height),context=canvas.getContext('2d');context.drawImage(shot,0,0);
  const data=context.getImageData(Math.round(origin.x+12),Math.round(origin.y+19),34,13).data;
  const dark=Array.from({length:34*13},(_,i)=>data[i*4]).filter(red=>red<180).length;
  expect(dark,'a real overview stroke must not be reduced to subpixel specks').toBeGreaterThan(30);
  const deviation=await page.locator('.board-route-ink').evaluate(element=>{
    const path=element as SVGPathElement,total=path.getTotalLength();let max=0;
    for(let i=0;i<=100;i++)max=Math.max(max,Math.abs(path.getPointAtLength(total*i/100).y-25));
    return max;
  });
  expect(deviation,'the line should have a visible, gentle hand-drawn bend').toBeGreaterThan(2);
});

test('hand-drawn strokes do not merge when separate routes run close together', async ({ page }) => {
  const bundle=await build({bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),sourcefile:'parallel-relations.tsx',loader:'tsx',contents:`
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ReactFlow,ReactFlowProvider} from '@xyflow/react';
    import {BoardRoutes} from './src/renderer/board-edge';
    const edge=(id,y)=>({id,source:id+'-source',target:id+'-target',type:'requires',directed:true,memberIds:[id],kind:'theme',label:'requires',points:[{x:100,y},{x:600,y}]});
    const scene={themes:[],units:[],edges:[edge('a',105),edge('b',100)]};
    createRoot(document.getElementById('root')!).render(<ReactFlowProvider><div style={{width:700,height:300}}><ReactFlow nodes={[]} edges={[]} viewport={{x:0,y:0,zoom:1}}><BoardRoutes scene={scene} viewport={{x:0,y:0,zoom:1}} width={700} height={300} onActivate={()=>{}} /></ReactFlow></div></ReactFlowProvider>);
  `}});
  await page.setContent('<style>html,body{margin:0}</style><div id="root"></div>');
  await page.addStyleTag({content:await readFile('src/renderer/board-scene.css','utf8')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await expect(page.locator('.board-route-ink')).toHaveCount(2);
  const gap=await page.locator('.board-route-ink').evaluateAll(elements=>{
    const paths=elements as SVGPathElement[],lengths=paths.map(path=>path.getTotalLength());let minimum=Infinity;
    for(let i=0;i<=100;i++) {
      const points=paths.map((path,j)=>path.getPointAtLength(lengths[j]*i/100));
      minimum=Math.min(minimum,points[0].y-points[1].y);
    }
    return minimum;
  });
  expect(gap,'ink should preserve a visible gap instead of crossing its neighbour').toBeGreaterThan(2);
});

test('relation symbols preserve type, direction, members and screen size across zoom', async ({ page }) => {
  const bundle=await build({bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),sourcefile:'relation-fixture.tsx',loader:'tsx',contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
    import { BoardRoutes } from './src/renderer/board-edge';
    const edges=['requires','constructs','improves','inverse'].map((type,i)=>({id:type,source:'a',target:'b',type,directed:type!=='inverse',memberIds:[type+'-member'],kind:'unit',label:type,points:[{x:20,y:40+i*40},{x:220,y:40+i*40}]}));
    const scene={themes:[],units:[],edges};
    function App(){const [zoom,setZoom]=React.useState(1);return <ReactFlowProvider><button id="zoom" onClick={()=>setZoom(.5)}>zoom</button><div style={{width:500,height:300}}><ReactFlow nodes={[]} edges={[]} viewport={{x:0,y:0,zoom}}><BoardRoutes scene={scene} viewport={{x:0,y:0,zoom}} width={500} height={300} onActivate={(ids,pointer)=>{document.body.dataset.activated=ids.join(',')+':'+pointer}} /></ReactFlow></div></ReactFlowProvider>}
    createRoot(document.getElementById('root')!).render(<App/>);
  `}});
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({content:await readFile('src/renderer/board-scene.css','utf8')});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const routes=page.locator('.board-route-group');
  await expect(routes).toHaveCount(4);
  for(const type of ['requires','constructs','improves','inverse']) {
    const group=routes.filter({has:page.locator(`.board-route[data-type="${type}"]`)});
    await expect(group.locator('.board-route-arrow')).toHaveCount(type==='inverse'?2:1);
    await expect(group.locator('.board-route')).toHaveAttribute('data-members',JSON.stringify([`${type}-member`]));
    await expect(group.locator('.board-route-ink')).toHaveCount(1);
  }
  await expect(page.locator('.board-route[data-type="requires"]')).toHaveCSS('stroke-dasharray','none');
  await expect(page.locator('.board-route[data-type="constructs"]')).toHaveCSS('stroke-dasharray','9px, 6px');
  await expect(page.locator('.board-route[data-type="improves"]')).toHaveCSS('stroke-dasharray','1px, 6px');
  await expect(page.locator('.board-route[data-type="inverse"]')).toHaveCSS('stroke-dasharray','9px, 4px, 1px, 4px');
  await expect(page.locator('.board-route-ink[data-type="constructs"]')).toHaveCSS('stroke-dasharray','9px, 6px');
  await expect(page.locator('.board-route-ink[data-type="improves"]')).toHaveCSS('stroke-dasharray','1px, 6px');
  await expect(routes.nth(0).locator('.board-route-arrow-fill')).toHaveCount(1);
  await expect(routes.nth(1).locator('.board-route-arrow-fill')).toHaveCount(0);
  await expect(routes.nth(2).locator('.board-route-arrow-fill')).toHaveCount(0);
  await expect(routes.nth(3).locator('.board-route-arrow-paper')).toHaveCount(2);
  const arrow=routes.nth(1).locator('.board-route-arrow');
  const before=await arrow.locator('path').first().getAttribute('d');
  await page.locator('#zoom').click();
  await expect(arrow).toHaveAttribute('transform',/scale\(2\)/);
  await expect(arrow.locator('path').first()).toHaveAttribute('d',before!);
  await routes.nth(2).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-activated','improves-member:false');
  await routes.nth(0).dispatchEvent('click',{detail:1});
  await expect(page.locator('body')).toHaveAttribute('data-activated','requires-member:true');
});

test('ink stays outside content and short arrows stay on their segment at overview zoom', async ({ page }) => {
  await page.setViewportSize({width:1024,height:768});
  const bundle=await build({bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),sourcefile:'relation-clearance.tsx',loader:'tsx',contents:`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
    import { BoardRoutes } from './src/renderer/board-edge';
    const relation=(id,points)=>({id,source:'a',target:'b',type:'requires',directed:true,memberIds:[id],kind:'unit',label:'requires',points});
    const scene={themes:[],units:[{unitId:'obstacle',x:300,y:200,width:200,height:100},{unitId:'overlap',x:350,y:200,width:200,height:100},{unitId:'source',x:0,y:500,width:620,height:320},{unitId:'target',x:640,y:500,width:200,height:320}],edges:[relation('e',[{x:100,y:200},{x:900,y:200}]),relation('short',[{x:620,y:660},{x:640,y:660}])]};
    function App(){const [zoom,setZoom]=React.useState(1);return <ReactFlowProvider><button id="zoom" onClick={()=>setZoom(.1)}>zoom</button><div style={{width:1024,height:700}}><ReactFlow nodes={[]} edges={[]} viewport={{x:0,y:0,zoom}}><BoardRoutes scene={scene} viewport={{x:0,y:0,zoom}} width={1024} height={700} onActivate={()=>{}} /></ReactFlow></div></ReactFlowProvider>}
    createRoot(document.getElementById('root')!).render(<App/>);
  `}});
  await page.setContent('<style>html,body{margin:0;background:white}</style><div id="root"></div>');
  await page.addStyleTag({content:await readFile('node_modules/@xyflow/react/dist/style.css','utf8')});
  await page.addStyleTag({content:await readFile('src/renderer/board-scene.css','utf8')+'\n.board-route-ink {stroke-width: 6px}'});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const edge=page.locator('.board-route-group').filter({has:page.locator('.board-route[data-members*="e"]')});
  await expect(edge).toHaveCount(1);
  const origin=await edge.locator('.board-route').evaluate(element=>{const m=(element as SVGGraphicsElement).getScreenCTM()!;return {x:m.e,y:m.f};});
  const screenshot=await loadImage(await page.screenshot());
  const canvas=createCanvas(screenshot.width,screenshot.height),context=canvas.getContext('2d');context.drawImage(screenshot,0,0);
  const pixel=(x:number,y:number)=>[...context.getImageData(Math.round(origin.x+x),Math.round(origin.y+y),1,1).data];
  expect(pixel(200,200)[0]).toBeLessThan(230);
  expect(pixel(400,202).slice(0,3)).toEqual([255,255,255]);
  await page.locator('#zoom').click();
  const short=page.locator('.board-route-group').filter({has:page.locator('.board-route[data-members*="short"]')});
  const arrow=short.locator('.board-route-arrow');
  await expect(arrow).toHaveAttribute('transform',/scale\(2\)/);
  const clip=arrow.locator('clipPath rect');
  await expect(clip).toHaveAttribute('x','-10');
  await expect(clip).toHaveAttribute('width','10');
  const fullArrow=edge.locator('.board-route-arrow');
  await expect(fullArrow).toHaveAttribute('transform',/scale\(10\)/);
  await expect(fullArrow.locator('.board-route-arrow-fill')).toBeAttached();
  const overviewOrigin=await edge.locator('.board-route').evaluate(element=>{const m=(element as SVGGraphicsElement).getScreenCTM()!;return {x:m.e,y:m.f};});
  const overview=await loadImage(await page.screenshot());
  const overviewCanvas=createCanvas(overview.width,overview.height),overviewContext=overviewCanvas.getContext('2d');overviewContext.drawImage(overview,0,0);
  const arrowPixels=overviewContext.getImageData(Math.round(overviewOrigin.x+82),Math.round(overviewOrigin.y+16),8,8).data;
  expect(Array.from({length:64},(_,i)=>arrowPixels[i*4]).filter(red=>red<180).length).toBeGreaterThan(3);
  const sourcePixel=overviewContext.getImageData(Math.round(overviewOrigin.x+61),Math.round(overviewOrigin.y+66),1,1).data;
  expect([...sourcePixel].slice(0,3)).toEqual([255,255,255]);
  const shortPixels=overviewContext.getImageData(Math.round(overviewOrigin.x+62),Math.round(overviewOrigin.y+65),2,3).data;
  expect(Array.from({length:6},(_,i)=>shortPixels[i*4]).some(red=>red<230)).toBe(true);
});
