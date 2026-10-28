import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
const A='RB-TH-01-01-what-is-positional-notation';
async function fixture(run:(s:CourseService,d:string)=>Promise<void>){const d=await mkdtemp(join(tmpdir(),'yizhi-t22-')),s=new CourseService(resolve('dist/worker.cjs'));try{await run(s,d);}finally{await s.close();await rm(d,{recursive:true,force:true});}}
test('whole-course selected recovery atomically restores two units, rotates writing authority and preserves unselected personal state',async()=>fixture(async(s,d)=>{
 const opened=await s.open(d),sessionId=opened.sessionId,other=await s.read(sessionId,'KU-002'),b=other.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
 await s.save({sessionId,operationId:'anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Historical first explanation'});
 await s.save({sessionId,operationId:'later-first',inputSeq:2,baseRevision:2,blockId:A,text:'Current first explanation'});
 await s.commitEdit({sessionId,unitId:'KU-002',operationId:'later-second',inputSeq:1,baseRevision:other.revision,complete:true,changes:[{blockId:b.id,text:'Current second explanation'}]});
 await s.setReviewStatus(sessionId,'KU-001','mastered');
 const api=(s as any).courseRestore;
 const preview=await api.preview({sessionId,atOperationId:'anchor',side:'after',unitIds:['KU-001','KU-002'],userState:{layout:false,review:false}});
 const result=await api.apply({sessionId,operationId:'restore-course',preview});
 assert.equal(result.status,'committed');assert.equal(result.generation,2);
 const current=await s.open(d);assert.notEqual(current.sessionId,sessionId);assert.equal(current.generation,2);
 assert.equal(current.unit.reading.blocks[0].payload.text,'Historical first explanation');
 assert.equal((await s.readUnit(current.sessionId,'KU-002')).reading.blocks.find(p=>p.id===b.id)!.payload.text,b.payload.text);
 assert.equal((await s.reviewStates(current.sessionId)).units['KU-001'].status,'mastered');
 await assert.rejects(s.save({sessionId,operationId:'late-old-input',inputSeq:3,baseRevision:current.revision,blockId:A,text:'Forbidden old renderer'}),/会话|代际/);
 assert.deepEqual(await api.query({sessionId,operationId:'restore-course'}),result);
 assert.deepEqual(await api.apply({sessionId,operationId:'restore-course',preview}),result);
}));
test('explicit user-state range restores recorded layout and mastery while default recovery does not rewind them',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId,n=(await s.graph(sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!;
 await s.setReviewStatus(sessionId,'KU-001','mastered');
 await s.setLayout(sessionId,[{unitId:n.unitId,x:n.x+50,y:n.y,width:n.width}]);
 await s.save({sessionId,operationId:'state-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'State anchor'});
 await s.setReviewStatus(sessionId,'KU-001','weak');
 await s.setLayout(sessionId,[{unitId:n.unitId,x:n.x+150,y:n.y,width:n.width}]);
 const version=(await s.reviewStates(sessionId)).units['KU-001'].version;
 const api=(s as any).courseRestore,preview=await api.preview({sessionId,atOperationId:'state-anchor',side:'after',unitIds:['KU-001'],userState:{layout:true,review:true}});
 assert.ok(preview.changes.some((c:any)=>c.objectId==='review:KU-001'));
 const result=await api.apply({sessionId,operationId:'selected-state-recovery',preview});
 const current=await s.open(d);assert.equal(current.generation,2);
 assert.equal((await s.reviewStates(current.sessionId)).units['KU-001'].status,'mastered');
 assert.ok((await s.reviewStates(current.sessionId)).units['KU-001'].version>version);
 assert.equal((await s.graph(current.sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,n.x+50);
 assert.equal((await s.formalHistory.detail({sessionId:current.sessionId,operationId:result.operationId})).actor,'student');
 const beforeRestore=await api.preview({sessionId:current.sessionId,atOperationId:result.operationId,side:'before',unitIds:['KU-001'],userState:{layout:true,review:true}});
 await api.apply({sessionId:current.sessionId,operationId:'find-replaced-user-state',preview:beforeRestore});
 const again=await s.open(d);assert.equal((await s.reviewStates(again.sessionId)).units['KU-001'].status,'weak');
 assert.equal((await s.graph(again.sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,n.x+150);
}));
import { sourceFixture } from './source-fixture';
test('old public writes are fenced across body, drafts, personal, layout, source and experiment APIs; original catalogs and drafts stay readable',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await s.save({sessionId,operationId:'fence-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Keep source and personal state'});
 const block=(await s.read(sessionId)).unit.reading.blocks[0],text=block.payload.text;
 const note=await s.annotations.create({sessionId,operationId:'note',text:'Personal original',selection:{unitId:'KU-001',fragments:[{blockId:A,block,field:'text',formalRevision:2,source:'formal',projection:{version:1,encoding:'unicode-code-points',text},from:0,to:4,quote:'Keep'}]}});
 const drawing=await s.drawings.apply({sessionId,operationId:'drawing',id:'personal-shape',expectedVersion:0,value:{kind:'rectangle',anchor:{space:'board'},geometry:{x:10,y:20,width:30,height:40}}});
 const source=join(d,'new.pdf');await sourceFixture(source,'New source imported after historical anchor');
 const imported=await s.sources.importFile({sessionId,operationId:'new-source',generation:1,path:source,title:'Keep new catalog entry'});
 const draft={sessionId,inputSeq:2,baseRevision:2,complete:false,changes:[],formulaDrafts:[{blockId:A,latex:'\\frac{'}]};await s.saveDraft(draft);
 const conversation=await s.agent.create({sessionId,operationId:'conversation'});
 const before=await s.graph(sessionId),n=before.layout.nodes.find(n=>n.unitId==='KU-001')!;
 const api=s.courseRestore,preview=await api.preview({sessionId,atOperationId:'fence-anchor',side:'after',unitIds:['KU-001'],userState:{layout:false,review:false}});
 await api.apply({sessionId,operationId:'fence-recovery',preview});
 const current=await s.open(d),sid=current.sessionId;
 const rejected=[
 ()=>s.saveDraft({...draft,inputSeq:3}),
 ()=>s.commitEdit({sessionId,operationId:'late-edit',inputSeq:3,baseRevision:current.revision,complete:true,changes:[{blockId:A,text:'Late'}]}),
 ()=>s.annotations.update({sessionId,operationId:'late-note',id:note.id,expectedVersion:note.version,text:'Late'}),
 ()=>s.drawings.apply({sessionId,operationId:'late-drawing',id:drawing.id,expectedVersion:drawing.version,value:null}),
 ()=>s.drawings.place({sessionId,operationId:'late-place',before:n,after:{...n,x:n.x+5}}),
 ()=>s.setLayout(sessionId,[{unitId:n.unitId,x:n.x+7,y:n.y,width:n.width}]),
 ()=>s.setReviewStatus(sessionId,'KU-001','weak'),
 ()=>s.setReadingState(sessionId,{unitId:'KU-001',expanded:{},returnStack:[],scrollTop:999}),
 ()=>s.sources.importFile({sessionId,operationId:'late-source',generation:1,path:source,title:'Late'}),
 ()=>s.sources.saveContext({sessionId,generation:1,seq:1,state:{open:true,versionId:imported.version.versionId,pdfPageIndex:0,scrollTop:999,scrollLeft:0,scale:1}}),
 ()=>s.agent.saveDraft({sessionId,conversationId:conversation.id,seq:1,text:'Late composer'}),
 ()=>s.commands.protect({sessionId,editorId:'late-editor',sequence:1,blockIds:[A],mode:'editing',inputSeq:3}),
 ()=>s.experiments.open({sessionId,unitId:'KU-055',blockId:'not-even-a-valid-callback'}),
 ()=>s.extensions.open({sessionId}),
 ()=>s.formalHistory.apply({sessionId,operationId:'late-history',preview:awaitNever as any}),
 ];
 for(const write of rejected)await assert.rejects(write(),/会话|代际/);
 assert.deepEqual((await api.drafts({sessionId:sid}))[0].input,draft);
 assert.equal(current.drafts.length,0);assert.equal(current.preservedDraftCount,1);
 assert.equal((await s.annotations.list({sessionId:sid}))[0].text,note.text);
 assert.deepEqual((await s.drawings.list({sessionId:sid}))[0],drawing);
 assert.ok((await s.sources.list({sessionId:sid})).versions.some(v=>v.versionId===imported.version.versionId));
 assert.deepEqual(await s.sources.query({sessionId,operationId:'new-source'}),imported);
 assert.deepEqual(await s.queryOperation(sessionId,'fence-anchor'),await s.queryOperation(sid,'fence-anchor'));
 assert.deepEqual((await s.graph(sid)).layout,before.layout);
}));
const awaitNever=undefined;
test('old task qualification expires while exact committed tool receipts and late executor facts survive; explicit continue rereads the new generation',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await s.save({sessionId,operationId:'task-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Historical explanation'});
 const conversation=await s.agent.create({sessionId,operationId:'task-conversation'});
 const task=await s.agent.submit({sessionId,operationId:'task-start',conversationId:conversation.id,generation:1,intent:'modify',text:'Modify explanation',target:{unitId:'KU-001'}});
 const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1};
 await s.recordAgent({...identity,eventId:'bind',kind:'bind',threadId:'old-thread',turnId:'old-turn'});
 const context=await s.readAgentMutation(identity),receipt=await s.applyAgentMutation({...identity,input:{operationId:'actual-group',basisId:context.basisId,conclusionOrMethodChanged:false,updates:[{blockId:A,text:'Committed old task explanation'}]}});
 assert.equal(receipt.status,'committed');
 const preview=await s.courseRestore.preview({sessionId,atOperationId:'task-anchor',side:'after',unitIds:['KU-001'],userState:{layout:false,review:false}});
 await s.courseRestore.apply({sessionId,operationId:'task-recovery',preview});
 await assert.rejects(s.applyAgentMutation({...identity,input:{operationId:'late-new-group',basisId:context.basisId,conclusionOrMethodChanged:false,updates:[{blockId:A,text:'Must not return'}]}}),/会话|失效/);
 assert.deepEqual(await s.queryAgentMutation({...identity,operationId:'actual-group'}),receipt);
 await s.recordAgent({...identity,eventId:'old-finish',kind:'finish',status:'completed',threadId:'old-thread',turnId:'old-turn'});
 await s.recordAgent({...identity,eventId:'late-known-tool',kind:'tool',threadId:'old-thread',turnId:'old-turn',tool:{name:'yizhi_apply_group',input:{operationId:'actual-group'},output:receipt,references:[]}});
 const current=await s.open(d),view=await s.agent.get({sessionId:current.sessionId,conversationId:conversation.id});
 assert.equal(view.tasks[0].executorStatus,'completed');assert.equal(view.tasks[0].status,'stopped');
 assert.ok(view.tasks[0].groups!.some(g=>g.operationId===receipt.operationId));
 assert.ok(view.toolFacts.some(f=>f.name==='yizhi_apply_group'));assert.equal(view.toolFacts.find(f=>f.name==='yizhi_apply_group')!.hasRecoveryPayload,false);
 const continued=await s.agent.continue({sessionId:current.sessionId,taskId:task.id,operationId:'continue-in-new-generation'});
 assert.equal(continued.generation,2);assert.equal(continued.snapshot.target.revision,String(current.revision));assert.notEqual(continued.attemptId,task.attemptId);
}));
import { DatabaseSync } from 'node:sqlite';
test('a real final-history SQLite fault rolls back all units, epoch, drafts and task qualification before an exact successful retry',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId,other=await s.read(sessionId,'KU-002'),b=other.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
 await s.save({sessionId,operationId:'fault-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Old first'});
 await s.save({sessionId,operationId:'fault-new',inputSeq:2,baseRevision:2,blockId:A,text:'New first'});
 await s.commitEdit({sessionId,unitId:'KU-002',operationId:'fault-second',inputSeq:1,baseRevision:other.revision,complete:true,changes:[{blockId:b.id,text:'New second'}]});
 const draft={sessionId,unitId:'KU-002',inputSeq:2,baseRevision:2,complete:false,changes:[],formulaDrafts:[{blockId:b.id,latex:'\\frac{'}]};await s.saveDraft(draft);
 const conversation=await s.agent.create({sessionId,operationId:'fault-conversation'}),task=await s.agent.submit({sessionId,operationId:'fault-task',conversationId:conversation.id,generation:1,intent:'modify',text:'Work during restore',target:{unitId:'KU-001'}});
 const before=await s.read(sessionId),beforeB=await s.read(sessionId,'KU-002');
 const preview=await s.courseRestore.preview({sessionId,atOperationId:'fault-anchor',side:'after',unitIds:['KU-001','KU-002'],userState:{layout:false,review:false}});
 const fault=new DatabaseSync(join(d,'course.sqlite'));fault.exec("CREATE TRIGGER fail_course_recovery BEFORE INSERT ON cg_history WHEN NEW.operation_id='atomic-recovery' BEGIN SELECT RAISE(ABORT,'actual recovery write fault'); END");
 try{
  await assert.rejects(s.courseRestore.apply({sessionId,operationId:'atomic-recovery',preview}),/actual recovery write fault/);
  assert.deepEqual(await s.read(sessionId),before);assert.deepEqual(await s.read(sessionId,'KU-002'),beforeB);
  assert.equal((await s.agentTask({sessionId,taskId:task.id})).status,'running');
  assert.equal(await s.courseRestore.query({sessionId,operationId:'atomic-recovery'}),null);
  fault.exec('DROP TRIGGER fail_course_recovery');
  const result=await s.courseRestore.apply({sessionId,operationId:'atomic-recovery',preview});
  assert.equal(result.generation,2);assert.deepEqual(await s.courseRestore.apply({sessionId,operationId:'atomic-recovery',preview}),result);
  assert.deepEqual((await s.courseRestore.drafts({sessionId:result.sessionId}))[0].input,draft);
 }finally{fault.close();}
}));
import { writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
for(const boundary of ['beforeCommit','afterCommit'] as const)test(`SIGKILL at ${boundary} reopens as a whole course and original identity never applies twice`,async()=>fixture(async(s,d)=>{
 const {sessionId}=await s.open(d),other=await s.read(sessionId,'KU-002'),b=other.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
 await s.save({sessionId,operationId:'process-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Historical first'});
 await s.save({sessionId,operationId:'process-first',inputSeq:2,baseRevision:2,blockId:A,text:'Current first'});
 await s.commitEdit({sessionId,unitId:'KU-002',operationId:'process-second',inputSeq:1,baseRevision:1,complete:true,changes:[{blockId:b.id,text:'Current second'}]});
 const preview=await s.courseRestore.preview({sessionId,atOperationId:'process-anchor',side:'after',unitIds:['KU-001','KU-002'],userState:{layout:false,review:false}});
 const request={operationId:'process-recovery',preview},file=join(d,'restore-request.json');await writeFile(file,JSON.stringify(request));await s.close();
 const child=fork(resolve('dist/tests/course-restore-process.cjs'),[d,file,boundary],{stdio:['ignore','ignore','pipe','ipc'],env:process.env});
 let stderr='';child.stderr?.on('data',chunk=>{stderr+=chunk;});
 try{
  const reached=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Recovery boundary timeout '+stderr)),10000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Child exited before boundary '+stderr));});});
  assert.equal(reached.boundary,boundary,JSON.stringify(reached));const died=once(child,'exit');child.kill('SIGKILL');await died;
  const reopened=new CourseService(resolve('dist/worker.cjs'));
  try{
   const current=await reopened.open(d),isCommitted=boundary==='afterCommit';
   assert.equal(current.generation,isCommitted?2:1);
   assert.equal(current.unit.reading.blocks[0].payload.text,isCommitted?'Historical first':'Current first');
   assert.equal((await reopened.readUnit(current.sessionId,'KU-002')).reading.blocks.find(p=>p.id===b.id)!.payload.text,isCommitted?b.payload.text:'Current second');
   const receipt=await reopened.courseRestore.query({sessionId:reached.sessionId,operationId:request.operationId});assert.equal(!!receipt,isCommitted);
   const recovered=await reopened.courseRestore.apply({...request,sessionId:isCommitted?reached.sessionId:current.sessionId});
   assert.equal(recovered.generation,2);assert.deepEqual(await reopened.courseRestore.apply({...request,sessionId:current.sessionId}),recovered);
   assert.equal((await reopened.open(d)).generation,2);
  }finally{await reopened.close();}
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}));
import { parsingFixture } from './parsing-fixture';
async function until<T>(read:()=>Promise<T>,done:(v:T)=>boolean){for(let i=0;i<1000;i++){const v=await read();if(done(v))return v;await new Promise(r=>setTimeout(r,10));}throw new Error('Expected callback boundary was not reached');}
test('held real parser output and old experiment/extension callbacks cannot publish across recovery generation',async()=>{
 const d=await mkdtemp(join(tmpdir(),'yizhi-t22-callback-')),gate=new SharedArrayBuffer(8),s=new CourseService(resolve('dist/worker.cjs'),{parseScheduling:{pageIndex:1,beforeResult:gate}});
 try{
  const {sessionId}=await s.open(d);await s.save({sessionId,operationId:'callback-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Callback recovery anchor'});
  const pdf=join(d,'pages.pdf');await parsingFixture(pdf);const source=(await s.sources.importFile({sessionId,generation:1,operationId:'callback-source',path:pdf,title:'Keep source'})).version;
  const parsing=await s.parsing.start({sessionId,generation:1,operationId:'callback-parser',versionId:source.versionId});
  await until(async()=>Atomics.load(new Int32Array(gate),0),v=>v===1);
  const partial=await s.parsing.get({sessionId,taskId:parsing.taskId});assert.equal(partial.confirmed.length,1);
  let v=await s.experiments.open({sessionId,unitId:'KU-057',blockId:'RB-TH-13-057-010-interactive'});
  v=await s.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'callback-background',action:{kind:'background',enabled:true}});
  v=await s.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'callback-run',action:{kind:'run',running:true}});
  const extension=await s.extensions.open({sessionId});
  const preview=await s.courseRestore.preview({sessionId,atOperationId:'callback-anchor',side:'after',unitIds:['KU-001'],userState:{layout:false,review:false}});const restored=await s.courseRestore.apply({sessionId,operationId:'callback-recovery',preview}),sid=restored.sessionId;
  Atomics.store(new Int32Array(gate),1,1);Atomics.notify(new Int32Array(gate),1);
  const stopped=await until(()=>s.parsing.get({sessionId:sid,taskId:parsing.taskId}),t=>!!t.attempts[0].outputs?.some(o=>o.status==='rejected'));
  assert.equal(stopped.status,'stopped');assert.deepEqual(stopped.confirmed,partial.confirmed);
  const current=await s.experiments.open({sessionId:sid,unitId:v.unitId,blockId:v.blockId});assert.ok(current.generation>v.generation);assert.equal(current.running,false);
  await assert.rejects(s.experiments.act({sessionId:sid,instanceId:v.instanceId,generation:v.generation,operationId:'late-runtime-input',action:{kind:'inputs',inputs:v.state.inputs}}),/代际|失效/);
  const ext=await s.extensions.open({sessionId:sid});assert.notEqual(ext.instanceId,extension.instanceId);
  await assert.rejects(s.extensions.act({sessionId:sid,instanceId:extension.instanceId,generation:extension.generation,operationId:'late-extension',action:{kind:'visibility',visible:true}}),/代际|实例/);
  await new Promise(r=>setTimeout(r,550));assert.deepEqual((await s.experiments.read({sessionId:sid,instanceId:current.instanceId})).state,current.state);
  assert.ok((await s.sources.list({sessionId:sid})).versions.some(v=>v.versionId===source.versionId));
 }finally{Atomics.store(new Int32Array(gate),1,1);Atomics.notify(new Int32Array(gate),1);await s.close();await rm(d,{recursive:true,force:true});}
});
