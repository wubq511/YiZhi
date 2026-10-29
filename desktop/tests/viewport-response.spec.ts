import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCameraTransform, resizeBoardWindow, closeFailedBoard, expectBoundedReading } from './board-test-helpers';
import { CourseService } from '../src/core/course-service';

test('returning to an uncached unit with the same saved camera preserves visible static reading bodies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-range-return-')),course=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 let app:Awaited<ReturnType<typeof electron.launch>>|undefined,failure:unknown;
 try{
  const c=await core.open(course),b={unitId:'KU-057',x:20000,y:20000,width:650};
  // Isolate this camera/cache scenario from neighboring bodies' measured growth.
  await core.setLayout(c.sessionId,[b]);
  const camera={x:40-b.x*.85,y:100-b.y*.85,zoom:.85};
  await core.setReadingState(c.sessionId,{unitId:'KU-001',pinnedUnitId:'KU-001',expanded:{},scrollTop:0,camera,
   returnStack:[{unitId:'KU-035',blockId:'',scrollTop:0,camera}]});
  await core.close();
  app=await electron.launch({args:[resolve('.'),`--course=${course}`],env:{...process.env,YIZHI_OBSERVE:'1',YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-cli')}});
  const page=await app.firstWindow();await resizeBoardWindow(app,page);
  const body=page.locator('article[data-unit-id="KU-057"]');await expect(body).toContainText('多路选择器');
  await expect(page.locator('article[data-unit-id="KU-035"]')).toHaveCount(0);
  await page.evaluate(()=>{(window as any).__rangeReturnBody=document.querySelector('article[data-unit-id="KU-057"]');});
  const before=await readCameraTransform(page.locator('.react-flow__viewport'));
  await page.getByRole('button',{name:'返回引用位置',exact:true}).click();
  await expect(page.locator('article[data-unit-id="KU-035"]')).toHaveAttribute('data-reading-active','true');
  await expect(body).toContainText('多路选择器');
  expect(await page.evaluate(()=>document.querySelector('article[data-unit-id="KU-057"]')===(window as any).__rangeReturnBody)).toBe(true);
  const after=await readCameraTransform(page.locator('.react-flow__viewport'));expect(after).toEqual(before);
  await expectBoundedReading(page);
  const counters=await page.evaluate(()=>(window as any).__yizhiObservation());
  await writeFile(test.info().outputPath('same-camera-return.json'),JSON.stringify({before,after,counters,physical:false},null,2));
 }catch(error){failure=error;throw error;}
 finally{await core.close();if(app){if(failure)await closeFailedBoard(app,failure);else await app.close();}await rm(root,{recursive:true,force:true});}
});

test('continuous camera gestures keep unchanged graph projection and the active reading input stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-viewport-response-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    if (await page.getByRole('button', { name: '收起目录', exact: true }).count()) await page.getByRole('button', { name: '收起目录', exact: true }).click();
    const pane = page.locator('.react-flow__pane'), viewport = page.locator('.react-flow__viewport');
    const board = (await page.locator('main.board').boundingBox())!, clientX = Math.round(board.x + 8), clientY = Math.round(board.y + 180);
    const reading = await page.evaluate(async () => { const c = await (window as any).yizhi.open(); return (window as any).yizhi.readingState(c.sessionId); });
    await page.evaluate(() => { (window as any).__responseEditor = document.querySelector('article[data-reading-active=true] .tiptap'); });
    const camera = await readCameraTransform(viewport), count = () => page.evaluate(() => (window as any).__yizhiObservation()['scene.graphProjections'].count);
    const before = await count();
    for (let step = 0; step < 10; step++) {
      await pane.dispatchEvent('wheel', { deltaX: 2, deltaY: 1, clientX, clientY, bubbles: true, cancelable: true });
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    }
    const panned = await readCameraTransform(viewport);
    expect(panned.x).toBeCloseTo(camera.x - 20, 8); expect(panned.y).toBeCloseTo(camera.y - 10, 8);
    for (let step = 0; step < 5; step++) {
      await pane.dispatchEvent('wheel', { deltaY: -.5, deltaMode: 0, ctrlKey: true, clientX, clientY, bubbles: true, cancelable: true });
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    }
    const pinched = await readCameraTransform(viewport), pointer = { x: clientX - board.x, y: clientY - board.y };
    expect(pinched.zoom).toBeGreaterThan(panned.zoom);
    expect((pointer.x - pinched.x) / pinched.zoom).toBeCloseTo((pointer.x - panned.x) / panned.zoom, 8);
    expect((pointer.y - pinched.y) / pinched.zoom).toBeCloseTo((pointer.y - panned.y) / panned.zoom, 8);
    // Translation / zoom inside one semantic level does not change any graph content or placement.
    expect(await count(), 'Camera-only input must not rebuild the unchanged graph projection').toBe(before);
    expect(await page.evaluate(() => document.querySelector('article[data-reading-active=true] .tiptap') === (window as any).__responseEditor)).toBe(true);
    const after = await page.evaluate(async () => { const c = await (window as any).yizhi.open(); return (window as any).yizhi.readingState(c.sessionId); });
    expect({ ...after, camera: undefined }).toEqual({ ...reading, camera: undefined });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const reopened = await readCameraTransform(page.locator('.react-flow__viewport')); expect(reopened).toEqual(pinched);
    await writeFile(test.info().outputPath('viewport-response.json'), JSON.stringify({ camera, panned, pinched, reopened, graphProjectionCount: before, physical: false }, null, 2));
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('panning to an adjacent B reads static body without navigating or replacing active input and bounds every body cache',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-reading-range-'));
 let failure:unknown;
 const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_OBSERVE:'1',YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'missing-cli')}});
 try{
  const page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
  if(await page.getByRole('button',{name:'收起目录',exact:true}).count())await page.getByRole('button',{name:'收起目录',exact:true}).click();
  const input=page.getByRole('textbox',{name:'编辑首段正文',exact:true});await input.fill('阅读范围不能清掉正在编辑的单元。');
  await expect(page.getByRole('status',{name:'保存状态'})).toHaveText('已保存');
  await page.evaluate(()=>{(window as any).__heldEditor=document.querySelector('article[data-reading-active=true] .tiptap');const p=document.querySelector('article[data-reading-active=true] .tiptap p')!,r=document.createRange();r.setStart(p.firstChild!,1);r.setEnd(p.firstChild!,5);getSelection()!.removeAllRanges();getSelection()!.addRange(r);});
  const before=await page.evaluate(()=>(window as any).__yizhiObservation()['scene.graphProjections'].count);
  const target=await page.evaluate(async()=>{const c=await window.yizhi.open(),g=await window.yizhi.graph(c.sessionId);return g.layout.nodes.find(n=>n.unitId==='KU-057')!;});
  const pane=page.locator('.react-flow__pane'),view=await readCameraTransform(page.locator('.react-flow__viewport')),board=(await page.locator('main.board').boundingBox())!;
  await pane.dispatchEvent('wheel',{deltaX:view.x+target.x*view.zoom-40,deltaY:view.y+target.y*view.zoom-100,clientX:board.x+8,clientY:board.y+150,bubbles:true,cancelable:true});
  const other=page.locator('article[data-unit-id="KU-057"]');
  await expect(other).toContainText('多路选择器');
  await expect(other.locator('[data-search-block] p').first()).toBeVisible();
  expect(await other.locator('.tiptap').count()).toBe(0);
  expect(await page.evaluate(()=>document.querySelector('article[data-reading-active=true] .tiptap')===(window as any).__heldEditor)).toBe(true);
  expect(await page.evaluate(()=>getSelection()?.toString())).toBe('读范围不');
  // Newly materialized static bodies can change measured layout; steady camera frames cannot.
  await page.waitForTimeout(200);const settled=await page.evaluate(()=>(window as any).__yizhiObservation()['scene.graphProjections'].count);
  await pane.dispatchEvent('wheel',{deltaX:1,deltaY:1,clientX:board.x+8,clientY:board.y+150,bubbles:true,cancelable:true});
  await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  expect(await page.evaluate(()=>(window as any).__yizhiObservation()['scene.graphProjections'].count)).toBe(settled);
  expect(settled-before).toBeLessThanOrEqual(16);
  await expectBoundedReading(page);
  const counters=await page.evaluate(()=>(window as any).__yizhiObservation());
  await page.screenshot({path:test.info().outputPath('pan-static-body.png')});
  await writeFile(test.info().outputPath('reading-range.json'),JSON.stringify({target,counters,selection:await page.evaluate(()=>getSelection()?.toString()),physical:false},null,2));
 }catch(error){failure=error;throw error;}
 finally{if(failure)await closeFailedBoard(app,failure);else await app.close();await rm(root,{recursive:true,force:true});}
});
