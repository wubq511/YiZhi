import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CourseService } from '../src/core/course-service';

// An independent, untagged PDF at the public Sources -> Parsing seam. Its active-low
// table has the same finite semantics as the real TI acceptance source.
async function tablePdf(path: string) {
  const labels = ['7.3', 'Device Functional Modes', 'B', 'A', 'C0', 'C1', 'C2', 'C3', 'G', 'OUTPUT Y'];
  const xs = [36, 72, 40, 80, 120, 160, 200, 240, 280, 320];
  const cells = [
    ['X','X','X','X','X','X','H','L'],
    ['L','L','L','X','X','X','L','L'], ['L','L','H','X','X','X','L','H'],
    ['L','H','X','L','X','X','L','L'], ['L','H','X','H','X','X','L','H'],
    ['H','L','X','X','L','X','L','L'], ['H','L','X','X','H','X','L','H'],
    ['H','H','X','X','X','L','L','L'], ['H','H','X','X','X','H','L','H'],
  ];
  const at = (value: string, x: number, y: number) => `BT /F1 8 Tf ${x} ${y} Td (${value}) Tj ET`;
  const stream = labels.map((v, i) => at(v, xs[i], i < 2 ? 280 - i * 14 : 250)).join('\n') + '\n' +
    cells.flatMap((row, i) => row.map((v, j) => at(v, 40 + j * 40, 228 - i * 16))).join('\n') +
    '\n1 w 279 260 m 288 260 l S';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((v, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${v}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path, pdf);
}

async function prepared(core: CourseService, root: string) {
  const opened = await core.open(join(root, 'course')); const sessionId = opened.sessionId;
  const path = join(root, 'table.pdf'); await tablePdf(path);
  const version = (await core.sources.importFile({ sessionId, operationId: 'table-source', generation: 1, path, title: 'Finite selector table' })).version;
  const parsing = await core.parsing.start({ sessionId, operationId: 'table-parse', generation: 1, versionId: version.versionId });
  let artifact;
  for (let i = 0; i < 200; i++) {
    const state = await core.parsing.get({ sessionId, taskId: parsing.taskId });
    if (state.status === 'completed') { artifact = state.confirmed[0]; break; }
    if (state.status === 'failed') throw new Error(state.failure);
    await new Promise(done => setTimeout(done, 10));
  }
  assert.ok(artifact, 'actual parser confirmed the source page');
  const conversation = await core.agent.create({ sessionId, operationId: 'conversation' });
  const task = await core.agent.submit({ sessionId, conversationId: conversation.id, operationId: 'generate', generation: 1,
    intent: 'generate', text: '从此页生成独立的单通道四选一主题，含完整解释与例练', target: { unitId: 'KU-001' },
    generationSpec: { unitId: 'KU-GEN-MUX-01', themeId: 'TH-GEN-MUX-01', themeName: '四选一数据选择',
      sourceVersionId: version.versionId, artifactId: artifact.artifactId, pdfPageIndex: 0 } });
  return { sessionId, task, conversation, opened };
}

function lesson(basis: Awaited<ReturnType<CourseService['readAgentGeneration']>>, operationId: string) {
  return { operationId, basisId: basis.basisId, stage: 'lesson' as const,
    title: '四选一数据选择', outcome: '能解释低有效使能与选择信号，并独立计算一个通道的输出。',
    intro: '本主题只讨论表中 G 低（Gbar=0）这一通道。B、A 是选择输入，令 S1=B、S0=A；C0、C1、C2、C3 分别记作数据输入 I0、I1、I2、I3；输出 Y 记作 Z。G 低是低有效使能条件，此时选择输入决定哪一路数据传到输出。G 高时表中 Y=L，因此本主题的四选一选择规则仅在 Gbar=0 时使用。',
    derivation: '00→C0，01→C1，10→C2，11→C3；其余数据位为 X。' + '将选择码的四种情况分别乘上对应数据输入并相加，输出等于被选中的输入。'.repeat(3),
    formula: 'Z=¬S1·¬S0·I0+¬S1·S0·I1+S1·¬S0·I2+S1·S0·I3',
    example: { problem: 'S1=0、S0=1、I1=1 时，单通道输出 Z 是多少？', steps: '01 对应 C1，也就是 I1；其余输入是 X，不决定本次输出。', answer: 'Z=1，因为选中的 I1=1。', inputs: { S1:0,S0:1,I0:0,I1:1,I2:0,I3:0 }, output: 1 },
    exercise: { problem: 'S1=1、S0=0、I2=1 时，单通道输出 Z 是多少？', hint: '先把选择码 10 对应到一个 C 输入，再读该输入值。', answer: 'Z=1，因为 10 选 C2=I2，而 I2=1。', inputs: { S1:1,S0:0,I0:0,I1:0,I2:1,I3:0 }, output: 1 },
    evidence: basis.evidenceIds };
}
function practice(basis:Awaited<ReturnType<CourseService['readAgentGeneration']>>,operationId:string){
  return {operationId,basisId:basis.basisId,stage:'practice' as const,
    exercise:{problem:'S1=1、S0=1、I3=0 时，单通道输出 Z 是多少？',hint:'11 选择 C3=I3。',answer:'Z=0，因为所选 I3=0。',inputs:{S1:1,S0:1,I0:1,I1:1,I2:1,I3:0},output:0},
    evidence:{enable:[],selection:[],formula:[],example:[],exercise:basis.evidenceIds.exercise}};
}

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
      'practice records the full unit revision for task history');
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
      fault.exec("CREATE TRIGGER fail_generated_history BEFORE INSERT ON cg_history WHEN new.operation_id='fault-generated-history' BEGIN SELECT RAISE(ABORT,'generated history fault'); END");
      await assert.rejects(core.formalHistory.apply({sessionId,operationId:'fault-generated-history',preview}),/generated history fault/);
      assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);
      assert.deepEqual(await core.graph(sessionId),graph);
      assert.equal(await core.formalHistory.query({sessionId,operationId:'fault-generated-history'}),null);
    }finally{fault.exec('DROP TRIGGER fail_generated_history');fault.close();}
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
