import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { AgentRuntime } from '../src/agent/executor';
import { chmod } from 'node:fs/promises';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  for (let n = 0; n < 250; n++) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for working Agent');
}

test('course modifications wait in submission order across conversations while questions remain readable and runnable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-working-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId, editableBlockId } = await core.open(root);
    const first = await core.agent.create({ sessionId, operationId: 'first' });
    const second = await core.agent.create({ sessionId, operationId: 'second' });
    const qa = await core.agent.create({ sessionId, operationId: 'qa' });
    const task = await core.agent.submit({ sessionId, operationId: 'write-one', conversationId: first.id, generation: 1,
      intent: 'modify', text: '修改首段', target: { unitId: 'KU-001', blockId: editableBlockId } });
    const request = { sessionId, operationId: 'write-two', conversationId: second.id, generation: 1,
      intent: 'modify' as const, text: '修改第二个固定目标', target: { unitId: 'KU-001' } };
    const queued = await core.agent.submit(request);
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.blockedBy, [task.id]);
    assert.equal(queued.threadId, null);
    assert.equal(queued.snapshot.target.unitId, 'KU-001');
    assert.equal((await core.agent.submit(request)).id, queued.id);
    await assert.rejects(core.activeAgent({ sessionId, taskId: queued.id, attemptId: queued.attemptId, generation: 1 }), /停止或失效|尚未开始/);
    const question = await core.agent.submit({ sessionId, operationId: 'question', conversationId: qa.id, generation: 1,
      text: '解释位权', target: { unitId: 'KU-001' } });
    assert.equal(question.status, 'running');
    assert.equal((await core.read(sessionId)).revision, 1);
    assert.equal((await core.agent.get({ sessionId, conversationId: second.id })).messages.length, 1);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('host automatically starts a fresh integration turn after caret release; queue waits for the whole business task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-automatic-integration-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new AgentRuntime(core, { cliPath: resolve('dist/tests/agent-executor-fixture.cjs'), directory: join(root, 'executor'), env: { ...process.env, YIZHI_FIXTURE_MODE: 'coedit' } });
  try {
    const c = await core.open(join(root, 'course')), sessionId = c.sessionId, a = c.unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const conv = await core.agent.create({ sessionId, operationId: 'conversation' });
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 1, inputSeq: 0, blockIds: [a.id], mode: 'editing' });
    const first = await runtime.submit({ sessionId, conversationId: conv.id, operationId: 'modify', generation: 1,
      intent: 'modify', text: '补充首段', target: { unitId: 'KU-001' } });
    const get = () => core.agent.get({ sessionId, conversationId: conv.id });
    await until(get, v => v.tasks[0].status === 'waiting');
    const second = await runtime.submit({ sessionId, conversationId: conv.id, operationId: 'queue', generation: 1,
      mode: 'queue', text: '整合完成以后再解释', target: { unitId: 'KU-001' } });
    assert.equal(second.status, 'queued');
    await core.commitEdit({ sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'student-prefix', complete: true, changes: [],
      patch: { updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '保留学生：' + a.payload.text } }], correspondence: [] } });
    await new Promise(r => setTimeout(r, 200));
    assert.equal((await get()).tasks[1].threadId, null);
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 2, inputSeq: 1, blockIds: [], mode: 'editing' });
    const done = await until(get, v => v.tasks.every(t => t.status === 'completed'));
    assert.equal(done.tasks[0].id, first.id); assert.equal(done.tasks[0].attemptId, first.attemptId);
    assert.equal(done.tasks[0].turnHistory!.length, 1);
    assert.ok(done.messages.filter(m=>m.taskId===first.id&&m.role==='assistant').every(m=>!m.text.includes('整合完成以后再解释')), 'queued text must not enter the original task context before activation');
    assert.equal((await core.read(sessionId)).unit.reading.blocks.find(p => p.id === a.id)!.payload.text, '保留学生：' + a.payload.text + ' Agent补充。');
    assert.deepEqual(await core.commands.candidates({ sessionId, attemptId: first.attemptId }), []);
    assert.ok(done.tasks[0].deliveries!.find(d => d.kind === 'student-change')!.reviewedBasisId);
    assert.ok(done.tasks[0].groups!.some(g => g.resolvedCandidateIds?.length === 1));
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('fresh integrated proposal resolves the entire retained group atomically while preserving the original receipt and latest student input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-integrated-group-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    const conv = await core.agent.create({ sessionId, operationId: 'conversation' });
    const task = await core.agent.submit({ sessionId, conversationId: conv.id, operationId: 'modify', generation: 1,
      intent: 'modify', text: '补充首段', target: { unitId: 'KU-001' } });
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1 };
    const a = c.unit.reading.blocks.find(b => b.kind === 'paragraph')!, basis = await core.readAgentMutation(identity);
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 1, inputSeq: 0, blockIds: [a.id], mode: 'editing' });
    const old = await core.applyAgentMutation({ ...identity, input: { basisId: basis.basisId, operationId: 'before-student', conclusionOrMethodChanged: false,
      updates: [{ blockId: a.id, text: a.payload.text + ' Agent补充。' }] } });
    await core.commitEdit({ sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'student-prefix', complete: true, changes: [],
      patch: { updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '学生保留：' + a.payload.text } }], correspondence: [] } });
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 2, inputSeq: 1, blockIds: [], mode: 'editing' });
    const fresh = await core.readAgentMutation(identity);
    assert.equal(fresh.pendingGroups[0].candidateId, old.operationId);
    const input = { basisId: fresh.basisId, operationId: 'after-student', conclusionOrMethodChanged: false, replaces: [old.operationId],
      updates: [{ blockId: a.id, text: '学生保留：' + a.payload.text + ' Agent补充。' }] };
    const integrated = await core.applyAgentMutation({ ...identity, input });
    assert.equal(integrated.status, 'committed', integrated.reason);
    assert.deepEqual(integrated.resolvedCandidateIds, [old.operationId]);
    assert.deepEqual(await core.applyAgentMutation({ ...identity, input }), integrated);
    assert.deepEqual(await core.commands.candidates({ sessionId, attemptId: task.attemptId }), []);
    assert.equal((await core.commands.query({ sessionId, operationId: old.operationId }))!.status, 'retained');
    assert.equal((await core.read(sessionId)).unit.reading.blocks.find(p => p.id === a.id)!.payload.text, input.updates[0].text);
    const final = await core.recordAgent({ ...identity, kind: 'finish', status: 'completed', eventId: 'model-ended' });
    assert.equal(final.status, 'completed');
    assert.deepEqual(final.deliveries![0].integratedOperationIds, [integrated.operationId]);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual student commit records a durable executor notice; accepted does not renew the old basis, a fresh read does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-student-notice-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    const conv = await core.agent.create({ sessionId, operationId: 'conversation' });
    const task = await core.agent.submit({ sessionId, conversationId: conv.id, operationId: 'modify', generation: 1,
      intent: 'modify', text: '改写首段', target: { unitId: 'KU-001' } });
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1 };
    const basis = await core.readAgentMutation(identity), [a, b] = c.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    const receipt = await core.commitEdit({ sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'student-independent',
      complete: true, changes: [{ blockId: b.id, text: '学生在另一段保留自己的解释。' }] });
    let view = await core.agent.get({ sessionId, conversationId: conv.id });
    const notice = view.tasks[0].deliveries!.find(d => d.kind === 'student-change')!;
    assert.equal(notice.change!.operationId, receipt.operationId);
    assert.deepEqual(notice.change!.objectIds, [b.id]);
    assert.equal(notice.state, 'pending');
    await core.updateAgentWork({ ...identity, action: 'delivery', deliveryId: notice.id, state: 'accepted', threadId: 'original-thread', turnId: 'original-turn' });
    const old = await core.applyAgentMutation({ ...identity, input: { basisId: basis.basisId, operationId: 'old-read', conclusionOrMethodChanged: false,
      updates: [{ blockId: a.id, text: '使用旧依据的改写。' }] } });
    assert.equal(old.status, 'retained');
    view = await core.agent.get({ sessionId, conversationId: conv.id });
    assert.equal(view.tasks[0].deliveries![0].reviewedBasisId, undefined);
    const fresh = await core.readAgentMutation(identity);
    assert.equal(fresh.content.reading.blocks.find(p => p.id === b.id)!.payload.text, '学生在另一段保留自己的解释。');
    view = await core.agent.get({ sessionId, conversationId: conv.id });
    assert.equal(view.tasks[0].deliveries![0].reviewedBasisId, fresh.basisId);
    assert.equal((await core.read(sessionId)).unit.reading.blocks.find(p => p.id === a.id)!.payload.text, a.payload.text);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('model completion keeps the original business attempt while protected candidates and their queue remain unfinished', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-business-wait-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    const conv = await core.agent.create({ sessionId, operationId: 'conversation' });
    const task = await core.agent.submit({ sessionId, conversationId: conv.id, operationId: 'modify', generation: 1,
      intent: 'modify', text: '在首段补充一句', target: { unitId: 'KU-001' } });
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: task.generation };
    const paragraphs = c.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    await core.commands.protect({ sessionId, editorId: 'cross-paragraph', sequence: 1, inputSeq: 0,
      blockIds: paragraphs.slice(0, 2).map(b => b.id), mode: 'editing' });
    const basis = await core.readAgentMutation(identity);
    const candidate = await core.applyAgentMutation({ ...identity, input: { operationId: 'protected-update', basisId: basis.basisId,
      conclusionOrMethodChanged: false, updates: [{ blockId: paragraphs[0].id, text: paragraphs[0].payload.text + ' Agent补充。' }] } });
    assert.equal(candidate.status, 'retained');
    const end = await core.recordAgent({ ...identity, kind: 'finish', status: 'completed', eventId: 'model-ended' });
    assert.equal(end.executorStatus, 'completed');
    assert.equal(end.status, 'waiting', 'model completion must not settle a protected business task');
    assert.equal((await core.activeAgent(identity)).attemptId, task.attemptId);
    assert.equal((await core.commands.recheck({ sessionId })).find(c => c.candidateId === candidate.operationId)!.status, 'waiting');
    const queued = await core.agent.submit({ sessionId, conversationId: conv.id, operationId: 'after-current', generation: 1,
      text: '完成以后再解释', mode: 'queue', target: { unitId: 'KU-001' } });
    assert.equal(queued.status, 'queued');
    assert.equal((await core.updateAgentWork({ sessionId, taskId: queued.id, attemptId: queued.attemptId, generation: 1, action: 'activate' })).status, 'queued');
    await core.commitEdit({ sessionId, inputSeq: 1, baseRevision: c.revision, complete: true, operationId: 'student-prefix', changes: [],
      patch: { updates: [{ blockId: paragraphs[0].id, before: paragraphs[0].payload, after: { ...paragraphs[0].payload, text: '学生补充：' + paragraphs[0].payload.text } }], correspondence: [] } });
    await core.commands.protect({ sessionId, editorId: 'cross-paragraph', sequence: 2, inputSeq: 1, blockIds: [], mode: 'editing' });
    const checked = await core.commands.recheck({ sessionId });
    assert.equal(checked.find(c => c.candidateId === candidate.operationId)!.status, 'needs-reread');
    assert.equal((await core.read(sessionId)).unit.reading.blocks.find(b => b.id === paragraphs[0].id)!.payload.text, '学生补充：' + paragraphs[0].payload.text);
    assert.equal((await core.commands.query({ sessionId, operationId: candidate.operationId }))!.status, 'retained');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('default follow-up reaches the current protocol turn once, remains distinct from a new read, and queue starts only afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-steer-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  const cliPath = resolve('dist/tests/agent-executor-fixture.cjs'); await chmod(cliPath, 0o755);
  const runtime = new AgentRuntime(core, { cliPath, directory: join(root, 'executor'), env: { ...process.env, YIZHI_FIXTURE_MODE: 'steer' } });
  try {
    const { sessionId } = await core.open(join(root, 'course'));
    const c = await core.agent.create({ sessionId, operationId: 'conversation' });
    const request = { sessionId, conversationId: c.id, operationId: 'original', generation: 1, text: '解释位权', target: { unitId: 'KU-001' } };
    const first = await runtime.submit(request);
    const get = () => core.agent.get({ sessionId, conversationId: c.id });
    await until(get, v => !!v.tasks[0].turnId);
    const followup = { ...request, operationId: 'correction', text: '请用三进制的例子' };
    const steered = await runtime.submit(followup);
    assert.equal(steered.id, first.id, 'an in-flight message is not another business task');
    await runtime.submit(followup);
    const delivered = await until(get, v => v.tasks[0].deliveries?.[0]?.state === 'accepted');
    assert.equal(delivered.tasks.length, 1);
    assert.equal(delivered.messages.filter(m => m.text === followup.text).length, 1);
    assert.equal(delivered.tasks[0].deliveries![0].reviewedBasisId, undefined, 'accepted is not a new content read');
    const queued = await runtime.submit({ ...request, operationId: 'queued', mode: 'queue', text: '之后解释十进制' });
    assert.equal(queued.status, 'queued');
    assert.deepEqual(queued.blockedBy, [first.id]);
    const done = await until(get, v => v.tasks.length === 2 && v.tasks.every(t => t.status === 'completed'));
    assert.match(done.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n'), /三进制/);
    assert.notEqual(done.tasks[0].turnId, done.tasks[1].turnId);
    assert.equal(done.tasks[0].deliveries![0].turnId, done.tasks[0].turnId);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});


test('failed steering is visible and exact delivery retry does not create another request or task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-steer-retry-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new AgentRuntime(core, { cliPath: resolve('dist/tests/agent-executor-fixture.cjs'), directory: join(root, 'executor'), env: { ...process.env, YIZHI_FIXTURE_MODE: 'steer-retry' } });
  try {
    const { sessionId } = await core.open(join(root, 'course'));
    const c = await core.agent.create({ sessionId, operationId: 'conversation' });
    const original = await runtime.submit({ sessionId, conversationId: c.id, operationId: 'first', generation: 1, text: '解释位权', target: { unitId: 'KU-001' } });
    const get = () => core.agent.get({ sessionId, conversationId: c.id });
    await until(get, v => !!v.tasks[0].turnId);
    await runtime.submit({ sessionId, conversationId: c.id, operationId: 'steer', generation: 1, text: '更正：使用三进制', target: { unitId: 'KU-001' } });
    const failed = (await until(get, v => v.tasks[0].deliveries?.[0]?.state === 'failed')).tasks[0].deliveries![0];
    assert.match(failed.error!, /not accepted/); assert.equal(failed.reviewedBasisId, undefined);
    await runtime.retryDelivery({ sessionId, taskId: original.id, deliveryId: failed.id });
    const accepted = (await until(get, v => v.tasks[0].deliveries?.[0]?.state === 'accepted'));
    assert.equal(accepted.tasks.length, 1); assert.equal(accepted.messages.filter(m => m.role === 'user').length, 2);
    assert.equal(accepted.tasks[0].deliveries!.length, 1); assert.equal(accepted.tasks[0].deliveries![0].id, failed.id);
    await runtime.retryDelivery({ sessionId, taskId: original.id, deliveryId: failed.id });
    assert.equal((await get()).tasks[0].deliveries!.length, 1);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('explicit guidance can reopen unfinished conflict handling without bypassing protected writes or starting the queue', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-conflict-guidance-')), core=new CourseService(resolve('dist/worker.cjs'));
  try {
    const c=await core.open(root),sessionId=c.sessionId,a=c.unit.reading.blocks.find(b=>b.kind==='paragraph')!;
    const conv=await core.agent.create({sessionId,operationId:'conversation'});
    const task=await core.agent.submit({sessionId,conversationId:conv.id,generation:1,operationId:'original',intent:'modify',target:{unitId:'KU-001'},text:'改写首段'});
    const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1};
    const basis=await core.readAgentMutation(identity);
    await core.commands.protect({sessionId,editorId:'caret',sequence:1,inputSeq:0,blockIds:[a.id],mode:'editing'});
    const old=await core.applyAgentMutation({...identity,input:{basisId:basis.basisId,operationId:'candidate',conclusionOrMethodChanged:false,updates:[{blockId:a.id,text:'Agent建议替换全文。'}]}});
    await core.commitEdit({sessionId,operationId:'student',inputSeq:1,baseRevision:c.revision,complete:true,changes:[{blockId:a.id,text:'学生的另一种解释。'}]});
    await core.recordAgent({...identity,eventId:'ended',kind:'finish',status:'completed'});
    await core.agent.submit({sessionId,conversationId:conv.id,generation:1,operationId:'clarification',intent:'modify',target:{unitId:'KU-001'},text:'保留学生解释，把Agent内容另加一句。'});
    const resumed=await core.updateAgentWork({...identity,action:'integrate'});
    assert.equal(resumed.status,'running'); assert.equal(resumed.attemptId,task.attemptId);
    const fresh=await core.readAgentMutation(identity);
    const stillProtected=await core.applyAgentMutation({...identity,input:{basisId:fresh.basisId,operationId:'integrated',conclusionOrMethodChanged:false,replaces:[old.operationId],updates:[{blockId:a.id,text:'学生的另一种解释。Agent建议替换全文。'}]}});
    assert.equal(stillProtected.status,'retained');
    assert.equal((await core.read(sessionId)).unit.reading.blocks.find(b=>b.id===a.id)!.payload.text,'学生的另一种解释。');
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});

test('Agent can route an explicit new-target guidance to one independently authorized task without retargeting the original or losing an unsent draft', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-new-guidance-')),core=new CourseService(resolve('dist/worker.cjs'));
  try {
    const {sessionId}=await core.open(root),conv=await core.agent.create({sessionId,operationId:'conversation'});
    const original=await core.agent.submit({sessionId,conversationId:conv.id,generation:1,operationId:'original',text:'解释位权',target:{unitId:'KU-001'}});
    const identity={sessionId,taskId:original.id,attemptId:original.attemptId,generation:1};
    const guided=await core.agent.submit({sessionId,conversationId:conv.id,generation:1,operationId:'new-matter',intent:'modify',text:'新事项：改写这个MUX单元的首段',target:{unitId:'KU-057'}});
    assert.equal(guided.id,original.id);assert.equal(guided.snapshot.target.unitId,'KU-001');
    const deliveryId=guided.deliveries![0].id;
    await core.agent.saveDraft({sessionId,conversationId:conv.id,seq:1,text:'尚未发送，不可清空'});
    const child=await core.queueAgentGuidance({...identity,deliveryId});
    assert.equal(child.status,'queued');assert.equal(child.snapshot.target.unitId,'KU-057');assert.equal(child.snapshot.intent,'modify');
    assert.equal((await core.queueAgentGuidance({...identity,deliveryId})).id,child.id);
    const conversation=await core.agent.get({sessionId,conversationId:conv.id});
    assert.equal(conversation.tasks.length,2);assert.equal(conversation.messages.filter(m=>m.role==='user').length,2);
    assert.equal(conversation.draft.text,'尚未发送，不可清空');
    await assert.rejects(core.readAgentMutation(identity),/明确修改/);
    await core.recordAgent({...identity,eventId:'done',kind:'finish',status:'completed'});
    const next={sessionId,taskId:child.id,attemptId:child.attemptId,generation:1};
    await core.updateAgentWork({...next,action:'activate'});
    assert.equal((await core.readAgentMutation(next)).unitId,'KU-057');
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});
