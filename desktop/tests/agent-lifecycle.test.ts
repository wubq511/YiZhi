import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { DatabaseSync } from 'node:sqlite';

test('stop revokes the shared commit gate before executor acknowledgement; original receipts remain facts and explicit continue reads fresh content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-lifecycle-')), core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    const conversation = await core.agent.create({ sessionId, operationId: 'c' });
    const task = await core.agent.submit({ sessionId, conversationId: conversation.id, operationId: 'q', generation: 1, intent: 'modify', text: '改写第一段，再整理', target: {unitId:'KU-001'} });
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1 };
    await core.recordAgent({...identity,eventId:'bind',kind:'bind',threadId:'original-thread',turnId:'original-turn'});
    const basis = await core.readAgentMutation(identity);
    const paragraph = c.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
    const input = { operationId:'group-one',basisId:basis.basisId,conclusionOrMethodChanged:false,updates:[{blockId:paragraph.id,text:'已完成的真实组'}] };
    const receipt = await core.applyAgentMutation({...identity,input});
    assert.equal(receipt.status,'committed');
    const stopping = await core.agent.stop({sessionId,taskId:task.id});
    assert.equal(stopping.status,'stopping');
    await assert.rejects(core.activeAgent(identity),/停止|失效/);
    await assert.rejects(core.applyAgentMutation({...identity,input:{...input,operationId:'after-stop'}}),/停止|失效/);
    assert.deepEqual(await core.queryAgentMutation({...identity,operationId:'group-one'}),receipt);
    await core.recordAgent({...identity,eventId:'interrupted',kind:'finish',threadId:'original-thread',turnId:'original-turn',status:'interrupted'});
    const stopped=(await core.agent.get({sessionId,conversationId:conversation.id})).tasks[0];
    assert.equal(stopped.status,'stopped');assert.equal(stopped.executorStatus,'interrupted');assert.equal(stopped.groups?.length,1);
    const next=await core.agent.continue({sessionId,taskId:task.id,operationId:'continue-one'});
    assert.notEqual(next.id,task.id);assert.notEqual(next.attemptId,task.attemptId);assert.equal(next.continuesTaskId,task.id);
    assert.notEqual(next.snapshot.target.revision,task.snapshot.target.revision);
    assert.deepEqual(await core.agent.continue({sessionId,taskId:task.id,operationId:'continue-one'}),next);
    assert.equal((await core.commands.history({sessionId})).length,1);
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});

