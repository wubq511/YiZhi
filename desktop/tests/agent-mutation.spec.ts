import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('small actual Electron window follows real tool groups, keeps student takeover, displays waiting and stopped receipts and reopens without a second body',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-mutation-ui-')),fixture=resolve('dist/tests/agent-executor-fixture.cjs'),release=join(root,'release-second-group');await chmod(fixture,0o755);
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:fixture,YIZHI_FIXTURE_MODE:'mutation',YIZHI_MUTATION_RELEASE:release}});
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
  // Inline transform retains the actual camera precision; computed matrix() rounds to six significant digits.
  const matrix=()=>page.locator('.react-flow__viewport').evaluate(el=>{const m=new DOMMatrixReadOnly((el as HTMLElement).style.transform);return {x:m.e,y:m.f,zoom:m.a};});
  await expect(page.getByRole('status',{name:'修改跟随'})).toHaveText('正在跟随修改');
  const board=(await page.locator('main.board').boundingBox())!;await page.mouse.move(board.x+8,board.y+board.height/2);await page.mouse.wheel(0,80);
  await expect(page.getByRole('status',{name:'修改跟随'})).toHaveText('已由你控制视野');
  await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  const liveCamera=await matrix();
  await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera.y;})).toBeCloseTo(liveCamera.y,3);
  const camera=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera;});
  await writeFile(release,'continue');
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('等待整合',{timeout:15000});
  await expect(page.getByRole('status',{name:'修改跟随'})).toHaveText('已由你控制视野');
  await expect(page.getByRole('textbox',{name:'编辑首段正文'})).toContainText('受控协议回归');
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('草稿候选');
  const actual=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return {state:await b.readingState(c.sessionId),unit:c.unit,graph:await b.graph(c.sessionId)};});expect(actual.state.camera).toEqual(camera);const finalCamera=await matrix();expect(finalCamera.x).toBeCloseTo(liveCamera.x,3);expect(finalCamera.y).toBeCloseTo(liveCamera.y,3);expect(finalCamera.zoom).toBeCloseTo(liveCamera.zoom,6);
  expect(actual.unit.reading.blocks[0].kind).toBe('example');const baseline=actual.graph.layout.nodes.find((n:any)=>n.unitId==='KU-001');
  await page.getByRole('button',{name:'收起对话',exact:true}).click();
  const summary=page.locator('[data-agent-unit="KU-001"] details summary').first();await revealBoardControl(page,summary);await summary.click();await summary.click();
  expect((await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.graph(c.sessionId);})).layout.nodes.find((n:any)=>n.unitId==='KU-001')).toEqual(baseline);
  await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();
  await page.getByRole('button',{name:'停止任务',exact:true}).click();
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('已停止');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(page.getByRole('status',{name:'回答状态'})).toContainText('已停止');
  expect((await page.evaluate(()=>(window as any).yizhi.open())).unit).toEqual(actual.unit);
  await page.getByRole('button',{name:'非十进制与十进制互转',exact:true}).click();
  await page.getByRole('button',{name:'查看实际修改',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).unitId;})).toBe('KU-001');
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,'t17-controlled-small-reopen.png')});
 }finally{await writeFile(release,'continue');await app.close();await rm(root,{recursive:true,force:true});}
});


import { CourseService } from '../src/core/course-service';
import { muxCopy,correction,muxId } from './agent-mutation-setup';
test('linked experiment formula offers grouped editing while actual input controls and confirmed scene survive small-window reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-linked-formula-ui-')),core=new CourseService(resolve('dist/worker.cjs'));let app:any;
 try{
  const {sessionId,citation,view}=await muxCopy(core,join(root,'course'));const result=await core.commands.commit(await correction(core,sessionId,citation.id,'correct-linked-copy'));expect(result.status).toBe('committed');
  let v=await core.experiments.read({sessionId,instanceId:view.instanceId});await core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'adopt',action:{kind:'migrate',baseVersion:v.version}});await core.close();
  const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-generation-needed')}});app=await launch();let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'复用器与分配器',exact:true}).click();await page.getByRole('button',{name:'MUX 器件、级联与扩展',exact:true}).first().click();
  const lab=page.getByRole('region',{name:'交互 · 4 选 1 的选择语义',exact:true}),edit=lab.getByRole('button',{name:'编辑实验公式',exact:true});
  await revealBoardControl(page,edit);await expect(edit).toBeDisabled();await expect(lab.getByRole('status',{name:'关联公式编辑'})).toContainText('请在 Agent 中请求修改');
  const input=lab.getByRole('checkbox',{name:'I0',exact:true});await revealBoardControl(page,input);await input.check();await expect(lab.getByRole('status',{name:'MUX 输出'})).toHaveText('输出 Z = 1');await expect(lab.getByRole('status',{name:'实验保存状态'})).toHaveText('现场已保存');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  await expect(page.getByRole('button',{name:'编辑实验公式',exact:true})).toBeDisabled();const read=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.experiments.open({sessionId:c.sessionId,unitId:'KU-057',blockId:'RB-TH-13-057-010-interactive'});});expect(read.formulaScope).toBe('consistency-group');expect(read.state.inputs.I0).toBe(1);expect(read.result.output).toBe(1);
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,'t17-linked-formula-scope.png')});
 }finally{await app?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
