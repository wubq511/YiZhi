import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { resizeBoardWindow } from './board-test-helpers';
const A='RB-TH-01-01-what-is-positional-notation';
test('actual course settings validate days, report the real shrinking recovery window, clear only cache and persist after app reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-ui-')),directory=join(root,'course'),clock=new SharedArrayBuffer(8);
 Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()-40*86_400_000));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 const c=await core.open(directory),old=await core.save({...c,operationId:'ui-old-window',inputSeq:1,baseRevision:1,blockId:A,text:'Old UI recovery body'});
 Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()));
 await core.save({...c,operationId:'ui-current-window',inputSeq:2,baseRevision:2,blockId:A,text:'Current UI recovery body'});await core.search.rebuild({...c,batchSize:8});await core.close();
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-needed')}});
 let app=await launch();
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'历史与空间',exact:true}).click();let dialog=page.getByRole('dialog',{name:'历史与空间',exact:true});
  await expect(dialog.getByLabel('历史保留天数')).toHaveValue('140');await expect(dialog).toContainText('不能找回');await expect(dialog).toContainText('独立备份');
  await dialog.getByLabel('历史保留天数').fill('0');await dialog.getByRole('button',{name:'保存期限',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('正整数');
  await dialog.getByLabel('历史保留天数').fill('30');await dialog.getByRole('button',{name:'保存期限',exact:true}).click();
  await expect(dialog.getByRole('status',{name:'历史保留状态'})).toContainText('保留 30 天');
  await expect.poll(()=>page.evaluate(async()=>{const c=await window.yizhi.open();return (await window.yizhi.retention.get(c)).pendingGroups;})).toBe(0);
  const facts=await page.evaluate(async()=>{const c=await window.yizhi.open();let expired=false;try{await window.yizhi.formalHistory.detail({...c,operationId:'ui-old-window'});}catch(e){expired=/过期/.test(String(e));}return {expired,receipt:await window.yizhi.queryOperation(c.sessionId,'ui-old-window'),c};});
  expect(facts.expired).toBe(true);expect(facts.receipt).toEqual(old);expect(facts.c.unit.reading.blocks[0].payload.text).toBe('Current UI recovery body');
  await dialog.getByRole('button',{name:'清除搜索缓存',exact:true}).click();await expect(dialog.getByRole('status',{name:'空间操作结果'})).toContainText('缓存已清除');
  await resizeBoardWindow(app,page,700,700);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:test.info().outputPath('retention-space.png')});await dialog.evaluate(el=>{el.scrollTop=0;});await page.screenshot({path:test.info().outputPath('retention-narrow.png')});
  const render=await dialog.evaluate(el=>({viewport:[innerWidth,innerHeight],dialog:{width:el.clientWidth,scrollWidth:el.scrollWidth},samples:[...el.querySelectorAll('h2,p,input,button,caption,th,td')].slice(0,30).map(node=>{const s=getComputedStyle(node);return {tag:node.tagName,text:node.textContent?.slice(0,40),font:s.fontSize,lineHeight:s.lineHeight,color:s.color,background:s.backgroundColor,padding:s.padding};})}));await test.info().attach('retention-render-facts',{body:JSON.stringify(render,null,2),contentType:'application/json'});
  await dialog.getByRole('button',{name:'返回课程',exact:true}).click();await expect(page.getByRole('button',{name:'历史与空间',exact:true})).toBeFocused();
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'历史与空间',exact:true}).click();dialog=page.getByRole('dialog',{name:'历史与空间',exact:true});await expect(dialog.getByLabel('历史保留天数')).toHaveValue('30');
  await expect(dialog).toContainText('最早保留提交');await expect(dialog).toContainText('保留 30 天');await page.screenshot({path:test.info().outputPath('retention-reopened.png')});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('actual history preview protects its original window until the student returns to the history list',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-preview-ui-')),directory=join(root,'course'),clock=new SharedArrayBuffer(8);
 Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()-40*86_400_000));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}}),c=await core.open(directory);
 await core.save({...c,operationId:'held-preview-old',inputSeq:1,baseRevision:1,blockId:A,text:'Held old UI preview'});
 Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()));await core.save({...c,operationId:'held-preview-current',inputSeq:2,baseRevision:2,blockId:A,text:'Current UI body'});await core.close();
 const app=await electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-needed')}});
 try{
  const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'课程历史',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'修改历史',exact:true});await expect(dialog.locator('.history-activity')).toHaveCount(2);
  await dialog.locator('.history-activity').last().locator('summary').first().click();await dialog.getByRole('button',{name:'查看修改后版本',exact:true}).click();
  await expect(dialog.getByRole('region',{name:'旧版只读预览'})).toContainText('Held old UI preview');
  await page.evaluate(async()=>{const c=await window.yizhi.open();await window.yizhi.retention.set({...c,days:30});});
  await expect.poll(()=>page.evaluate(async()=>window.yizhi.retention.get(await window.yizhi.open()))).toMatchObject({pendingGroups:1,blocked:expect.stringMatching(/预览|恢复/)});
  await dialog.getByRole('button',{name:'返回历史列表',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=>(await window.yizhi.retention.get(await window.yizhi.open())).pendingGroups)).toBe(0);
  expect(await page.evaluate(async()=>{const c=await window.yizhi.open();try{await window.yizhi.formalHistory.detail({...c,operationId:'held-preview-old'});return false;}catch(e){return /过期/.test(String(e));}})).toBe(true);
  await dialog.getByRole('button',{name:'返回原阅读位置',exact:true}).click();
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
