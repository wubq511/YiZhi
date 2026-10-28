import {test,expect,_electron as electron} from '@playwright/test';
import {cp,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {resizeBoardWindow} from './board-test-helpers';

test('the actual upgraded personal course opens as an independent offline UI copy with original history, pending draft and fixed source',async()=>{
 test.skip(!process.env.YIZHI_T26_ACTUAL_EVIDENCE,'Opt-in actual copied-course acceptance; no original writes or executor.');
 const evidence=JSON.parse(await readFile(process.env.YIZHI_T26_ACTUAL_EVIDENCE!,'utf8')),root=await mkdtemp(join(tmpdir(),'yizhi-upgraded-personal-ui-')),course=join(root,'完整个人课 format2');await cp(evidence.portable,course,{recursive:true});
 const app=await electron.launch({args:[resolve('.'),`--course=${course}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'fresh-profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
 try{
  const page=await app.firstWindow();await page.context().setOffline(true);await resizeBoardWindow(app,page);await expect(page.getByRole('status',{name:'课程格式',exact:true})).toHaveText('课程已升级');
  const facts=await page.evaluate(async()=>{const c=await window.yizhi.open(),graph=await window.yizhi.graph(c.sessionId),chats=await window.yizhi.agent.list(c),conversations=await Promise.all(chats.conversations.map(chat=>window.yizhi.agent.get({...c,conversationId:chat.id})));
   return{courseId:c.courseId,format:c.courseFormat,units:graph.nodes.length,notes:await window.yizhi.annotations.list(c),sources:await window.yizhi.sources.list(c),pending:await window.yizhi.migration.pending(c),tasks:conversations.flatMap(v=>v.tasks),messages:conversations.flatMap(v=>v.messages)};});
  expect(facts.format).toBe(2);expect(facts.units).toBe(84);expect(facts.notes).toHaveLength(1);expect(facts.notes[0].current.status).toBe('orphan');expect(facts.sources.versions).toHaveLength(16);expect(facts.pending.filter(p=>p.state==='unresolved')).toHaveLength(1);expect(facts.tasks).toHaveLength(2);expect(facts.tasks.every(t=>t.status==='completed')).toBe(true);expect(facts.messages).toHaveLength(4);
  await page.getByRole('button',{name:'原文资料',exact:true}).click();await page.getByLabel('资料版本',{exact:true}).selectOption(facts.sources.versions[0].versionId);await expect(page.getByRole('status',{name:'原文状态'})).toHaveText('原页已载入');await expect(page.locator('.source-pdf canvas')).toBeVisible();await page.screenshot({path:test.info().outputPath('actual-format2-source.png')});await page.getByRole('button',{name:'返回画板',exact:true}).click();
  await page.getByRole('button',{name:'迁移记录',exact:true}).click();await page.getByRole('button',{name:'旧版历史',exact:true}).click();await expect(page.getByRole('region',{name:'迁移记录'})).toContainText('原操作');await page.getByRole('button',{name:'待核对草稿',exact:true}).click();await expect(page.getByLabel('原记录详情',{exact:true})).toContainText('AGENT-new');await page.screenshot({path:test.info().outputPath('actual-format2-history-draft.png')});await page.getByRole('button',{name:'关闭迁移面板',exact:true}).click();
  await resizeBoardWindow(app,page,700,700);if(await page.getByRole('button',{name:'关闭目录',exact:true}).isVisible())await page.getByRole('button',{name:'关闭目录',exact:true}).click();await page.getByRole('button',{name:'备份与升级',exact:true}).click();const panel=page.getByRole('dialog',{name:'备份与升级',exact:true});await expect(panel).toContainText('课程格式已升级');expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:test.info().outputPath('actual-format2-narrow.png')});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
