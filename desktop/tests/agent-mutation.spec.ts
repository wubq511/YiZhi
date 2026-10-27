import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('small actual Electron window follows real tool groups, keeps student takeover, displays partial receipts and reopens without a second body',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-mutation-ui-')),fixture=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(fixture,0o755);
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:fixture,YIZHI_FIXTURE_MODE:'mutation'}});
 let app=await launch();
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
  await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();
  await expect(page.getByText('本机 Codex CLI · 已连接',{exact:true})).toBeVisible();
  await page.getByLabel('Agent 请求方式').selectOption('modify');
  await page.getByRole('textbox',{name:'学习对话草稿'}).fill('受控协议竞争回归，不是真实Agent验收');
  await page.getByRole('button',{name:'发送修改请求',exact:true}).click();
  await expect(page.getByRole('status',{name:'修改跟随'})).toHaveText('正在跟随修改');
  await expect(page.getByRole('textbox',{name:'编辑首段正文'})).toContainText('受控协议回归');
  await page.waitForTimeout(250); // settle real local layout compensation before the student's deliberate takeover
  const beforePan=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera;});
  const board=(await page.locator('main.board').boundingBox())!;await page.mouse.move(board.x+8,board.y+board.height/2);await page.mouse.wheel(0,80);
  await expect(page.getByRole('status',{name:'修改跟随'})).toHaveText('已由你控制视野');
  await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera.y;})).not.toBe(beforePan.y);
  const camera=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera;});
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('部分完成',{timeout:15000});
  await expect(page.getByRole('status',{name:'修改跟随'})).toHaveText('修改已结束');
  await expect(page.getByRole('textbox',{name:'编辑首段正文'})).toContainText('受控协议回归');
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('草稿候选');
  const actual=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return {state:await b.readingState(c.sessionId),unit:c.unit,graph:await b.graph(c.sessionId)};});expect(actual.state.camera).toEqual(camera);
  expect(actual.unit.reading.blocks[0].kind).toBe('example');const baseline=actual.graph.layout.nodes.find((n:any)=>n.unitId==='KU-001');
  await page.getByRole('button',{name:'收起对话',exact:true}).click();
  const summary=page.locator('[data-agent-unit="KU-001"] details summary').first();await revealBoardControl(page,summary);await summary.click();await summary.click();
  expect((await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.graph(c.sessionId);})).layout.nodes.find((n:any)=>n.unitId==='KU-001')).toEqual(baseline);
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(page.getByRole('status',{name:'回答状态'})).toContainText('部分完成');
  expect((await page.evaluate(()=>(window as any).yizhi.open())).unit).toEqual(actual.unit);
  await page.getByRole('button',{name:'非十进制与十进制互转',exact:true}).click();
  await page.getByRole('button',{name:'查看实际修改',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).unitId;})).toBe('KU-001');
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,'t17-controlled-small-reopen.png')});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
