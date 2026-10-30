import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';
import type { Page } from '@playwright/test';
async function view(page:Page){return page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),l=await b.agent.list({sessionId:c.sessionId});return b.agent.get({sessionId:c.sessionId,conversationId:l.selectedId});});}
async function openAgent(page:Page){await page.getByRole('button',{name:'学习对话',exact:true}).click();await expect(page.getByText('本机 Codex CLI · 已连接',{exact:true})).toBeVisible({timeout:30000});await page.getByLabel('问答模型').selectOption('gpt-6-luna');}
test('installed CLI stops original turn, explicitly continues with fresh tool reads, survives learning-window close and reconciles durable results on reopen',async()=>{
 test.skip(process.env.YIZHI_REAL_EXECUTOR!=='1','Opt-in installed CLI acceptance, not protocol fixture');test.setTimeout(180000);
 const root=await mkdtemp(join(tmpdir(),'yizhi-t19-actual-')),result:any={};let app:any;
 const env={...process.env,PATH:'/usr/bin:/bin',YIZHI_DATA_HOME:join(root,'profile')} as Record<string,string>;delete env.YIZHI_CODEX_PATH;delete env.YIZHI_FIXTURE_MODE;
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env});
 try {
  app=await launch();let page:Page=await app.firstWindow();await resizeBoardWindow(app,page);await openAgent(page);
  result.executor=await page.evaluate(()=>(window as any).yizhi.agent.status());result.runtime=(await page.evaluate(()=>(window as any).yizhi.open())).runtime;
  const composer=page.getByRole('textbox',{name:'学习对话草稿'});
  await composer.fill('先调用 yizhi_read_target 读取本次固定目标，再用课程依据和补充解释分别回答：位置记数法的位权为什么有效？给出十进制22和二进制101两例，逐步核对每位权值。限制450字，只读不修改课程。');
  await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect.poll(async()=>(await view(page)).toolFacts.some((f:any)=>f.name==='yizhi_read_target'),{timeout:60000,intervals:[50,100]}).toBe(true);
  result.beforeStop=await view(page);
  await page.getByRole('button',{name:'停止任务',exact:true}).click();
  await expect.poll(async()=>(await view(page)).tasks[0].status,{timeout:30000}).toBe('stopped');result.stopped=await view(page);
  expect(result.stopped.tasks[0].executorStatus).toBe('interrupted');
  await composer.fill('真实关窗后保留的最新草稿');
  await page.getByRole('button',{name:'继续剩余工作',exact:true}).click();
  await expect.poll(async()=>(await view(page)).tasks[1]?.turnId,{timeout:60000}).toBeTruthy();result.continuing=await view(page);
  expect(result.continuing.tasks[1].attemptId).not.toBe(result.stopped.tasks[0].attemptId);
  expect(result.continuing.tasks[1].continuesTaskId).toBe(result.stopped.tasks[0].id);
  const nextWindow=app.waitForEvent('window');
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].close());await expect.poll(()=>app.windows().length).toBe(0);
  await app.evaluate(({app}:any)=>app.emit('activate'));page=await nextWindow;await resizeBoardWindow(app,page);await openAgent(page);
  await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('真实关窗后保留的最新草稿');
  await expect.poll(async()=>(await view(page)).tasks[1]?.status,{timeout:90000}).toBe('completed');
  result.afterWindowReopen=await view(page);expect(result.afterWindowReopen.tasks).toHaveLength(2);
  expect(result.afterWindowReopen.tasks[1].turnId).toBe(result.continuing.tasks[1].turnId);
  result.reconciled=await page.evaluate(async(taskId)=>{const b=(window as any).yizhi,c=await b.open();return b.agent.reconcile({sessionId:c.sessionId,taskId});},result.stopped.tasks[0].id);
  expect(result.reconciled.recovery.state).toBe('resolved');
  expect(result.afterWindowReopen.toolFacts.filter((f:any)=>f.taskId===result.continuing.tasks[1].id).map((f:any)=>f.name)).toContain('yizhi_read_target');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);await openAgent(page);
  result.afterAppReopen=await view(page);expect(result.afterAppReopen.tasks).toHaveLength(2);expect(result.afterAppReopen.tasks[1].turnId).toBe(result.continuing.tasks[1].turnId);
  await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('真实关窗后保留的最新草稿');
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,'t19-actual-lifecycle-reopen.png')});result.passed=true;
 }catch(error){result.error=String(error);throw error;}finally{
  if(process.env.YIZHI_EVIDENCE_DIR)await writeFile(join(process.env.YIZHI_EVIDENCE_DIR,'t19-actual-lifecycle.json'),JSON.stringify(result,null,2));
  await app?.close();await rm(root,{recursive:true,force:true});
 }
});