test('executor receipts repair failed local task linkage without losing actual completed text or repeating a turn', async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-receipt-repair-')),core=new CourseService(resolve('dist/worker.cjs'));
  let fault:DatabaseSync|undefined;
  try {
    const {sessionId}=await core.open(root),c=await core.agent.create({sessionId,operationId:'c'});
    const task=await core.agent.submit({sessionId,conversationId:c.id,operationId:'q',generation:1,text:'问题',target:{unitId:'KU-001'}});
    const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1};
    await core.recordAgent({...identity,eventId:'bind',kind:'bind',threadId:'real-thread',turnId:'real-turn'});
    fault=new DatabaseSync(join(root,'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_link BEFORE UPDATE ON agent_tasks BEGIN SELECT RAISE(ABORT,'task link fault'); END");
    await assert.rejects(core.recordAgent({...identity,eventId:'actual-message',kind:'message',threadId:'real-thread',turnId:'real-turn',itemId:'answer',text:'已收到的真实完整消息'}),/task link fault/);
    await assert.rejects(core.recordAgent({...identity,eventId:'actual-finish',kind:'finish',threadId:'real-thread',turnId:'real-turn',status:'completed'}),/task link fault/);
    fault.exec('DROP TRIGGER fail_link');
    const repaired=await core.agent.get({sessionId,conversationId:c.id});
    assert.equal(repaired.tasks[0].executorStatus,'completed');assert.equal(repaired.tasks[0].status,'completed');
    assert.deepEqual(repaired.messages.map(m=>m.text),['问题','已收到的真实完整消息']);
    assert.equal(repaired.messages[1].state,'complete');
    await core.recordAgent({...identity,eventId:'actual-finish',kind:'finish',threadId:'real-thread',turnId:'real-turn',status:'completed'});
    assert.equal((await core.agent.get({sessionId,conversationId:c.id})).messages.length,2);
  } finally {fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});

import { AgentRuntime } from '../src/agent/executor';
import { chmod } from 'node:fs/promises';
async function until<T>(read:()=>Promise<T>,accept:(v:T)=>boolean) {for(let n=0;n<200;n++){const v=await read();if(accept(v))return v;await new Promise(r=>setTimeout(r,20));}throw new Error('lifecycle timeout');}
test('host stop acknowledges a revoked attempt, reconciles the original turn and continues only as a distinct fresh attempt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-runtime-lifecycle-')),core=new CourseService(resolve('dist/worker.cjs'));
 const cliPath=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(cliPath,0o755);
 const runtime=new AgentRuntime(core,{cliPath,directory:join(root,'runtime'),env:{...process.env,YIZHI_FIXTURE_MODE:'linger'}});
 try {
  const {sessionId}=await core.open(join(root,'course')),c=await core.agent.create({sessionId,operationId:'c'});
  const t=await runtime.submit({sessionId,conversationId:c.id,operationId:'q',generation:1,text:'问题',target:{unitId:'KU-001'}});
  await until(()=>core.agentTask({sessionId,taskId:t.id}),t=>!!t.turnId);
  const stopping=await runtime.stop({sessionId,taskId:t.id});assert.equal(stopping.status,'stopping');
  const done=await until(()=>core.agentTask({sessionId,taskId:t.id}),t=>t.status==='stopped');assert.equal(done.executorStatus,'interrupted');
  const checked=await runtime.reconcile({sessionId,taskId:t.id});assert.equal(checked.recovery?.state,'resolved');
  const next=await runtime.continue({sessionId,taskId:t.id,operationId:'resume'});assert.notEqual(next.attemptId,t.attemptId);
  await runtime.prepareQuit();await assert.rejects(runtime.submit({sessionId,conversationId:c.id,operationId:'no-new',generation:1,text:'拒绝',target:{unitId:'KU-001'}}),/退出/);
 } finally {await runtime.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('abnormal view loss releases only temporary input protection and reopening distinguishes unconfirmed tail from confirmed durable drafts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-view-recovery-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try {
  const c=await core.open(root),sessionId=c.sessionId;
  const first=await core.openLearningView({sessionId,viewId:'view-one'});assert.equal(first.unconfirmedTail,false);
  await core.saveDraft({sessionId,inputSeq:1,baseRevision:1,changes:[{blockId:c.editableBlockId,text:'持久但未完成的输入'}],complete:false});
  await core.releaseLearningView({sessionId,viewId:'view-one',saved:false});
  const reopened=await core.openLearningView({sessionId,viewId:'view-two'});assert.equal(reopened.unconfirmedTail,true);
  assert.ok((await core.read(sessionId)).drafts.length);
  await core.confirmLearningView({sessionId,viewId:'view-two'});
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));
  const next=await core.open(root),fresh=await core.openLearningView({sessionId:next.sessionId,viewId:'view-three'});
  assert.equal(fresh.unconfirmedTail,false);assert.ok((await core.read(next.sessionId)).drafts.length);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

