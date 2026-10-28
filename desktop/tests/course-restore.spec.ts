import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { resizeBoardWindow,revealBoardControl } from './board-test-helpers';
const A='RB-TH-01-01-what-is-positional-notation';
test('independent whole-course UI preserves personal state and a real incomplete draft, rotates cached view and all inputs, then reopens',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-t22-ui-')),directory=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 const o=await core.open(directory),other=await core.read(o.sessionId,'KU-002'),b=other.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
 await core.save({sessionId:o.sessionId,operationId:'ui-course-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'整课旧讲解'});
 await core.save({sessionId:o.sessionId,operationId:'ui-course-later',inputSeq:2,baseRevision:2,blockId:A,text:'整课当前讲解'});
 await core.commitEdit({sessionId:o.sessionId,unitId:'KU-002',operationId:'ui-course-other',inputSeq:1,baseRevision:1,complete:true,changes:[{blockId:b.id,text:'另一个单元当前内容'}]});
 await core.setReviewStatus(o.sessionId,'KU-001','mastered');await core.close();
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-model-needed')}});
 let app=await launch();
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
  const old=await page.evaluate(()=>(window as any).yizhi.open());
  const formula=page.locator('.editor-formula').first();await revealBoardControl(page,formula.getByRole('button',{name:'编辑公式',exact:true}));await formula.getByRole('button',{name:'编辑公式',exact:true}).click();
  await formula.locator('math-field').evaluate((el:any)=>{el.executeCommand('selectAll');el.executeCommand(['insert','\\frac{1}{#?}']);});
  await expect(page.getByRole('button',{name:'整课历史恢复',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'整课历史恢复',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'整课历史恢复',exact:true});
  await expect(dialog).toContainText('单元取回');await expect(dialog).toContainText('备份');
  await expect(dialog.getByLabel('恢复所选单元的布局')).not.toBeChecked();await expect(dialog.getByLabel('恢复所选单元的掌握状态')).not.toBeChecked();
  await dialog.getByLabel('历史时间点').selectOption('ui-course-anchor');
  await dialog.getByRole('button',{name:'预览整课所选范围',exact:true}).click();
  await expect(dialog.getByRole('region',{name:'整课恢复影响'})).toContainText('1 份有效草稿');
  await resizeBoardWindow(app,page,700,700);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:test.info().outputPath('course-restore-narrow-preview.png')});await resizeBoardWindow(app,page);
  await dialog.getByRole('button',{name:'确认恢复并隔离旧任务',exact:true}).click();
  const fresh=page.getByRole('dialog',{name:'整课历史恢复',exact:true});
  await expect(fresh.getByRole('status',{name:'整课恢复结果'})).toContainText('已完成');
  await fresh.getByRole('button',{name:'查看恢复前草稿',exact:true}).click();
  await expect(fresh.getByRole('region',{name:'恢复前草稿（只读）'})).toContainText('placeholder');
  await page.screenshot({path:test.info().outputPath('course-restore-result-drafts.png')});
  const after=await page.evaluate(async()=>{const c=await(window as any).yizhi.open();return {c,review:await(window as any).yizhi.reviewStates(c.sessionId),other:await(window as any).yizhi.readUnit(c.sessionId,'KU-002')};});
  expect(after.c.generation).toBe(2);expect(after.c.sessionId).not.toBe(old.sessionId);expect(after.c.drafts).toHaveLength(0);expect(after.review.units['KU-001'].status).toBe('mastered');expect(after.other.reading.blocks.find((p:any)=>p.id===b.id).payload.text).toBe(b.payload.text);
  await fresh.getByRole('button',{name:'返回当前课程',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'编辑首段正文',exact:true});await revealBoardControl(page,editor);await expect(editor).toHaveText('整课旧讲解');await editor.click();await page.keyboard.insertText(' 新代际输入');
  await expect.poll(()=>page.evaluate(async()=>(await(window as any).yizhi.open()).unit.reading.blocks[0].payload.text)).toContain('新代际输入');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  const reopened=await page.evaluate(()=>(window as any).yizhi.open());expect(reopened.generation).toBe(2);expect(reopened.unit.reading.blocks[0].payload.text).toContain('新代际输入');expect(reopened.drafts).toHaveLength(0);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

import { DatabaseSync } from 'node:sqlite';
test('selected user states and the original recovery identity survive a real SQL failure and app restart before explicit retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-t22-ui-retry-')),directory=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 const o=await core.open(directory),n=(await core.graph(o.sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!;
 await core.setReviewStatus(o.sessionId,'KU-001','mastered');await core.setLayout(o.sessionId,[{unitId:n.unitId,x:n.x+60,y:n.y,width:n.width}]);
 await core.save({sessionId:o.sessionId,operationId:'ui-state-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'按所选时间恢复'});
 await core.setReviewStatus(o.sessionId,'KU-001','weak');await core.setLayout(o.sessionId,[{unitId:n.unitId,x:n.x+160,y:n.y,width:n.width}]);
 await core.save({sessionId:o.sessionId,operationId:'ui-state-later',inputSeq:2,baseRevision:2,blockId:A,text:'失败时保持当前'});await core.close();
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-model-needed')}});
 let app=await launch(),fault:DatabaseSync|undefined;
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'整课历史恢复',exact:true}).click();let dialog=page.getByRole('dialog',{name:'整课历史恢复',exact:true});
  await dialog.getByLabel('历史时间点').selectOption('ui-state-anchor');await dialog.getByLabel('恢复所选单元的布局').check();await dialog.getByLabel('恢复所选单元的掌握状态').check();
  await dialog.getByRole('button',{name:'预览整课所选范围',exact:true}).click();await expect(dialog.getByRole('region',{name:'整课恢复影响'})).toContainText('掌握状态按所选时间恢复');
  fault=new DatabaseSync(join(directory,'course.sqlite'));fault.exec("CREATE TRIGGER ui_course_restore_fault BEFORE INSERT ON cg_history BEGIN SELECT RAISE(ABORT,'whole course UI disk fault'); END");
  await dialog.getByRole('button',{name:'确认恢复并隔离旧任务',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('whole course UI disk fault');
  const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('yizhi-course-restore:'))!)!));
  expect((await page.evaluate(()=>(window as any).yizhi.open())).generation).toBe(1);
  fault.exec('DROP TRIGGER ui_course_restore_fault');fault.close();fault=undefined;
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);dialog=page.getByRole('dialog',{name:'整课历史恢复',exact:true});
  await expect(dialog.getByRole('alert')).toContainText('不会自动执行');await dialog.getByRole('button',{name:'核对并重试原操作',exact:true}).click();
  await expect(page.getByRole('status',{name:'整课恢复结果'})).toContainText('已完成');
  const result=await page.evaluate(async original=>{const b=(window as any).yizhi,c=await b.open();return {c,receipt:await b.courseRestore.query({sessionId:original.sessionId,operationId:original.operationId}),review:await b.reviewStates(c.sessionId),graph:await b.graph(c.sessionId)};},pending);
  expect(result.receipt.operationId).toBe(pending.operationId);expect(result.c.generation).toBe(2);expect(result.c.unit.reading.blocks[0].payload.text).toBe('按所选时间恢复');expect(result.review.units['KU-001'].status).toBe('mastered');expect(result.graph.layout.nodes.find((p:any)=>p.unitId==='KU-001').x).toBe(n.x+60);
 }finally{if(fault){fault.exec('DROP TRIGGER IF EXISTS ui_course_restore_fault');fault.close();}await app.close();await rm(root,{recursive:true,force:true});}
});
