import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';
import type { Page } from '@playwright/test';
async function view(page:Page){return page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),l=await b.agent.list({sessionId:c.sessionId});return b.agent.get({sessionId:c.sessionId,conversationId:l.selectedId});});}
async function openAgent(page:Page){await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(page.getByText('本机 Codex CLI · 已连接',{exact:true})).toBeVisible({timeout:30000});await page.getByLabel('问答模型').selectOption('gpt-6-luna');}
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
