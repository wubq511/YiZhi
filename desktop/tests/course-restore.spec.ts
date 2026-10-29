import type { DatabaseSync } from 'node:sqlite';
import { openFaultDatabase } from './fault-database';
import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm,chmod } from 'node:fs/promises';
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
  await expect(fresh.getByRole('region',{name:'未完成公式草稿'})).toContainText('placeholder');
  await page.screenshot({path:test.info().outputPath('course-restore-result-drafts.png')});
  const after=await page.evaluate(async()=>{const c=await(window as any).yizhi.open();return {c,review:await(window as any).yizhi.reviewStates(c.sessionId),other:await(window as any).yizhi.readUnit(c.sessionId,'KU-002')};});
  expect(after.c.generation).toBe(2);expect(after.c.sessionId).not.toBe(old.sessionId);expect(after.c.drafts).toHaveLength(0);expect(after.review.units['KU-001'].status).toBe('mastered');expect(after.other.reading.blocks.find((p:any)=>p.id===b.id).payload.text).toBe(b.payload.text);
  await fresh.getByRole('button',{name:'返回当前课程',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'编辑首段正文',exact:true});await revealBoardControl(page,editor);await expect(editor).toHaveText('整课旧讲解');await editor.click();await page.keyboard.insertText(' 新代际输入');
  await expect.poll(()=>page.evaluate(async()=>(await(window as any).yizhi.open()).unit.reading.blocks[0].payload.text)).toContain('新代际输入');
  await page.getByRole('button',{name:'整课历史恢复',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'整课历史恢复',exact:true}).getByLabel('历史时间点')).toBeVisible();
  await page.getByRole('button',{name:'返回当前课程',exact:true}).click();
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  const reopened=await page.evaluate(()=>(window as any).yizhi.open());expect(reopened.generation).toBe(2);expect(reopened.unit.reading.blocks[0].payload.text).toContain('新代际输入');expect(reopened.drafts).toHaveLength(0);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('epoch remount holds the real B read without resurrecting old editors or accepting old IPC tails, then saves through the new editor',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-t22-epoch-ui-')),directory=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 const o=await core.open(directory),unit=(await core.read(o.sessionId,'KU-002')).unit,b=unit.reading.blocks.find(p=>p.kind==='paragraph')!;
 await core.commitEdit({sessionId:o.sessionId,unitId:unit.id,operationId:'epoch-anchor',inputSeq:1,baseRevision:1,complete:true,changes:[{blockId:b.id,text:'B historical epoch content'}]});
 await core.commitEdit({sessionId:o.sessionId,unitId:unit.id,operationId:'epoch-later',inputSeq:2,baseRevision:2,complete:true,changes:[{blockId:b.id,text:'B obsolete epoch content'}]});
 await core.setReadingState(o.sessionId,{unitId:unit.id,expanded:{},returnStack:[],scrollTop:0});await core.close();
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-model-needed')}});
 let app=await launch();
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  const reader=page.locator('[data-agent-unit="KU-002"]'),editor=reader.getByRole('textbox',{name:'连续编辑正文',exact:true});
  await expect(editor).toContainText('B obsolete epoch content');
  await editor.evaluate(el=>{(window as any).oldEpochEditor=el;});
  const old=await page.evaluate(()=>window.yizhi.open());
  // Hold one real old-channel event reply and the new B editor's initial Worker read.
  await app.evaluate((_,oldSession)=>{
   const {Worker}=process.getBuiltinModule('node:worker_threads')!,post=Worker.prototype.postMessage,emit=Worker.prototype.emit;
   let oldReply:number|undefined,oldHeld=false,newHeld=false;
   (globalThis as any).epochReadState={oldHeld:false,newHeld:false};
   Worker.prototype.postMessage=function(message:any,transfer:any){
    if(!oldHeld&&oldReply===undefined&&message.action==='readEvents'&&message.payload?.sessionId===oldSession)oldReply=message.id;
    if(!newHeld&&message.action==='read'&&message.payload?.unitId==='KU-002'&&message.payload.sessionId!==oldSession){
     newHeld=true;(globalThis as any).epochReadState.newHeld=true;
     (globalThis as any).releaseEpochRead=()=>post.call(this,message,transfer);return;
    }
    post.call(this,message,transfer);
   };
   Worker.prototype.emit=function(event:any,...args:any[]){
    if(event==='message'&&!oldHeld&&args[0]?.id===oldReply){oldHeld=true;(globalThis as any).epochReadState.oldHeld=true;(globalThis as any).releaseOldEpochReply=()=>emit.call(this,event,...args);return true;}
    return emit.call(this,event,...args);
   };
   (globalThis as any).restoreEpochWorker=()=>{Worker.prototype.postMessage=post;Worker.prototype.emit=emit;};
  },old.sessionId);
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).epochReadState.oldHeld)).toBe(true);
  await page.getByRole('button',{name:'整课历史恢复',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'整课历史恢复',exact:true});
  await dialog.getByLabel('历史时间点').selectOption('epoch-anchor');await dialog.getByRole('button',{name:'预览整课所选范围',exact:true}).click();
  await dialog.getByRole('button',{name:'确认恢复并隔离旧任务',exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).epochReadState.newHeld)).toBe(true);
  expect(await page.evaluate(()=>(window as any).oldEpochEditor.isConnected)).toBe(false);
  await expect(editor).toHaveCount(0);
  await app.evaluate(()=>{(globalThis as any).releaseOldEpochReply();});
  const rejected=await page.evaluate(async old=>{
   const b=window.yizhi,attempts=[()=>b.saveDraft({sessionId:old.sessionId,unitId:'KU-002',inputSeq:99,baseRevision:3,complete:true,changes:[]}),()=>b.setReviewStatus(old.sessionId,'KU-002','weak'),()=>b.commands.protect({sessionId:old.sessionId,unitId:'KU-002',editorId:'old-epoch-editor',sequence:99,blockIds:[],mode:'editing',inputSeq:99})];
   return Promise.all(attempts.map(async run=>{try{await run();return 'accepted';}catch(e){return String(e);}}));
  },old);
  expect(rejected.every(message=>/会话|代际/.test(message))).toBe(true);
  await expect(editor).toHaveCount(0);
  await app.evaluate(()=>{(globalThis as any).releaseEpochRead();(globalThis as any).restoreEpochWorker();});
  await expect(page.getByRole('status',{name:'整课恢复结果'})).toContainText('已完成');
  await page.getByRole('button',{name:'返回当前课程',exact:true}).click();
  await expect(editor).toContainText('B historical epoch content');await expect(editor).not.toContainText('B obsolete epoch content');
  const paragraph=editor.locator(`[data-block-id="${b.id}"]`);await revealBoardControl(page,paragraph);await paragraph.click();await page.keyboard.press('Home');await page.keyboard.insertText('New B keyboard input: ');
  await expect(reader.getByRole('status',{name:'当前单元保存状态'})).toHaveText('已保存');
  await expect.poll(()=>page.evaluate(async id=>{const c=await window.yizhi.open();return (await window.yizhi.read(c.sessionId,'KU-002')).unit.reading.blocks.find(p=>p.id===id)!.payload.text;},b.id)).toBe('New B keyboard input: B historical epoch content');
  await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);
  await expect(page.locator('[data-agent-unit="KU-002"]').getByRole('textbox',{name:'连续编辑正文',exact:true})).toContainText('New B keyboard input: B historical epoch content');
 }finally{await app.evaluate(()=>{(globalThis as any).releaseEpochRead?.();(globalThis as any).releaseOldEpochReply?.();(globalThis as any).restoreEpochWorker?.();}).catch(()=>{});await app.close();await rm(root,{recursive:true,force:true});}
});