for(const mode of ['reconcile-completed','reconcile-missing'])test(`original turn ${mode} is reconciled without another turn or fabricated recovery`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-reconcile-')),core=new CourseService(resolve('dist/worker.cjs'));
 const runtime=new AgentRuntime(core,{cliPath:resolve('dist/tests/agent-executor-fixture.cjs'),directory:join(root,'runtime'),env:{...process.env,YIZHI_FIXTURE_MODE:mode}});
 try {
  const {sessionId}=await core.open(join(root,'course')),c=await core.agent.create({sessionId,operationId:'c'});
  const task=await runtime.submit({sessionId,conversationId:c.id,operationId:'q',generation:1,text:'问题',target:{unitId:'KU-001'}});
  await until(()=>core.agent.get({sessionId,conversationId:c.id}),v=>v.messages.some(m=>m.role==='assistant'));
  await new Promise(r=>setTimeout(r,850));
  if(mode==='reconcile-missing')await runtime.stop({sessionId,taskId:task.id});
  const checked=await runtime.reconcile({sessionId,taskId:task.id});
  if(mode==='reconcile-completed'){assert.equal(checked.status,'completed');assert.equal(checked.recovery?.state,'resolved');const v=await core.agent.get({sessionId,conversationId:c.id});assert.match(v.messages[1].text,/补充解释/);assert.equal(v.messages[1].state,'complete');}
  else assert.equal(checked.recovery?.state,'resolved'); // local real terminal receipt outranks unavailable external metadata
  const v=await core.agent.get({sessionId,conversationId:c.id});assert.equal(v.tasks.length,1);assert.equal(v.tasks[0].turnId,'fixture-turn-1');
 }finally{await runtime.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('a confirmed window unfreezes back to active and a later process loss cannot keep its old saved marker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-unfreeze-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try {
  const {sessionId}=await core.open(root);await core.openLearningView({sessionId,viewId:'same-window'});
  await core.confirmLearningView({sessionId,viewId:'same-window'});
  await core.openLearningView({sessionId,viewId:'same-window'}); // another window failed its quit barrier
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));
  const next=await core.open(root),view=await core.openLearningView({sessionId:next.sessionId,viewId:'reopened'});
  assert.equal(view.unconfirmedTail,true);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('unverifiable original turn is unknown, revokes writes, then accepts only late original facts without a replacement turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-unknown-')),core=new CourseService(resolve('dist/worker.cjs'));
 const runtime=new AgentRuntime(core,{cliPath:resolve('dist/tests/agent-executor-fixture.cjs'),directory:join(root,'runtime'),env:{...process.env,YIZHI_FIXTURE_MODE:'reconcile-unavailable'}});
 try {
  const {sessionId}=await core.open(join(root,'course')),c=await core.agent.create({sessionId,operationId:'c'});
  const task=await runtime.submit({sessionId,conversationId:c.id,operationId:'q',generation:1,text:'问题',target:{unitId:'KU-001'}});
  await until(()=>core.agent.get({sessionId,conversationId:c.id}),v=>v.messages.some(m=>m.role==='assistant'));
  const checked=await runtime.reconcile({sessionId,taskId:task.id});assert.equal(checked.status,'unknown');assert.equal(checked.recovery?.state,'unknown');
  await assert.rejects(core.activeAgent({sessionId,taskId:task.id,attemptId:task.attemptId,generation:1}),/停止|失效/);
  const done=await until(()=>core.agentTask({sessionId,taskId:task.id}),t=>t.executorStatus==='completed');assert.equal(done.turnId,checked.turnId);
  const v=await core.agent.get({sessionId,conversationId:c.id});assert.equal(v.tasks.length,1);assert.equal(v.messages.length,2);assert.equal(v.messages[1].state,'complete');
 }finally{await runtime.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('a failed local stop projection cannot restore submission qualification and the durable stop receipt repairs after storage recovers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-stop-fault-')),core=new CourseService(resolve('dist/worker.cjs'));let fault:DatabaseSync|undefined;
 try {
  const {sessionId}=await core.open(root),c=await core.agent.create({sessionId,operationId:'c'}),t=await core.agent.submit({sessionId,conversationId:c.id,operationId:'q',generation:1,text:'问题',target:{unitId:'KU-001'}});
  fault=new DatabaseSync(join(root,'course.sqlite'));fault.exec("CREATE TRIGGER fail_stop_projection BEFORE UPDATE ON agent_tasks BEGIN SELECT RAISE(ABORT,'stop projection fault'); END");
  await assert.rejects(core.agent.stop({sessionId,taskId:t.id}),/stop projection fault/);
  await assert.rejects(core.activeAgent({sessionId,taskId:t.id,attemptId:t.attemptId,generation:1}),/停止|失效/);
  fault.exec('DROP TRIGGER fail_stop_projection');const repaired=await core.agentTask({sessionId,taskId:t.id});assert.equal(repaired.status,'stopping');assert.equal(repaired.stopRequested,true);
 }finally{fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('recovering course A renderer leaves course B active experiment identity and confirmation token valid',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-course-recover-')),core=new CourseService(resolve('dist/worker.cjs'));
 try {
  const a=await core.open(join(root,'a')),b=await core.open(join(root,'b'));
  async function active(sessionId:string){let v=await core.extensions.open({sessionId});for(const action of [{kind:'validate',version:'1.0.0',report:{outputs:'01101001',lifecycle:true,migration:true}},{kind:'visibility',visible:true},{kind:'run',running:true}] as any[]){v=await core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action});}return v;}
  const av=await active(a.sessionId),bv=await active(b.sessionId);
  const builtin=await core.experiments.open({sessionId:b.sessionId,unitId:'KU-057',blockId:'RB-TH-13-057-010-interactive'});
  const beforeBuiltin=await core.experiments.act({sessionId:b.sessionId,instanceId:builtin.instanceId,generation:builtin.generation,operationId:'b-input',action:{kind:'inputs',inputs:{...builtin.state.inputs,I0:1}}});
  await core.recoverExtensionRenderers(a.sessionId);
  assert.deepEqual(await core.extensions.read({sessionId:b.sessionId}),bv);
  assert.deepEqual(await core.experiments.read({sessionId:b.sessionId,instanceId:builtin.instanceId}),beforeBuiltin);
  const result=await core.extensions.act({sessionId:b.sessionId,instanceId:bv.instanceId,generation:bv.generation,operationId:'b-still-valid',action:{kind:'confirm',mode:'step',baseRevision:bv.revision,definitionVersion:'1.0.0',state:{...bv.state,step:1,simulationTime:250}}});
  assert.equal(result.state.step,1);
  await assert.rejects(core.extensions.act({sessionId:a.sessionId,instanceId:av.instanceId,generation:av.generation,operationId:'a-late',action:{kind:'run',running:true}}),/实例|代际/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

import { DescriptionRuntime } from '../src/agent/description-search';
import { readdir,readFile } from 'node:fs/promises';
test('quit blocks description admission and drains an already started catalog child before removing its runtime',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-catalog-drain-')),core=new CourseService(resolve('dist/worker.cjs')),directory=join(root,'runtime'),marker=join(root,'catalog-started');
 const cliPath=resolve('dist/tests/description-executor-fixture.cjs');await chmod(cliPath,0o755);
 const runtime=new DescriptionRuntime(core,{cliPath,directory,env:{...process.env,YIZHI_DESCRIPTION_FIXTURE:'catalog-linger',YIZHI_CATALOG_MARKER:marker}});
 try {
  const {sessionId}=await core.open(join(root,'course')),catalog=runtime.status();
  await until(()=>readFile(marker,'utf8').catch(()=>''),s=>!!s);
  runtime.prepareQuit();await assert.rejects(runtime.start({sessionId,id:'no-new',description:'不得接纳',scopes:['knowledge']}),/退出/);
  assert.equal((await runtime.status()).available,false);
  await runtime.close();await catalog;assert.deepEqual(await readdir(directory),[]);
 }finally{await runtime.close();await core.close();await rm(root,{recursive:true,force:true});}
});

import { sourceFixture } from './source-fixture';
test('Core shutdown drains admitted asynchronous source indexing and query before closing course databases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-index-drain-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try {
  let c=await core.open(join(root,'course'));const path=join(root,'source.pdf');await sourceFixture(path,'Read drain evidence');
  await core.sources.importFile({sessionId:c.sessionId,operationId:'source',generation:1,path,title:'关闭排空验证'});
  const indexing=core.search.rebuild({sessionId:c.sessionId,batchSize:8});
  const query=core.search.query({sessionId:c.sessionId,query:'drain',scopes:['sources']});
  const closing=core.close();const [status,results]=await Promise.all([indexing,query]);await closing;
  assert.ok(status.indexed>0);assert.ok(results.hits.length>0);
  core=new CourseService(resolve('dist/worker.cjs'));c=await core.open(join(root,'course'));
  assert.ok((await core.search.query({sessionId:c.sessionId,query:'drain',scopes:['sources']})).hits.length);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