test('installed CLI commits a real mutation before stop, preserves original receipts and explicitly continues remaining edits on reopen', async () => {
 test.skip(process.env.YIZHI_REAL_EXECUTOR !== '1', 'Opt-in actual CLI mutation lifecycle acceptance');
 test.setTimeout(210_000);
 const root = await mkdtemp(join(tmpdir(), 'yizhi-actual-mutation-stop-'));
 const result:any = { scope:'actual-mutation-stop-continue' }; let app:any;
 const env = { ...process.env, PATH:'/usr/bin:/bin', YIZHI_DATA_HOME:join(root,'profile') } as Record<string,string>;
 delete env.YIZHI_CODEX_PATH; delete env.YIZHI_FIXTURE_MODE;
 if (process.env.YIZHI_REAL_CODEX_PATH) env.YIZHI_CODEX_PATH = process.env.YIZHI_REAL_CODEX_PATH;
 const launch = () => electron.launch({ args:[resolve('.'),`--course=${join(root,'course')}`], env });
 const capture = async (page:Page) => page.evaluate(async () => {
  const api=(window as any).yizhi,c=await api.open(),list=await api.agent.list({sessionId:c.sessionId});
  return {course:c,view:await api.agent.get({sessionId:c.sessionId,conversationId:list.selectedId})};
 });
 try {
  app=await launch(); let page:Page=await app.firstWindow(); await resizeBoardWindow(app,page); await openAgent(page);
  result.executor=await page.evaluate(()=>(window as any).yizhi.agent.status());
  const requestedModel=process.env.YIZHI_REAL_MODEL??'gpt-6-luna';
  await page.getByLabel('问答模型').selectOption(requestedModel); result.model=requestedModel;
  const before=await capture(page); result.before=before;
  const paragraphs=before.course.unit.reading.blocks.filter((b:any)=>b.kind==='paragraph');
  const first='【实际停止验收甲】',second='【实际续接验收乙】';
  await page.getByLabel('Agent 请求方式').selectOption('modify');
  await page.getByRole('textbox',{name:'学习对话草稿'}).fill(
   `请实际执行两个顺序独立的正文修改。先读取固定目标与edit context，只在段落 ${paragraphs[0].id} 末尾追加“${first}”，保留全部原文，作为第一个独立apply_group保存。第一个组返回后，再次调用yizhi_read_target和yizhi_read_edit_context核对刚才结果，再在另一段落 ${paragraphs[1].id} 末尾追加“${second}”，作为第二个独立apply_group保存。每个标记只出现一次，若已存在则跳过已完成步骤。不要把两段合为一个组，不改公式、结构、布局或个人内容。若被停止，后续明确继续时先实际重读，只做尚未完成部分。`);
  await page.getByRole('button',{name:'发送修改请求',exact:true}).click();
  await expect.poll(async()=>((await view(page)).tasks[0]?.groups??[]).some((g:any)=>g.status==='committed'&&g.changedObjectIds.length),
   {timeout:90_000,intervals:[50,100]}).toBe(true);
  result.beforeStop=await capture(page);
  expect(result.beforeStop.view.tasks[0].status).toBe('running');
  await page.getByRole('button',{name:'停止任务',exact:true}).click();
  await expect.poll(async()=>(await view(page)).tasks[0].status,{timeout:30_000}).toBe('stopped');
  result.stopped=await capture(page);
  const stoppedTask=result.stopped.view.tasks[0],original=stoppedTask.groups.filter((g:any)=>g.status==='committed'&&g.changedObjectIds.length);
  expect(original.length).toBeGreaterThan(0);
  expect(result.stopped.course.unit.reading.blocks.find((b:any)=>b.id===paragraphs[0].id).payload.text).toContain(first);
  result.queried=await page.evaluate(async(groups)=>{
   const api=(window as any).yizhi,c=await api.open();return Promise.all(groups.map((g:any)=>api.commands.query({sessionId:c.sessionId,operationId:g.operationId})));
  },original);
  expect(result.queried).toEqual(original);
  await page.getByRole('textbox',{name:'学习对话草稿'}).fill('实际修改停止后的未发送学习草稿');
  await expect(page.getByRole('status',{name:'对话草稿保存'})).toHaveText('草稿已保存');
  await page.getByRole('button',{name:'继续剩余工作',exact:true}).click();
  await expect.poll(async()=>(await view(page)).tasks[1]?.turnId,{timeout:60_000}).toBeTruthy();
  result.continuing=await capture(page);
  const next=result.continuing.view.tasks[1];
  expect(next.attemptId).not.toBe(stoppedTask.attemptId); expect(next.continuesTaskId).toBe(stoppedTask.id);
  const nextWindow=app.waitForEvent('window');
  await app.evaluate(({BrowserWindow}:any)=>BrowserWindow.getAllWindows()[0].close());
  await expect.poll(()=>app.windows().length).toBe(0);
  await app.evaluate(({app}:any)=>app.emit('activate')); page=await nextWindow; await resizeBoardWindow(app,page); await openAgent(page);
  await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('实际修改停止后的未发送学习草稿');
  await expect.poll(async()=>(await view(page)).tasks[1]?.status,{timeout:90_000}).toBe('completed');
  result.completed=await capture(page);
  expect(result.completed.view.tasks[1].turnId).toBe(next.turnId);
  expect(result.completed.view.tasks[0].groups).toEqual(stoppedTask.groups);
  const latest=result.completed.course.unit.reading.blocks;
  for(const [block,marker] of [[paragraphs[0],first],[paragraphs[1],second]]) {
   expect(latest.find((b:any)=>b.id===block.id).payload.text).toBe(block.payload.text+marker);
  }
  expect(result.completed.view.toolFacts.filter((f:any)=>f.taskId===next.id).map((f:any)=>f.name))
   .toEqual(expect.arrayContaining(['yizhi_read_target','yizhi_read_edit_context']));
  await app.close(); app=await launch(); page=await app.firstWindow(); await resizeBoardWindow(app,page); await openAgent(page);
  result.reopened=await capture(page);
  expect(result.reopened.course.unit).toEqual(result.completed.course.unit);
  expect(result.reopened.view.tasks).toHaveLength(2);
  expect(result.reopened.view.tasks[0].groups).toEqual(stoppedTask.groups);
  expect(result.reopened.view.tasks[1].turnId).toBe(next.turnId);
  await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('实际修改停止后的未发送学习草稿');
  result.passed=true;
 } catch(error) {
  result.error=String(error);
  if(app?.windows().length) result.failure=await capture(app.windows()[0]).catch(()=>null);
  throw error;
 } finally {
  const directory=process.env.YIZHI_EVIDENCE_DIR;
  if(directory){await mkdir(directory,{recursive:true});await writeFile(join(directory,'actual-mutation-stop-continue.json'),JSON.stringify(result,null,2));}
  if(app){const timer=setTimeout(()=>app.process().kill('SIGKILL'),5000);try{await app.close();}finally{clearTimeout(timer);}}
  // Failed actual runs retain their isolated course/runtime log for diagnosis.
  if(result.passed)await rm(root,{recursive:true,force:true}); else console.log('Retained failed actual run:',root);
 }
});
