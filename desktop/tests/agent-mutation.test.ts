import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('one producer patch removes a redundant paragraph and moves the original example without losing hidden children or personal context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-mutation-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    const before = structuredClone(c.unit), blocks = before.reading.blocks;
    const redundant = { id: 'redundant-copy', kind: 'paragraph', payload: { text: String(blocks[0].payload.text) } };
    await core.commitEdit({ sessionId, operationId: 'student-copy', inputSeq: 1, baseRevision: c.revision, complete: true, changes: [],
      patch: { updates: [], structure: { parentId: before.id, before: blocks.map(b => b.id), after: [blocks[0].id, redundant.id, ...blocks.slice(1).map(b => b.id)], inserted: [redundant] }, correspondence: [{ kind: 'copy', sourceId: blocks[0].id, targetId: redundant.id }] } });
    const current = await core.read(sessionId), example = current.unit.reading.blocks.find(b => b.kind === 'example')!;
    const attempt = await core.commands.startAttempt({ sessionId, taskId: 'real-structural-request' });
    const basis = await core.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds: [redundant.id, example.id, `structure:${before.id}`] });
    const quote=String(redundant.payload.text).slice(0,3);
    const note=await core.annotations.create({sessionId,operationId:'personal-context',text:'我的记录不能被精简删除',selection:{unitId:before.id,fragments:[{blockId:redundant.id,block:redundant,field:'text',formalRevision:current.revision,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:redundant.payload.text},from:0,to:Array.from(quote).length,quote}]}});
    const oldIds = current.unit.reading.blocks.map(b => b.id), ids = [example.id, ...oldIds.filter(id => id !== redundant.id && id !== example.id)];
    const result = await core.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId: 'remove-and-move', basisId: basis.basisId, changes: [],
      patch: { updates: [], structure: { parentId: before.id, before: oldIds, after: ids, inserted: [] }, correspondence: [{ kind: 'delete', sourceId: redundant.id, targetId: redundant.id }, { kind: 'move', sourceId: example.id, targetId: example.id }] } } as any);
    assert.equal(result.status, 'committed', result.reason);
    const saved = await core.read(sessionId);
    assert.deepEqual(saved.unit.reading.blocks.map(b => b.id), ids);
    assert.deepEqual(saved.unit.reading.blocks[0], example);
    const notes=await core.annotations.list({sessionId});assert.equal(notes.length,1);assert.equal(notes[0].current.status,'orphan');assert.deepEqual(notes[0].original,note.original);assert.equal(notes[0].text,note.text);
    assert.deepEqual(saved.unit.reading.blocks.filter(b => b.kind === 'exercise'), blocks.filter(b => b.kind === 'exercise'));
    assert.deepEqual(await core.commands.query({ sessionId, operationId: result.operationId }), result);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('producer reads and commits one identified B beyond KU-001 through the same versioned command boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-mutation-unit-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId, unit = await core.readUnit(sessionId, 'KU-057');
    const block = unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const a = await core.commands.startAttempt({ sessionId, taskId: 'mux-correction' });
    const basis = await core.commands.read({ sessionId, attemptId: a.attemptId, unitId: unit.id, objectIds: [block.id] });
    const result = await core.commands.commit({ sessionId, attemptId: a.attemptId, operationId: 'mux-wording', basisId: basis.basisId, unitId: unit.id, changes: [],
      patch: { updates: [{ blockId: block.id, before: block.payload, after: { ...block.payload, text: '4:1 MUX 使用两位选择码，按二进制通道下标选通。' } }], correspondence: [] } });
    assert.equal(result.status, 'committed', result.reason);
    assert.equal((await core.readUnit(sessionId, 'KU-057')).reading.blocks[0].payload.text, '4:1 MUX 使用两位选择码，按二进制通道下标选通。');
    assert.deepEqual((await core.read(sessionId)).unit, c.unit);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

import { DatabaseSync } from 'node:sqlite';
import { sourceFixture } from './source-fixture';
const muxId = 'RB-TH-13-057-010-interactive';
const correctFormula = 'Z=¬S1·¬S0·I0+¬S1·S0·I1+S1·¬S0·I2+S1·S0·I3';
async function muxCopy(core: CourseService, root: string, incomplete = false) {
  const opened = await core.open(root), sessionId = opened.sessionId, unit = await core.readUnit(sessionId,'KU-057');
  const a = await core.commands.startAttempt({sessionId,taskId:'explicitly-erroneous-copy'});
  const basis = await core.commands.read({sessionId,attemptId:a.attemptId,unitId:unit.id,objectIds:unit.reading.blocks.map(b=>b.id)});
  const block = unit.reading.blocks.find(b=>b.id===muxId)!;
  const bad = structuredClone(block); bad.payload.config.selectBits=['S0','S1']; bad.payload.necessaryRelationIds=['REL-014'];
  if(incomplete){ delete bad.payload.inputs.I3; bad.payload.config.dataSignals=['I0','I1','I2','0']; }
  const f = {id:'mux-linked-formula',kind:'formula',payload:{latex:'Z=0',experimentBlockId:muxId}};
  assert.equal((await core.commands.commit({sessionId,unitId:unit.id,attemptId:a.attemptId,operationId:'prepare-copy',basisId:basis.basisId,
    changes:[{objectId:muxId,value:bad}],patch:{updates:[],structure:{parentId:unit.id,before:unit.reading.blocks.map(b=>b.id),after:[f.id,...unit.reading.blocks.map(b=>b.id)],inserted:[f]},correspondence:[]}})).status,'committed');
  const rb = await core.relations.read({sessionId}); const edge=rb.graph.edges.find(e=>e.id==='REL-014')!;
  await core.relations.commit({sessionId,generation:rb.generation,basisId:rb.basisId,operationId:'explicit-bad-relation-copy',changes:[{id:edge.id,value:{...edge,value:'此副本错误地宣称S0为高位，交换01与10通道。'}}]});
  const path=join(root,'source.pdf'); await sourceFixture(path,'MUX selector evidence: S1 is high, S0 is low. 00:I0 01:I1 10:I2 11:I3');
  const source=await core.sources.importFile({sessionId,generation:1,operationId:'source',path,title:'Regression evidence, not actual-executor acceptance'});
  const page=await core.sources.page({sessionId,versionId:source.version.versionId,pdfPageIndex:0});
  const citation=await core.sources.cite({sessionId,generation:1,operationId:'cite',versionId:source.version.versionId,pdfPageIndex:0,projectionId:page.projection.id,start:0,end:Array.from(page.projection.text).length,target:{unitId:'KU-057',blockId:muxId}});
  await core.setReviewStatus(sessionId,'KU-057','mastered');
  const view=await core.experiments.open({sessionId,unitId:'KU-057',blockId:muxId});
  return {sessionId,citation,view};
}
async function correction(core: CourseService, sessionId:string, citationId:string, operationId:string) {
  const unit=await core.readUnit(sessionId,'KU-057'), a=await core.commands.startAttempt({sessionId,taskId:operationId});
  const basis=await core.commands.read({sessionId,unitId:unit.id,attemptId:a.attemptId,objectIds:unit.reading.blocks.map(b=>b.id),context:true});
  const b=unit.reading.blocks.find(b=>b.id===muxId)!, next=structuredClone(b);
  next.payload.config.selectBits=['S1','S0']; next.payload.config.dataSignals=['I0','I1','I2','I3']; next.payload.inputs.I3=0;
  const edge=basis.context!.relations.graph.edges.find(e=>e.id==='REL-014')!;
  return { sessionId,unitId:unit.id,attemptId:a.attemptId,operationId,basisId:basis.basisId,changes:[{objectId:muxId,value:next}],
    patch:{updates:[{blockId:'mux-linked-formula',before:unit.reading.blocks[0].payload,after:{...unit.reading.blocks[0].payload,latex:correctFormula}}],correspondence:[]},
    semanticImpact:{version:1 as const,unitId:unit.id,conclusionOrMethodChanged:true},
    bundle:{layout:basis.context!.layout.map(n=>({unitId:n.unitId,x:n.x+20,y:n.y+40,width:n.width})),relations:{changes:[{id:edge.id,value:{...edge,value:'组内由低位S0选择，组间由高位S1选择，三个2:1构成4:1，通道按2S1+S0编号。'}}]},
      experiments:[{blockId:muxId,formula:correctFormula,formulaBlockId:'mux-linked-formula',sourceCitationId:citationId}]} };
}
test('formula, finite experiment, necessary reviewed relation and local manual baseline roll back together on the final history write', async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-necessary-'));const core=new CourseService(resolve('dist/worker.cjs'));let fault:DatabaseSync|undefined;
  try{
    const {sessionId,citation,view}=await muxCopy(core,root), before=await core.readUnit(sessionId,'KU-057'), graph=await core.graph(sessionId);
    const command=await correction(core,sessionId,citation.id,'necessary-correction');
    fault=new DatabaseSync(join(root,'course.sqlite'));fault.exec("CREATE TRIGGER fail_necessary BEFORE INSERT ON cg_history BEGIN SELECT RAISE(ABORT,'final necessary group disk fault'); END");
    const failed=await core.commands.commit(command);assert.equal(failed.status,'retained');assert.match(failed.reason!,/final necessary group disk fault/);
    assert.deepEqual(await core.readUnit(sessionId,'KU-057'),before);assert.deepEqual(await core.graph(sessionId),graph);
    assert.deepEqual(await core.experiments.read({sessionId,instanceId:view.instanceId}),view);
    assert.equal((await core.reviewStates(sessionId)).prompts.length,0);
    fault.exec('DROP TRIGGER fail_necessary');
    const success=await core.commands.commit(await correction(core,sessionId,citation.id,'fresh-correction'));
    assert.equal(success.status,'committed',success.reason);assert.equal(success.related!.definitions[0].proof.assignments,64);
    assert.equal(success.related!.relation!.domain,'formal-relation');assert.equal(success.related!.layoutUnitIds.length,3);
    assert.equal((await core.reviewStates(sessionId)).units['KU-057'].status,'mastered');assert.equal((await core.reviewStates(sessionId)).prompts.length,1);
    const pending=await core.experiments.read({sessionId,instanceId:view.instanceId});assert.equal(pending.definition.revision,view.definition.revision);assert.ok(pending.pendingDefinition);
    const migrated=await core.experiments.act({sessionId,instanceId:view.instanceId,generation:pending.generation,operationId:'migrate',action:{kind:'migrate',baseVersion:pending.version}});
    assert.equal(migrated.definition.revision,success.related!.definitions[0].revision);assert.deepEqual(migrated.state,view.state);
  }finally{fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('explicit Agent capability commits real identities, retains a stale second group as partial, and ordinary QA cannot acquire it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-agent-capability-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root),sessionId=c.sessionId,conversation=await core.agent.create({sessionId,operationId:'conversation'});
  const qa=await core.agent.submit({sessionId,conversationId:conversation.id,operationId:'qa',generation:1,text:'只解释',target:{unitId:'KU-001'}});
  const identity=(t:any)=>({sessionId,taskId:t.id,attemptId:t.attemptId,generation:t.generation});
  await assert.rejects((core as any).readAgentMutation(identity(qa)),/明确修改/);
  await core.recordAgent({...identity(qa),eventId:'qa-finish',kind:'finish',status:'completed'});
  const task=await core.agent.submit({sessionId,conversationId:conversation.id,operationId:'modify',generation:1,text:'精简并移动例题',target:{unitId:'KU-001'},intent:'modify'} as any);
  const basis=await (core as any).readAgentMutation(identity(task));
  const secondBasis=await (core as any).readAgentMutation(identity(task));
  const paragraph=c.unit.reading.blocks.find(b=>b.kind==='paragraph')!,example=c.unit.reading.blocks.find(b=>b.kind==='example')!;
  const input={operationId:'group1',basisId:basis.basisId,updates:[{blockId:paragraph.id,text:'位置记数法以数码、基数和位权描述数值。'}],moves:[{blockId:example.id,beforeId:paragraph.id}],conclusionOrMethodChanged:false};
  const first=await (core as any).applyAgentMutation({...identity(task),input});assert.equal(first.status,'committed',first.reason);
  assert.deepEqual(await (core as any).applyAgentMutation({...identity(task),input}),first);
  const second=await (core as any).applyAgentMutation({...identity(task),input:{...input,basisId:secondBasis.basisId,operationId:'group2'}});assert.equal(second.status,'retained');
  await core.recordAgent({...identity(task),eventId:'finish',kind:'finish',status:'completed'});
  let view=await core.agent.get({sessionId,conversationId:conversation.id});const done=view.tasks.at(-1)! as any;
  assert.equal(done.status,'partial');assert.deepEqual(done.groups.map((g:any)=>g.status),['committed','retained']);
  assert.deepEqual((await core.read(sessionId)).unit.reading.blocks[0],example);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(root);
  view=await core.agent.get({sessionId:reopened.sessionId,conversationId:conversation.id});assert.equal(view.tasks.at(-1)!.status,'partial');
  assert.deepEqual((await core.read(reopened.sessionId)).unit.reading.blocks[0],example);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

for(const incomplete of [false,true])test(`pending experiment ${incomplete?'incompatible':'compatible'} definition respects gestures, stale migration input, durable old scene and explicit restart`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-migrate-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId,citation,view}=await muxCopy(core,root,incomplete);
  let v=await core.experiments.act({sessionId,instanceId:view.instanceId,generation:view.generation,operationId:'drag-begin',action:{kind:'gesture',active:true}});
  const result=await core.commands.commit(await correction(core,sessionId,citation.id,'new-formal'));assert.equal(result.status,'committed',result.reason);
  v=await core.experiments.read({sessionId,instanceId:view.instanceId});assert.equal(v.gesture,true);const token=v.version;
  await assert.rejects(core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'early',action:{kind:'migrate',baseVersion:token}}),/操作结束/);
  v=await core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'new-input',action:{kind:'inputs',inputs:{...v.state.inputs,S0:1}}});
  v=await core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'drag-end',action:{kind:'gesture',active:false}});
  await assert.rejects(core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'obsolete',action:{kind:'migrate',baseVersion:token}}),/现场已变化/);
  const scene=structuredClone(v.state);
  v=await core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'migrate-now',action:{kind:'migrate',baseVersion:v.version}});
  assert.deepEqual(v.state,scene);
  if(incomplete){assert.ok(v.migrationError);assert.equal(v.definition.revision,view.definition.revision);assert.ok(v.pendingDefinition);}
  else{assert.equal(v.pendingDefinition,undefined);assert.equal(v.definition.revision,result.related!.definitions[0].revision);}
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(root);
  v=await core.experiments.open({sessionId:reopened.sessionId,unitId:'KU-057',blockId:muxId});assert.deepEqual(v.state,scene);
  if(incomplete){assert.ok(v.pendingDefinition);v=await core.experiments.act({sessionId:reopened.sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'explicit-restart',action:{kind:'restart',baseVersion:v.version}});assert.equal(v.pendingDefinition,undefined);assert.equal(v.state.inputs.I3,0);assert.equal(v.state.inputs.S0,0);}
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('missing necessary relation, invalid finite formula and layout A-to-B-to-A each retain the whole candidate',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-mutation-fences-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId,citation}=await muxCopy(core,root),before=await core.readUnit(sessionId,'KU-057');
  let command=await correction(core,sessionId,citation.id,'missing-relation');delete (command.bundle as any).relations;
  assert.match((await core.commands.commit(command)).reason!,/正式关系/);
  command=await correction(core,sessionId,citation.id,'invalid-finite');command.bundle.experiments[0].formula='Z=0';
  assert.equal((await core.commands.commit(command)).status,'retained');
  command=await correction(core,sessionId,citation.id,'layout-aba');const graph=await core.graph(sessionId),p=graph.layout.nodes.find(n=>n.unitId==='KU-057')!;
  await core.setLayout(sessionId,[{unitId:p.unitId,x:p.x+10,y:p.y,width:p.width}]);await core.setLayout(sessionId,[{unitId:p.unitId,x:p.x,y:p.y,width:p.width}]);
  assert.match((await core.commands.commit(command)).reason!,/布局基线/);
  assert.deepEqual(await core.readUnit(sessionId,'KU-057'),before);assert.equal((await core.reviewStates(sessionId)).prompts.length,0);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