test('whole-course recovery interrupts an actual host protocol turn while its original committed receipt stays queryable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-t22-task-ui-')),directory=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 const o=await core.open(directory);await core.save({sessionId:o.sessionId,operationId:'running-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Before executing task'});await core.close();
 const cli=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(cli,0o755);
 const app=await electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:cli,YIZHI_FIXTURE_MODE:'history-stop'}});
 try{
  const page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
  await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await expect(page.getByText('本机 Codex CLI · 已连接',{exact:true})).toBeVisible();
  await page.getByLabel('Agent 请求方式').selectOption('modify');await page.getByRole('textbox',{name:'学习对话草稿'}).fill('恢复整课前提交真实协议组并保持运行');await page.getByRole('button',{name:'发送修改请求',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'编辑首段正文'})).toContainText('受控协议回归');
  const original=await page.evaluate(async()=>{const b=window.yizhi,c=await b.open(),list=await b.agent.list(c),view=await b.agent.get({...c,conversationId:list.selectedId!});return {sessionId:c.sessionId,task:view.tasks[0],receipt:await b.commands.query({...c,operationId:'controlled-group1'})};});
  expect(original.task.status).toBe('running');
  await page.getByRole('button',{name:'整课历史恢复',exact:true}).click();const dialog=page.getByRole('dialog',{name:'整课历史恢复',exact:true});await dialog.getByLabel('历史时间点').selectOption('running-anchor');await dialog.getByRole('button',{name:'预览整课所选范围',exact:true}).click();await dialog.getByRole('button',{name:'确认恢复并隔离旧任务',exact:true}).click();
  await expect(page.getByRole('status',{name:'整课恢复结果'})).toContainText('已完成');
  await expect.poll(()=>page.evaluate(async original=>{const c=await window.yizhi.open(),v=await window.yizhi.agent.get({...c,conversationId:original.task.conversationId});return v.tasks[0].executorStatus;},original)).toBe('interrupted');
  const after=await page.evaluate(async original=>{const b=window.yizhi,c=await b.open();return {c,view:await b.agent.get({...c,conversationId:original.task.conversationId}),receipt:await b.commands.query({sessionId:original.sessionId,operationId:'controlled-group1'})};},original);
  expect(after.c.generation).toBe(2);expect(after.c.unit.reading.blocks[0].payload.text).toBe('Before executing task');expect(after.view.tasks[0].status).toBe('stopped');expect(after.receipt).toEqual(original.receipt);expect(after.view.tasks).toHaveLength(1);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

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
  fault=openFaultDatabase(join(directory,'course.sqlite'));fault.exec("CREATE TRIGGER ui_course_restore_fault BEFORE INSERT ON cg_history BEGIN SELECT RAISE(ABORT,'whole course UI disk fault'); END");
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
