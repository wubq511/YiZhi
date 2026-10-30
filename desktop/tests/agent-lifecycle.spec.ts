import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';

test('lifecycle controls expose stopping, explicit continue and reopen the current composer without starting another turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-lifecycle-ui-')),cli=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(cli,0o755);
 const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:cli,YIZHI_FIXTURE_MODE:'linger'}});
 try {
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'学习对话',exact:true}).click();
  const composer=page.getByRole('textbox',{name:'学习对话草稿'});
  await expect(page.getByText('本机 Codex CLI · 已连接',{exact:true})).toBeVisible();
  await composer.fill('解释位权');await page.getByRole('button',{name:'发送问题',exact:true}).click();
  await expect(page.locator('.agent-message.assistant')).toContainText('位置的权');
  await page.getByRole('button',{name:'停止任务',exact:true}).click();
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('正在停止');
  await expect(page.getByRole('status',{name:'回答状态'})).toContainText('已停止');
  await composer.fill('关窗保存的最新尾部');
  await page.getByRole('button',{name:'继续剩余工作',exact:true}).click();
  await expect(page.getByRole('status',{name:'回答状态'})).toHaveCount(2);
  await expect(composer).toHaveValue('关窗保存的最新尾部');
  const tasks=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),l=await b.agent.list(c);return (await b.agent.get({...c,conversationId:l.selectedId})).tasks;});
  expect(tasks[1].continuesTaskId).toBe(tasks[0].id);expect(tasks[1].attemptId).not.toBe(tasks[0].attemptId);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await expect.poll(()=>app.windows().length).toBe(0);
  await app.evaluate(({app})=>app.emit('activate'));
  page=await app.waitForEvent('window');await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'学习对话',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('关窗保存的最新尾部');
  await expect(page.getByRole('status',{name:'回答状态'})).toHaveCount(2);
  await expect(page.getByRole('status',{name:'回答状态'}).nth(1)).toContainText('回答已完成');
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
