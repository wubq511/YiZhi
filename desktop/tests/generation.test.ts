import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { CourseService } from '../src/core/course-service';

import {tablePdf,prepared,lesson,practice} from './generation-fixture';

test('invalid finite formula stays a recoverable candidate and never registers an invisible unit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-generation-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId, task, opened,conversation } = await prepared(core, root);
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: task.generation };
    const basis = await core.readAgentGeneration(identity);
    const originalGraph = await core.graph(sessionId);
    const input = { ...lesson(basis,'wrong-formula'), formula:'Z=I0+I1+I2+I3' };
    const result = await core.publishAgentGeneration({ ...identity, input });
    assert.equal(result.status, 'retained'); assert.match(result.reason!, /64|公式/);
    assert.equal(result.checks.find(c => c.layer === 'structure')?.status, 'passed');
    assert.equal(result.checks.find(c => c.layer === 'finite')?.status, 'failed');
    assert.deepEqual(await core.graph(sessionId), originalGraph);
    await assert.rejects(core.readUnit(sessionId, 'KU-GEN-MUX-01'), /不存在/);
    assert.deepEqual((await core.read(sessionId)).unit, opened.unit);
    assert.equal((await core.generationCandidates({ sessionId, taskId: task.id })).length, 1);
    const corrected=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:lesson(corrected,'corrected-lesson')})).status,'committed');
    assert.deepEqual((await core.readAgentGeneration(identity)).pendingStages,['practice']);
    assert.equal((await core.generationCandidates({sessionId,taskId:task.id})).length,0,'superseded failure is no longer pending');
    const pending=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:practice(pending,'corrected-practice')})).status,'committed');
    await core.recordAgent({...identity,eventId:'actual-finish-after-correction',kind:'finish',status:'completed'});
    const final=await core.agent.get({sessionId,conversationId:conversation.id});
    assert.equal(final.tasks[0].status,'completed');
    assert.deepEqual(final.tasks[0].generationProgress?.pendingStages,[]);
    assert.equal((await core.queryAgentGeneration({...identity,operationId:'wrong-formula'}))?.status,'retained');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('claim evidence accepts actual table cells and rejects unrelated page text',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-evidence-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root);
    const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const basis=await core.readAgentGeneration(identity);
    const firstRow=basis.sourceTable[0].evidenceIds[0];
    assert.ok(!Object.values(basis.evidenceIds).flat().includes(firstRow));
    const supported=lesson(basis,'table-cell-evidence');
    supported.evidence={...supported.evidence,exercise:[...supported.evidence.exercise,firstRow]};
    const valid=await core.publishAgentGeneration({...identity,input:supported});
    assert.equal(valid.status,'committed',valid.reason);
    const next=await core.readAgentGeneration(identity);
    const unrelated=next.sourceText.find(item=>!next.sourceTable.some(row=>row.evidenceIds.includes(item.id)) &&
      !Object.values(next.evidenceIds).flat().includes(item.id));
    assert.ok(unrelated);
    const invalid=practice(next,'unrelated-page-text');
    invalid.evidence.exercise=[...invalid.evidence.exercise,unrelated.id];
    const result=await core.publishAgentGeneration({...identity,input:invalid});
    assert.equal(result.status,'retained');
    assert.equal(result.checks.find(check=>check.layer==='reference')?.status,'failed');
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('complete lesson publishes one graph-owned unit, stop and explicit continue add only remaining practice', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-continue-'));
  let core=new CourseService(resolve('dist/worker.cjs'));
  try {
    const {sessionId,task,conversation,opened}=await prepared(core,root);
    const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const basis=await core.readAgentGeneration(identity);
    const first=await core.publishAgentGeneration({...identity,input:lesson(basis,'complete-lesson')});
    assert.equal(first.status,'committed',first.reason);
    assert.equal(first.checks.filter(c=>c.status==='passed').length,7);
    const graph=await core.graph(sessionId);
    assert.equal(graph.nodes.filter(n=>n.id===basis.spec.unitId).length,1);
    assert.equal(graph.groups.filter(g=>g.id===basis.spec.themeId).length,1);
    const unit=await core.readUnit(sessionId,basis.spec.unitId);
    assert.deepEqual(unit.reading.blocks.map(b=>b.kind),['paragraph','formula','paragraph','table','example','exercise']);
    for(const block of unit.reading.blocks){
      const ref=(block.sourceRefs as Array<{sourceId:string;versionId:string;artifactId:string;artifactDigest:string;evidenceTextIds:string[];region:{x0:number;y0:number;x1:number;y1:number}}>)[0];
      assert.equal(ref.versionId,basis.source.versionId);
      assert.equal(ref.artifactId,basis.artifact.artifactId);
      assert.equal(ref.artifactDigest,basis.artifact.digest);
      assert.ok(ref.evidenceTextIds.length>0);
      assert.ok(ref.evidenceTextIds.every(id=>basis.sourceText.some(item=>item.id===id)));
      assert.ok(ref.region.x0<ref.region.x1&&ref.region.y0<ref.region.y1);
    }
    assert.equal((await core.read(sessionId)).unit.id,opened.unit.id);
    assert.equal((await core.reviewStates(sessionId)).units[basis.spec.unitId].status,'pending');
    const history=(await core.commands.history({sessionId})).find(h=>h.operationId===first.operationId)!;
    assert.ok(history);
    for(const id of [`unit:${basis.spec.unitId}`,`structure:${basis.spec.unitId}`,`graph:${basis.spec.unitId}`,
      `theme:${basis.spec.themeId}`,`layout:${basis.spec.unitId}`,`layout-theme:${basis.spec.themeId}`]){
      const change=history.changes.find(c=>c.objectId===id);
      assert.ok(change,`${id} has a formal before/after record`);
      assert.equal(change.before,null);
      assert.ok(change.after);
    }
    assert.ok(history.changes.some(c=>c.objectId===unit.reading.blocks[0].id&&c.afterVersion>0));
    const stopped=await core.agent.stop({sessionId,taskId:task.id});
    assert.equal(stopped.stopRequested,true);
    await core.recordAgent({...identity,eventId:'controlled-stop-finish',kind:'finish',status:'interrupted',reconciliation:true});
    const checked=await core.agent.get({sessionId,conversationId:conversation.id});
    assert.equal(checked.tasks[0].status,'stopped');
    const resumed=await core.agent.continue({sessionId,taskId:task.id,operationId:'explicit-continue'});
    assert.notEqual(resumed.attemptId,task.attemptId);
    const nextIdentity={sessionId,taskId:resumed.id,attemptId:resumed.attemptId,generation:resumed.generation};
    const next=await core.readAgentGeneration(nextIdentity);
    assert.deepEqual(next.pendingStages,['practice']);
    assert.deepEqual(next.completedStages.map(s=>s.stage),['lesson']);
    const nextPractice=practice(next,'fresh-practice');
    const second=await core.publishAgentGeneration({...nextIdentity,input:nextPractice});
    assert.equal(second.status,'committed',second.reason);
    const practiceHistory=(await core.commands.history({sessionId})).find(h=>h.operationId===second.operationId)!;
    assert.ok(practiceHistory.changes.some(c=>c.objectId===`structure:${basis.spec.unitId}`));
    assert.ok(practiceHistory.changes.some(c=>c.objectId===`unit:${basis.spec.unitId}`&&c.before&&c.after),
      'practice records the unit identity revision for task history');
    const header=practiceHistory.changes.find(c=>c.objectId===`unit:${basis.spec.unitId}`)!;
    assert.equal(header.after!.encoding,'unit-header-v1');
    assert.equal(JSON.stringify(header).includes(String(unit.reading.blocks[0].payload.text)),false,'unchanged lesson bodies live only in their original object history');
    assert.ok(practiceHistory.changes.every(c=>!['graph:','theme:','layout:','layout-theme:'].some(prefix=>c.objectId.startsWith(prefix))),
      'practice does not claim a graph or layout lifecycle');
    assert.deepEqual((await core.readAgentGeneration(nextIdentity)).pendingStages,[]);
    assert.equal((await core.readUnit(sessionId,basis.spec.unitId)).reading.blocks.filter(b=>b.kind==='exercise').length,2);
    assert.equal((await core.graph(sessionId)).nodes.filter(n=>n.id===basis.spec.unitId).length,1);
    assert.deepEqual(await core.publishAgentGeneration({...nextIdentity,input:{...nextPractice,operationId:'accidental-repeat'}}),second);
    await core.close();core=new CourseService(resolve('dist/worker.cjs'));
    const reopened=await core.open(join(root,'course'));
    assert.equal((await core.readUnit(reopened.sessionId,basis.spec.unitId)).reading.blocks.filter(b=>b.kind==='exercise').length,2);
    assert.equal((await core.graph(reopened.sessionId)).nodes.filter(n=>n.id===basis.spec.unitId).length,1);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('formal task history withdraws and restores generated unit with both stages and preserves personal annotation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-history-'));
  let core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    const first=await core.publishAgentGeneration({...identity,input:lesson(initial,'history-lesson')});
    assert.equal(first.status,'committed');
    const unit=await core.readUnit(sessionId,initial.spec.unitId);
    const block=unit.reading.blocks[0],text=String(block.payload.text);
    const note=await core.annotations.create({sessionId,operationId:'history-personal-note',text:'自己整理的理解',selection:{unitId:unit.id,
      fragments:[{blockId:block.id,block,field:'text',formalRevision:1,source:'formal',projection:{version:1,encoding:'unicode-code-points',text},from:0,to:2,quote:Array.from(text).slice(0,2).join('')}]}});
    const next=await core.readAgentGeneration(identity);
    const second=await core.publishAgentGeneration({...identity,input:practice(next,'history-practice')});
    assert.equal(second.status,'committed');
    await core.recordAgent({...identity,eventId:'history-finish',kind:'finish',status:'completed'});
    const preview=await core.formalHistory.preview({sessionId,selection:{kind:'task',taskId:task.id}});
    const withdrawn=await core.formalHistory.apply({sessionId,operationId:'withdraw-generated-task',preview});
    assert.equal(withdrawn.status,'committed',JSON.stringify(withdrawn.conflicts));
    assert.deepEqual(withdrawn.applied,[second.operationId,first.operationId]);
    await assert.rejects(core.readUnit(sessionId,unit.id),/不存在/);
    assert.equal((await core.graph(sessionId)).nodes.some(node=>node.id===unit.id),false);
    const preserved=(await core.annotations.list({sessionId})).find(item=>item.id===note.id)!;
    assert.equal(preserved.text,note.text);assert.deepEqual(preserved.original,note.original);
    assert.equal(preserved.current.status,'orphan');
    const restore=await core.formalHistory.apply({sessionId,operationId:'restore-generated-task',
      preview:await core.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['withdraw-generated-task']}})});
    assert.equal(restore.status,'committed',JSON.stringify(restore.conflicts));
    assert.equal((await core.readUnit(sessionId,unit.id)).reading.blocks.filter(item=>item.kind==='exercise').length,2);
    assert.equal((await core.graph(sessionId)).nodes.filter(node=>node.id===unit.id).length,1);
    assert.deepEqual((await core.annotations.list({sessionId})).find(item=>item.id===note.id),note);
    await core.close();core=new CourseService(resolve('dist/worker.cjs'));
    const reopened=await core.open(join(root,'course'));
    assert.equal((await core.readUnit(reopened.sessionId,unit.id)).reading.blocks.filter(item=>item.kind==='exercise').length,2);
    assert.equal((await core.graph(reopened.sessionId)).nodes.filter(node=>node.id===unit.id).length,1);
    assert.deepEqual((await core.annotations.list({sessionId:reopened.sessionId})).find(item=>item.id===note.id),note);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('generated lifecycle rollback publishes no graph heap and equal placement after ABA still blocks withdrawal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-history-rollback-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const basis=await core.readAgentGeneration(identity);
    const saved=await core.publishAgentGeneration({...identity,input:lesson(basis,'rollback-lesson')});
    const unit=await core.readUnit(sessionId,basis.spec.unitId),graph=await core.graph(sessionId);
    const selection={kind:'operations' as const,operationIds:[saved.operationId]};
    const preview=await core.formalHistory.preview({sessionId,selection});
    const fault=new DatabaseSync(join(root,'course/course.sqlite'));
    try{
      // Fault DDL is a second writer. Use Core's bounded lock wait so real idle
      // retention cannot make trigger setup/teardown fail before testing rollback.
      fault.exec('PRAGMA busy_timeout=1000');
      fault.exec("CREATE TRIGGER fail_generated_history BEFORE INSERT ON cg_history WHEN new.operation_id='fault-generated-history' BEGIN SELECT RAISE(ABORT,'generated history fault'); END");
      await assert.rejects(core.formalHistory.apply({sessionId,operationId:'fault-generated-history',preview}),/generated history fault/);
      assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);
      assert.deepEqual(await core.graph(sessionId),graph);
      assert.equal(await core.formalHistory.query({sessionId,operationId:'fault-generated-history'}),null);
    }finally{try{fault.exec('DROP TRIGGER IF EXISTS fail_generated_history');}finally{fault.close();}}
    const node=graph.layout.nodes.find(item=>item.unitId===unit.id)!;
    const before={unitId:unit.id,x:node.x,y:node.y,width:node.width},away={...before,x:node.x+80};
    await core.drawings.place({sessionId,operationId:'placement-away',before,after:away});
    await core.drawings.place({sessionId,operationId:'placement-back',before:away,after:before});
    const blocked=await core.formalHistory.apply({sessionId,operationId:'withdraw-after-layout-aba',preview:await core.formalHistory.preview({sessionId,selection})});
    assert.equal(blocked.status,'conflict');
    assert.ok(blocked.conflicts.some(conflict=>conflict.objectIds.includes(`layout:${unit.id}`)));
    assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('an independent generated topic does not block withdrawing and restoring an earlier creation group',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-independent-history-'));
  let core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task,conversation}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const firstBasis=await core.readAgentGeneration(identity);
    const first=await core.publishAgentGeneration({...identity,input:lesson(firstBasis,'first-independent-topic')});
    assert.equal(first.status,'committed');
    await core.agent.stop({sessionId,taskId:task.id});
    await core.recordAgent({...identity,eventId:'first-topic-stop',kind:'finish',status:'interrupted',reconciliation:true});
    const secondTask=await core.agent.submit({sessionId,conversationId:conversation.id,operationId:'second-independent-request',generation:1,
      intent:'generate',target:{unitId:'KU-001'},text:'从相同来源建立另一个独立主题，保留已有主题。',
      generationSpec:{...firstBasis.spec,unitId:'KU-GEN-INDEPENDENT-02',themeId:'TH-GEN-INDEPENDENT-02',themeName:'独立四选一主题'}});
    const secondIdentity={sessionId,taskId:secondTask.id,attemptId:secondTask.attemptId,generation:secondTask.generation};
    const secondBasis=await core.readAgentGeneration(secondIdentity);
    assert.equal((await core.publishAgentGeneration({...secondIdentity,input:lesson(secondBasis,'second-independent-topic')})).status,'committed');
    const secondUnit=await core.readUnit(sessionId,secondBasis.spec.unitId),before=await core.graph(sessionId);
    await core.close();core=new CourseService(resolve('dist/worker.cjs'));
    const currentSession=(await core.open(join(root,'course'))).sessionId;
    const withdrawn=await core.formalHistory.apply({sessionId:currentSession,operationId:'withdraw-first-independent-topic',
      preview:await core.formalHistory.preview({sessionId:currentSession,selection:{kind:'operations',operationIds:[first.operationId]}})});
    assert.equal(withdrawn.status,'committed',JSON.stringify(withdrawn.conflicts));
    const graph=await core.graph(currentSession);
    assert.equal(graph.nodes.some(node=>node.id===firstBasis.spec.unitId),false);
    assert.deepEqual(graph.nodes.find(node=>node.id===secondUnit.id),before.nodes.find(node=>node.id===secondUnit.id));
    assert.deepEqual(graph.layout.nodes.find(node=>node.unitId===secondUnit.id),before.layout.nodes.find(node=>node.unitId===secondUnit.id));
    assert.deepEqual(await core.readUnit(currentSession,secondUnit.id),secondUnit);
    const restored=await core.formalHistory.apply({sessionId:currentSession,operationId:'restore-first-independent-topic',
      preview:await core.formalHistory.preview({sessionId:currentSession,selection:{kind:'operations',operationIds:[withdrawn.operationId]}})});
    assert.equal(restored.status,'committed',JSON.stringify(restored.conflicts));
    assert.equal((await core.graph(currentSession)).nodes.filter(node=>[firstBasis.spec.unitId,secondUnit.id].includes(node.id)).length,2);
    assert.deepEqual(await core.readUnit(currentSession,secondUnit.id),secondUnit);
    const recovered=await core.courseRestore.apply({sessionId:currentSession,operationId:'recover-only-first-topic',
      preview:await core.courseRestore.preview({sessionId:currentSession,atOperationId:first.operationId,side:'before',unitIds:[firstBasis.spec.unitId],userState:{layout:false,review:false}})});
    const finalGraph=await core.graph(recovered.sessionId);
    assert.equal(finalGraph.nodes.some(node=>node.id===firstBasis.spec.unitId),false);
    assert.deepEqual(finalGraph.nodes.find(node=>node.id===secondUnit.id),before.nodes.find(node=>node.id===secondUnit.id));
    assert.deepEqual(await core.readUnit(recovered.sessionId,secondUnit.id),secondUnit);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('generated title correction has a checked inverse and graph A-to-B-to-A cannot revive an older creation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-title-history-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task,conversation}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    const first=await core.publishAgentGeneration({...identity,input:lesson(initial,'original-title')});
    const original=await core.readUnit(sessionId,initial.spec.unitId);
    await core.agent.stop({sessionId,taskId:task.id});
    await core.recordAgent({...identity,eventId:'stop-before-title-correction',kind:'finish',status:'interrupted',reconciliation:true});
    const correction=await core.agent.submit({sessionId,conversationId:conversation.id,operationId:'title-correction-request',generation:1,
      intent:'generate',target:{unitId:'KU-001'},text:'只为当前小主题更新标题，保留现有身份和学习材料。',generationSpec:initial.spec});
    const nextIdentity={sessionId,taskId:correction.id,attemptId:correction.attemptId,generation:correction.generation};
    const basis=await core.readAgentGeneration(nextIdentity),proposal=lesson(basis,'corrected-title');
    proposal.title='单通道四选一选择原理';
    const changed=await core.publishAgentGeneration({...nextIdentity,input:proposal});
    assert.equal(changed.status,'committed');
    const reverted=await core.formalHistory.apply({sessionId,operationId:'withdraw-title-correction',
      preview:await core.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:[changed.operationId]}})});
    assert.equal(reverted.status,'committed',JSON.stringify(reverted.conflicts));
    assert.deepEqual(await core.readUnit(sessionId,original.id),original);
    const blocked=await core.formalHistory.apply({sessionId,operationId:'withdraw-before-title-aba',
      preview:await core.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:[first.operationId]}})});
    assert.equal(blocked.status,'conflict');
    assert.ok(blocked.conflicts.some(conflict=>conflict.objectIds.includes(`graph:${original.id}`)));
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('ordinary body commands cannot acquire generated lifecycle projection objects',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-domain-boundary-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const basis=await core.readAgentGeneration(identity);
    await core.publishAgentGeneration({...identity,input:lesson(basis,'lifecycle-domain-boundary')});
    const attempt=await core.commands.startAttempt({sessionId,taskId:'ordinary-body-producer'});
    for(const objectId of [`unit:${basis.spec.unitId}`,`graph:${basis.spec.unitId}`,`theme:${basis.spec.themeId}`,`layout-theme:${basis.spec.themeId}`])
      await assert.rejects(core.commands.read({sessionId,attemptId:attempt.attemptId,unitId:basis.spec.unitId,objectIds:[objectId]}),/正文命令域/);
    assert.equal((await core.graph(sessionId)).nodes.filter(node=>node.id===basis.spec.unitId).length,1);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('course recovery can withdraw a newly generated identity and continue from fresh generation without trusting old stage receipts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-course-recovery-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    const first=await core.publishAgentGeneration({...identity,input:lesson(initial,'before-course-recovery')});
    const oldBasis=await core.readAgentGeneration(identity);
    const preview=await core.courseRestore.preview({sessionId,atOperationId:first.operationId,side:'before',unitIds:[initial.spec.unitId],userState:{layout:false,review:false}});
    const restored=await core.courseRestore.apply({sessionId,operationId:'recover-before-generated-unit',preview});
    assert.equal(restored.generation,2);
    await assert.rejects(core.readUnit(restored.sessionId,initial.spec.unitId),/不存在/);
    assert.equal((await core.graph(restored.sessionId)).nodes.some(node=>node.id===initial.spec.unitId),false);
    await assert.rejects(core.publishAgentGeneration({...identity,input:practice(oldBasis,'late-old-generation')}),/会话|失效|代际/);
    assert.deepEqual(await core.queryAgentGeneration({...identity,operationId:'before-course-recovery'}),first,'old session keeps only immutable result lookup');
    await core.recordAgent({...identity,eventId:'old-generation-interrupted',kind:'finish',status:'interrupted',reconciliation:true});
    const resumed=await core.agent.continue({sessionId:restored.sessionId,taskId:task.id,operationId:'explicit-after-course-recovery'});
    const current={sessionId:restored.sessionId,taskId:resumed.id,attemptId:resumed.attemptId,generation:resumed.generation};
    assert.equal(current.generation,2);
    const basis=await core.readAgentGeneration(current);
    assert.deepEqual(basis.completedStages,[]);assert.deepEqual(basis.pendingStages,['lesson','practice']);
    assert.equal((await core.publishAgentGeneration({...current,input:lesson(basis,'new-generation-lesson')})).status,'committed');
    const after=await core.readAgentGeneration(current);
    assert.deepEqual(after.pendingStages,['practice']);
    assert.equal((await core.publishAgentGeneration({...current,input:practice(after,'new-generation-practice')})).status,'committed');
    assert.equal((await core.graph(restored.sessionId)).nodes.filter(node=>node.id===initial.spec.unitId).length,1);
    assert.ok((await core.sources.list({sessionId:restored.sessionId})).versions.some(version=>version.versionId===initial.source.versionId));
    assert.deepEqual(await core.queryAgentGeneration({...identity,operationId:'before-course-recovery'}),first);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('course recovery to a confirmed lesson rechecks current stages and continues only the withdrawn practice',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-partial-recovery-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    const first=await core.publishAgentGeneration({...identity,input:lesson(initial,'confirmed-lesson')});
    const next=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:practice(next,'old-practice')})).status,'committed');
    const restored=await core.courseRestore.apply({sessionId,operationId:'recover-lesson-only',preview:await core.courseRestore.preview({sessionId,atOperationId:first.operationId,side:'after',unitIds:[initial.spec.unitId],userState:{layout:false,review:false}})});
    await core.recordAgent({...identity,eventId:'finish-before-practice-resume',kind:'finish',status:'interrupted',reconciliation:true});
    const resumed=await core.agent.continue({sessionId:restored.sessionId,taskId:task.id,operationId:'continue-only-practice'});
    const current={sessionId:restored.sessionId,taskId:resumed.id,attemptId:resumed.attemptId,generation:resumed.generation};
    const basis=await core.readAgentGeneration(current);
    assert.deepEqual(basis.completedStages.map(stage=>stage.stage),['lesson']);
    assert.deepEqual(basis.pendingStages,['practice']);
    assert.equal((await core.publishAgentGeneration({...current,input:practice(basis,'replacement-practice')})).status,'committed');
    assert.equal((await core.readUnit(restored.sessionId,initial.spec.unitId)).reading.blocks.filter(block=>block.kind==='exercise').length,2);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('latest student draft stops a dependent practice group and preserves the published lesson',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-student-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:lesson(initial,'lesson-before-draft')})).status,'committed');
    const next=await core.readAgentGeneration(identity);
    const unit=await core.readUnit(sessionId,next.spec.unitId);
    await core.saveDraft({sessionId,unitId:unit.id,inputSeq:1,baseRevision:1,
      changes:[{blockId:unit.reading.blocks[0].id,text:'学生正在整理这一段的理解，先保留输入。'}],complete:true});
    const result=await core.publishAgentGeneration({...identity,input:practice(next,'practice-after-draft')});
    assert.equal(result.status,'retained');assert.equal(result.checks.find(c=>c.layer==='version')?.status,'failed');
    assert.match(result.reason!,/学生最新草稿/);
    assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);
    assert.deepEqual((await core.readAgentGeneration(identity)).pendingStages,['practice']);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('active target editor fences a generation group before its input tail becomes a durable draft',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-editor-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:lesson(initial,'lesson-before-editor')})).status,'committed');
    const basis=await core.readAgentGeneration(identity),unit=await core.readUnit(sessionId,basis.spec.unitId);
    const editor={sessionId,unitId:unit.id,editorId:'active-generated-editor',inputSeq:0,blockIds:[unit.reading.blocks[0].id]};
    await core.commands.protect({...editor,sequence:1,mode:'editing'});
    const blocked=await core.publishAgentGeneration({...identity,input:practice(basis,'practice-during-input-tail')});
    assert.equal(blocked.status,'retained');assert.match(blocked.reason!,/编辑/);
    assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);
    await core.commands.protect({...editor,sequence:2,mode:'selection'});
    const latest=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:practice(latest,'practice-after-editor')})).status,'committed');
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a transient student draft returning to its original text still requires a fresh generation read',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-draft-aba-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    await core.publishAgentGeneration({...identity,input:lesson(initial,'lesson-before-transient-draft')});
    const basis=await core.readAgentGeneration(identity),unit=await core.readUnit(sessionId,basis.spec.unitId),block=unit.reading.blocks[0];
    const input={sessionId,unitId:unit.id,baseRevision:1,complete:true};
    await core.saveDraft({...input,inputSeq:1,changes:[{blockId:block.id,text:'学生尚未晋升的临时理解'}]});
    const back={...input,inputSeq:2,changes:[{blockId:block.id,text:String(block.payload.text)}]};
    await core.saveDraft(back);await core.commitEdit({...back,operationId:'return-student-input'});
    assert.equal((await core.read(sessionId,unit.id)).drafts.length,0);
    const result=await core.publishAgentGeneration({...identity,input:practice(basis,'practice-with-old-input-basis')});
    assert.equal(result.status,'retained');assert.match(result.reason!,/输入|草稿/);
    const fresh=await core.readAgentGeneration(identity);
    assert.ok(fresh.target.studentDraftVersion>basis.target.studentDraftVersion);
    assert.equal((await core.publishAgentGeneration({...identity,input:practice(fresh,'practice-with-fresh-input-basis')})).status,'committed');
    assert.equal((await core.readUnit(sessionId,unit.id)).reading.blocks[0].payload.text,block.payload.text);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('new bytes of the same source invalidate only future dependent publication and retain old references',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-source-update-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:lesson(initial,'lesson-before-source-update')})).status,'committed');
    const next=await core.readAgentGeneration(identity),unit=await core.readUnit(sessionId,next.spec.unitId);
    const revised=join(root,'revised.pdf');
    await writeFile(revised,Buffer.concat([await readFile(join(root,'table.pdf')),Buffer.from('\n% revised-source-copy\n')]));
    await core.sources.importFile({sessionId,generation:1,operationId:'new-source-bytes',path:revised,sourceId:next.source.sourceId,title:'Revised selector table'});
    const result=await core.publishAgentGeneration({...identity,input:practice(next,'practice-on-old-source')});
    assert.equal(result.status,'retained');assert.equal(result.checks.find(c=>c.layer==='version')?.status,'failed');
    assert.match(result.reason!,/来源已有内容不同的新版本/);
    assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);
    assert.equal((unit.reading.blocks[0].sourceRefs as Array<{versionId:string}>)[0].versionId,initial.source.versionId);
    await assert.rejects(core.readAgentGeneration(identity),/来源已有内容不同的新版本/);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('recoverable generation survives retention and a durable backup resource lease does not freeze publication',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-retention-'));
  const clock=new SharedArrayBuffer(8),start=Date.parse('2030-01-01T00:00:00Z');
  Atomics.store(new BigInt64Array(clock),0,BigInt(start));
  let core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
  try{
    const {sessionId,task,opened}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity),invalid={...lesson(initial,'retained-before-cleanup'),formula:'Z=I0+I1+I2+I3'};
    const failed=await core.publishAgentGeneration({...identity,input:invalid});
    assert.equal(failed.status,'retained');
    const orphanBytes=Buffer.from('Unregistered immutable bytes from an interrupted unrelated publication');
    const orphanHash=createHash('sha256').update(orphanBytes).digest('hex'),orphan=join(root,'course/resources',orphanHash);
    await writeFile(orphan,orphanBytes);
    await core.retention.resourceLease({sessionId,id:'backup-while-generation-pending',action:'acquire'});
    await core.agent.stop({sessionId,taskId:task.id});
    await core.recordAgent({...identity,eventId:'retention-stop',kind:'finish',status:'interrupted',reconciliation:true});
    await core.close();core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
    const current=(await core.open(join(root,'course'))).sessionId;
    assert.equal((await core.retention.resourceLeases({sessionId:current})).find(lease=>lease.id==='backup-while-generation-pending')?.state,'active');
    Atomics.store(new BigInt64Array(clock),0,BigInt(start+150*86_400_000));
    const drain=async()=>{
      for(let i=0;i<500;i++){
        const result=await core.retention.run({sessionId:current,limit:64});
        if(!result.pending)return result;
      }
      throw new Error('bounded retention did not settle');
    };
    assert.equal((await drain()).phase,'resources-pinned');
    assert.deepEqual(await readFile(orphan),orphanBytes);
    const candidates=await core.generationCandidates({sessionId:current,taskId:task.id});
    assert.equal(candidates.length,1);assert.equal(candidates[0].proposal.formula,invalid.formula);
    const resumed=await core.agent.continue({sessionId:current,taskId:task.id,operationId:'continue-after-retention'});
    const active={sessionId:current,taskId:resumed.id,attemptId:resumed.attemptId,generation:resumed.generation};
    const basis=await core.readAgentGeneration(active);
    assert.deepEqual(basis.pendingStages,['lesson','practice']);
    const published=await core.publishAgentGeneration({...active,input:lesson(basis,'correct-after-retention')});
    assert.equal(published.status,'committed');
    const next=await core.readAgentGeneration(active);
    assert.equal((await core.publishAgentGeneration({...active,input:practice(next,'practice-after-retention')})).status,'committed');
    await core.recordAgent({...active,eventId:'retention-completed',kind:'finish',status:'completed'});
    await core.retention.resourceLease({sessionId:current,id:'backup-while-generation-pending',action:'release'});
    assert.equal((await drain()).phase,'idle');
    assert.equal((await core.formalHistory.detail({sessionId:current,operationId:published.operationId})).operationId,published.operationId,
      'new publication uses the same course history clock as retention');
    await assert.rejects(readFile(orphan),/ENOENT/);
    const original=await core.sources.readResource({sessionId:current,versionId:basis.source.versionId,begin:0,end:4});
    assert.equal(Buffer.from(original.bytes).toString(),'%PDF');
    const page=await core.parsing.artifact({sessionId:current,artifactId:basis.artifact.artifactId});
    const raster=page.resources.find(resource=>resource.mediaType==='image/png')!;
    const image=await core.parsing.readResource({sessionId:current,artifactId:basis.artifact.artifactId,sha256:raster.sha256,begin:0,end:8});
    assert.deepEqual([...image.bytes],[137,80,78,71,13,10,26,10]);
    assert.equal((await core.readUnit(current,basis.spec.unitId)).reading.blocks.filter(block=>block.kind==='exercise').length,2);
    assert.deepEqual((await core.read(current)).unit,opened.unit);
    assert.deepEqual(await core.queryAgentGeneration({...identity,sessionId:current,operationId:'retained-before-cleanup'}),failed);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('retention expires a withdrawn generated creation without losing its result identity or reviving tombstones',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-retired-'));
  const clock=new SharedArrayBuffer(8),start=Date.parse('2030-01-01T00:00:00Z');
  Atomics.store(new BigInt64Array(clock),0,BigInt(start));
  const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
  try{
    const {sessionId,task,opened}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const basis=await core.readAgentGeneration(identity);
    const published=await core.publishAgentGeneration({...identity,input:lesson(basis,'creation-before-retirement')});
    assert.equal(published.status,'committed');
    await core.recordAgent({...identity,eventId:'finished-before-retirement',kind:'finish',status:'completed'});
    const withdrawn=await core.formalHistory.apply({sessionId,operationId:'retire-before-cleanup',
      preview:await core.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:[published.operationId]}})});
    assert.equal(withdrawn.status,'committed',JSON.stringify(withdrawn.conflicts));
    Atomics.store(new BigInt64Array(clock),0,BigInt(start+150*86_400_000));
    let result=await core.retention.run({sessionId,limit:64});
    for(let i=0;result.pending&&i<500;i++)result=await core.retention.run({sessionId,limit:64});
    assert.equal(result.phase,'idle',JSON.stringify(result));
    await assert.rejects(core.formalHistory.detail({sessionId,operationId:published.operationId}),/过期/);
    assert.deepEqual(await core.queryAgentGeneration({...identity,operationId:'creation-before-retirement'}),published);
    assert.deepEqual(await core.formalHistory.query({sessionId,operationId:withdrawn.operationId}),withdrawn);
    await assert.rejects(core.readUnit(sessionId,basis.spec.unitId),/不存在/);
    assert.equal((await core.graph(sessionId)).nodes.some(node=>node.id===basis.spec.unitId),false);
    assert.deepEqual((await core.read(sessionId)).unit,opened.unit);
    const original=await core.sources.readResource({sessionId,versionId:basis.source.versionId,begin:0,end:4});
    assert.equal(Buffer.from(original.bytes).toString(),'%PDF');
    await core.close();
    const db=new DatabaseSync(join(root,'course/course.sqlite'),{readOnly:true});
    try{
      const candidate=db.prepare('SELECT proposal,result,digest,checks FROM generation_candidates WHERE id=?').get(published.operationId)!;
      assert.deepEqual(JSON.parse(String(candidate.proposal)),{stage:'lesson'},'ended proposal body expires with its formal history');
      assert.deepEqual(JSON.parse(String(candidate.result)),published);
      assert.match(String(candidate.digest),/^[a-f0-9]{64}$/);
      assert.equal(candidate.checks,'[]');
      assert.deepEqual(JSON.parse(String(db.prepare('SELECT receipt FROM generation_groups WHERE operation_id=?').get(published.operationId)!.receipt)),published);
      const readset=JSON.parse(String(db.prepare('SELECT payload FROM generation_bases WHERE id=?').get(basis.basisId)!.payload)).readset;
      assert.ok(readset.some((entry:{id:string})=>entry.id===basis.source.versionId),'small original read-set facts remain');
    }finally{db.close();}
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('explicit local regeneration keeps the unit and block IDs and preserves the student note',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-regenerate-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const {sessionId,task,conversation}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const firstBasis=await core.readAgentGeneration(identity);
    assert.equal((await core.publishAgentGeneration({...identity,input:lesson(firstBasis,'initial-lesson')})).status,'committed');
    const first=await core.readUnit(sessionId,firstBasis.spec.unitId),revision=(await core.read(sessionId,first.id)).revision;
    const block=first.reading.blocks[0],text=String(block.payload.text),quote=Array.from(text).slice(0,2).join('');
    const note=await core.annotations.create({sessionId,operationId:'student-note-on-generated',text:'我自己的理解',
      selection:{unitId:first.id,fragments:[{blockId:block.id,block,field:'text',formalRevision:revision,source:'formal',
        projection:{version:1,encoding:'unicode-code-points',text},from:0,to:2,quote}]}});
    await core.agent.stop({sessionId,taskId:task.id});
    await core.recordAgent({...identity,eventId:'finish-before-local-regeneration',kind:'finish',status:'interrupted',reconciliation:true});
    const nextTask=await core.agent.submit({sessionId,conversationId:conversation.id,operationId:'regenerate-request',generation:1,
      intent:'generate',text:'根据同一来源更新本主题说明，保留已有身份和笔记',target:{unitId:'KU-001'},generationSpec:firstBasis.spec});
    const nextIdentity={sessionId,taskId:nextTask.id,attemptId:nextTask.attemptId,generation:nextTask.generation};
    const basis=await core.readAgentGeneration(nextIdentity);
    const revised=lesson(basis,'revised-lesson');revised.intro+=' 增补：本次只改写说明，保留原例练的稳定身份。';
    assert.equal((await core.publishAgentGeneration({...nextIdentity,input:revised})).status,'committed');
    const after=await core.readUnit(sessionId,first.id);
    assert.equal(after.id,first.id);
    assert.deepEqual(after.reading.blocks.map(b=>b.id),first.reading.blocks.map(b=>b.id));
    assert.equal((await core.graph(sessionId)).nodes.filter(n=>n.id===first.id).length,1);
    const notes=await core.annotations.list({sessionId});
    assert.equal(notes.length,1);assert.equal(notes[0].id,note.id);
    assert.deepEqual(notes[0].original,note.original);
    assert.equal(notes[0].text,note.text);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});


