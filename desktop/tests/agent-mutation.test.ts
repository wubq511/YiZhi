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
import { muxCopy, correction, muxId, correctFormula } from './agent-mutation-setup';
test('formula, finite experiment, necessary reviewed relation and local manual baseline roll back together on the final history write', async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-necessary-'));const core=new CourseService(resolve('dist/worker.cjs'));let fault:DatabaseSync|undefined;
  try{
    const {sessionId,citation,view}=await muxCopy(core,root), before=await core.readUnit(sessionId,'KU-057'), graph=await core.graph(sessionId);
    const command=await correction(core,sessionId,citation.id,'necessary-correction');
    fault=new DatabaseSync(join(root,'course.sqlite'));fault.exec("PRAGMA busy_timeout=5000; CREATE TRIGGER fail_necessary BEFORE INSERT ON cg_history BEGIN SELECT RAISE(ABORT,'final necessary group disk fault'); END");
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

test('explicit Agent capability commits real identities, keeps a stale second group waiting, and ordinary QA cannot acquire it',async()=>{
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
  assert.equal(done.status,'waiting');assert.deepEqual(done.groups.map((g:any)=>g.status),['committed','retained']);
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

test('public producer cannot bypass the necessary formula and experiment boundary with a plain payload replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-coupled-guard-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{const c=await core.open(root),unit=await core.readUnit(c.sessionId,'KU-057'),a=await core.commands.startAttempt({sessionId:c.sessionId,taskId:'cannot-bypass'}),basis=await core.commands.read({sessionId:c.sessionId,attemptId:a.attemptId,unitId:unit.id,objectIds:[muxId]}),next=structuredClone(basis.objects.find(o=>o.id===muxId)!.value);next.payload.config.selectBits=['S0','S1'];
 const result=await core.commands.commit({sessionId:c.sessionId,attemptId:a.attemptId,unitId:unit.id,operationId:'unbundled',basisId:basis.basisId,changes:[{objectId:muxId,value:next}]});assert.equal(result.status,'retained');assert.deepEqual(await core.readUnit(c.sessionId,unit.id),unit);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('add-to-board copies renew every hidden child identity and never acquire original personal annotations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-copy-identity-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root),sessionId=c.sessionId,p=c.unit.reading.blocks.find(b=>b.kind==='paragraph')!,example=c.unit.reading.blocks.find(b=>b.kind==='example'&&b.children?.length)!;
  const note=await core.annotations.create({sessionId,operationId:'source-note',text:'仅属于原段落',selection:{unitId:c.unit.id,fragments:[{blockId:p.id,block:p,field:'text',formalRevision:c.revision,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:p.payload.text},from:0,to:2,quote:Array.from(p.payload.text).slice(0,2).join('')}]}});
  const conv=await core.agent.create({sessionId,operationId:'conversation'}),task=await core.agent.submit({sessionId,conversationId:conv.id,operationId:'add',generation:1,intent:'add-to-board',text:'复制为补充材料',target:{unitId:c.unit.id}}),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1},basis=await core.readAgentMutation(identity);
  const receipt=await core.applyAgentMutation({...identity,input:{basisId:basis.basisId,operationId:'copy',conclusionOrMethodChanged:false,copies:[{blockId:example.id},{blockId:p.id}]}});assert.equal(receipt.status,'committed',receipt.reason);
  const after=(await core.read(sessionId)).unit,newBlocks=after.reading.blocks.filter(b=>!c.unit.reading.blocks.some(old=>old.id===b.id));assert.equal(newBlocks.length,2);
  const body=(b:any):any=>({kind:b.kind,payload:b.payload,...(b.children?{children:b.children.map(body)}:{})});assert.deepEqual(body(newBlocks[0]),body(example));
  const ids=(b:any):string[]=>[b.id,...(b.children??[]).flatMap(ids)];assert.ok(ids(newBlocks[0]).every(id=>!ids(example).includes(id)));assert.deepEqual(await core.annotations.list({sessionId}),[note]);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

for(const display of [true,false])test(`narrow Agent relation correction preserves reviewed identity and maps fixed citations; ${display?'equivalent display formula':'automatic linked formula'} is independently checked with experiment in one group`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-narrow-correction-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId,citation}=await muxCopy(core,root),conv=await core.agent.create({sessionId,operationId:'conversation'}),task=await core.agent.submit({sessionId,conversationId:conv.id,operationId:'modify',generation:1,intent:'modify',text:'纠正实际4:1副本',target:{unitId:'KU-057'},citationIds:[citation.id]});
  const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1},basis=await core.readAgentMutation(identity),old=(await core.graph(sessionId)).edges.find(e=>e.id==='REL-014')!;
  const result=await core.applyAgentMutation({...identity,input:{operationId:'necessary',basisId:basis.basisId,conclusionOrMethodChanged:true,updates:display?[{blockId:'mux-linked-formula',latex:'Z=\\overline{S_1}\\overline{S_0}I_0+\\overline{S_1}S_0I_1+S_1\\overline{S_0}I_2+S_1S_0I_3'}]:[],experiments:[{blockId:muxId,formulaBlockId:'mux-linked-formula',formula:correctFormula,sourceCitationId:citation.id,config:{selectBits:['S1','S0'],dataSignals:['I0','I1','I2','I3']}}],relations:{changes:[{id:'REL-014',value:'第一级S0选择组内通道，第二级S1选择分组，三个2:1构成4:1，索引2S1+S0。',citationIds:[citation.id]}]}} as any});
  assert.equal(result.status,'committed',result.reason);const edge=(await core.graph(sessionId)).edges.find(e=>e.id==='REL-014')!;
  assert.equal(edge.id,old.id);assert.equal(edge.fromUnitId,old.fromUnitId);assert.equal(edge.toUnitId,old.toUnitId);assert.equal(edge.type,old.type);assert.equal(edge.directed,old.directed);assert.deepEqual(edge.sourceRefs.map(r=>[r.sourceId,r.versionId,r.pdfPages]),[[citation.sourceId,citation.versionId,[citation.pdfPageIndex+1]]]);assert.equal(result.related!.definitions[0].proof.assignments,64);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a successful fresh necessary proposal clears a prior read/tool failure; later failures still remain separate pending facts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-fresh-mutation-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root),sessionId=c.sessionId,conv=await core.agent.create({sessionId,operationId:'conversation'}),task=await core.agent.submit({sessionId,conversationId:conv.id,operationId:'modify',generation:1,intent:'modify',text:'重读后修正',target:{unitId:c.unit.id}}),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1};
  await core.recordAgent({...identity,eventId:'read-error',kind:'tool',tool:{name:'yizhi_apply_group',input:{basisId:'expired'},output:{error:'修改依据已释放或无效，请重新读取'},references:[]}});
  const basis=await core.readAgentMutation(identity),block=c.unit.reading.blocks[0];
  assert.equal((await core.applyAgentMutation({...identity,input:{basisId:basis.basisId,operationId:'fresh',conclusionOrMethodChanged:false,updates:[{blockId:block.id,text:'新读取后正确保存的措辞。'}]}})).status,'committed');
  await core.recordAgent({...identity,eventId:'finish',kind:'finish',status:'completed'});const done=(await core.agent.get({sessionId,conversationId:conv.id})).tasks[0];assert.equal(done.status,'completed');assert.equal(done.error,null);assert.equal(done.executorStatus,'completed');assert.equal(done.toolErrors?.[0].error,'修改依据已释放或无效，请重新读取');
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