test('a full backup retains actual T30 waiting generation basis resources and never resumes an old task automatically',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-generation-backup-')),core=new CourseService(resolve('dist/worker.cjs'));let copy:CourseService|undefined;
 try{
  const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
  const basis=await core.readAgentGeneration(identity);
  const rejected=lesson(basis,'backup-retained-proposal');rejected.formula='Z=I0';
  assert.equal((await core.publishAgentGeneration({...identity,input:rejected})).status,'retained');
  const manifest=await core.backup.create({sessionId,directory:join(root,'backup'),backupId:'t30-recovery'});
  assert.ok(manifest.resources.some(r=>r.sha256===basis.source.sha256));
  assert.ok(manifest.resources.some(r=>r.declaredBy.includes('t30-generation-recovery')));
  await core.close();copy=new CourseService(resolve('dist/worker.cjs'));const c=await copy.open(join(root,'backup'));
  const recovered=await copy.agentTask({sessionId:c.sessionId,taskId:task.id});assert.notEqual(recovered.status,'running');
  assert.equal((await copy.generationCandidates({sessionId:c.sessionId,taskId:task.id})).length,1);
 }finally{await copy?.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('old full-unit generation histories remain byte-identical, reversible and queryable with original receipts after reopen',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-old-generation-history-'));let core=new CourseService(resolve('dist/worker.cjs'));
  try {
    const {sessionId,task}=await prepared(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation};
    const initial=await core.readAgentGeneration(identity),lessonReceipt=await core.publishAgentGeneration({...identity,input:lesson(initial,'legacy-header-lesson')});
    const old=await core.readUnit(sessionId,initial.spec.unitId),basis=await core.readAgentGeneration(identity);
    const practiceReceipt=await core.publishAgentGeneration({...identity,input:practice(basis,'legacy-header-practice')});
    const current=await core.readUnit(sessionId,old.id);
    await core.recordAgent({...identity,eventId:'legacy-header-finish',kind:'finish',status:'completed'});
    // System-boundary fixture: exact pre-fix stored encoding. Product code must never rewrite it.
    const db=new DatabaseSync(join(root,'course/course.sqlite'));const original=new Map<string,string>();
    try {
      db.exec('PRAGMA busy_timeout=1000');
      for(const [id,before,after] of [[lessonReceipt.operationId,null,old],[practiceReceipt.operationId,old,current]] as const) {
        const h=JSON.parse(String(db.prepare('SELECT payload FROM cg_history WHERE operation_id=?').get(id)!.payload));
        const unit=h.changes.find((c:any)=>c.objectId===`unit:${old.id}`);unit.before=before;unit.after=after;
        const text=JSON.stringify(h);db.prepare('UPDATE cg_history SET payload=? WHERE operation_id=?').run(text,id);original.set(id,text);
      }
    }finally{db.close();}
    await core.close();core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(join(root,'course'));
    assert.deepEqual(await core.queryAgentGeneration({...identity,sessionId:reopened.sessionId,operationId:'legacy-header-lesson'}),lessonReceipt);
    assert.deepEqual(await core.queryAgentGeneration({...identity,sessionId:reopened.sessionId,operationId:'legacy-header-practice'}),practiceReceipt);
    const preview=await core.formalHistory.preview({...reopened,selection:{kind:'task',taskId:task.id}});
    assert.equal((await core.formalHistory.apply({...reopened,operationId:'undo-old-generation',preview})).status,'committed');
    await assert.rejects(core.readUnit(reopened.sessionId,old.id),/不存在/);
    const redo=await core.formalHistory.preview({...reopened,selection:{kind:'operations',operationIds:['undo-old-generation']}});
    assert.equal((await core.formalHistory.apply({...reopened,operationId:'redo-old-generation',preview:redo})).status,'committed');
    assert.deepEqual(await core.readUnit(reopened.sessionId,old.id),current);
    const verify=new DatabaseSync(join(root,'course/course.sqlite'),{readOnly:true});
    try{for(const [id,payload] of original)assert.equal(verify.prepare('SELECT payload FROM cg_history WHERE operation_id=?').get(id)!.payload,payload);}
    finally{verify.close();}
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
