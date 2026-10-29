import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { AgentRuntime } from '../src/agent/executor';

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  for (let n = 0; n < 250; n++) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Working task did not reach the required lifecycle state');
}

for (const quit of [false, true]) test(`${quit ? 'quit' : 'stop'} fences protected automatic integration and queued work without erasing the known completed turn`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-working-stop-')), core = new CourseService(resolve('dist/worker.cjs'));
  const cliPath = resolve('dist/tests/agent-executor-fixture.cjs'); await chmod(cliPath, 0o755);
  const runtime = new AgentRuntime(core, { cliPath, directory: join(root, 'runtime'), env: { ...process.env, YIZHI_FIXTURE_MODE: 'coedit' } });
  try {
    const c = await core.open(join(root, 'course')), sessionId = c.sessionId, paragraph = c.unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const conversation = await core.agent.create({ sessionId, operationId: 'conversation' });
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 1, inputSeq: 0, blockIds: [paragraph.id], mode: 'editing' });
    const original = await runtime.submit({ sessionId, conversationId: conversation.id, generation: 1, operationId: 'modify', intent: 'modify', text: '补充首段', target: { unitId: 'KU-001' } });
    const get = () => core.agent.get({ sessionId, conversationId: conversation.id });
    const held = await until(get, v => v.tasks[0].status === 'waiting');
    assert.equal(held.tasks[0].executorStatus, 'completed');
    const queued = await runtime.submit({ sessionId, conversationId: conversation.id, generation: 1, operationId: 'queued', mode: 'queue', text: '之后解释', target: { unitId: 'KU-001' } });
    assert.equal(queued.status, 'queued');
    if (quit) { await runtime.prepareQuit(); await runtime.close(); }
    else { await runtime.stop({ sessionId, taskId: queued.id }); await runtime.stop({ sessionId, taskId: original.id }); }
    const stopped = await until(get, v => v.tasks.every(t => t.status === 'stopped'));
    assert.equal(stopped.tasks[0].executorStatus, 'completed');
    assert.equal(stopped.tasks[1].turnId, null);
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 2, inputSeq: 0, blockIds: [], mode: 'editing' });
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await get()).tasks[0].turnHistory?.length ?? 0, 0);
    assert.equal((await core.read(sessionId)).unit.reading.blocks.find(b => b.id === paragraph.id)!.payload.text, paragraph.payload.text);
    assert.equal((await core.commands.query({ sessionId, operationId: held.tasks[0].groups![0].operationId }))!.status, 'retained');
    await assert.rejects(core.activeAgent({ sessionId, taskId: original.id, attemptId: original.attemptId, generation: 1 }), /停止|失效/);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('reopen preserves a waiting task known executor completion and never reports an unstarted queued turn as an unknown external call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-working-reopen-')); let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId, paragraph = c.unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const conversation = await core.agent.create({ sessionId, operationId: 'conversation' });
    const task = await core.agent.submit({ sessionId, conversationId: conversation.id, generation: 1, operationId: 'modify', intent: 'modify', text: '补充首段', target: { unitId: 'KU-001' } });
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1 };
    await core.commands.protect({ sessionId, editorId: 'caret', sequence: 1, inputSeq: 0, blockIds: [paragraph.id], mode: 'editing' });
    const basis = await core.readAgentMutation(identity);
    const retained = await core.applyAgentMutation({ ...identity, input: { operationId: 'retained', basisId: basis.basisId, conclusionOrMethodChanged: false, updates: [{ blockId: paragraph.id, text: '尚未整合的建议' }] } });
    await core.recordAgent({ ...identity, eventId: 'done', kind: 'finish', status: 'completed' });
    await core.agent.submit({ sessionId, conversationId: conversation.id, generation: 1, operationId: 'queued', mode: 'queue', text: '之后解释', target: { unitId: 'KU-001' } });
    await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(root), view = await core.agent.get({ sessionId: reopened.sessionId, conversationId: conversation.id });
    assert.equal(view.tasks[0].executorStatus, 'completed');
    assert.equal(view.tasks[0].status, 'pending');
    assert.equal(view.tasks[1].status, 'interrupted');
    assert.equal(view.tasks[1].threadId, null);
    assert.equal(view.tasks[1].turnId, null);
    assert.deepEqual(await core.commands.query({ sessionId: reopened.sessionId, operationId: retained.operationId }), retained);
    await assert.rejects(core.activeAgent({ ...identity, sessionId: reopened.sessionId }), /停止|失效/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('guidance admitted just before model completion remains unfinished until the same task actually receives it in a fresh turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-late-guidance-')), core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId } = await core.open(root), conversation = await core.agent.create({ sessionId, operationId: 'conversation' });
    const task = await core.agent.submit({ sessionId, conversationId: conversation.id, generation: 1, operationId: 'question', text: '解释位权', target: { unitId: 'KU-001' } });
    const identity = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1 };
    await core.recordAgent({ ...identity, eventId: 'bind', kind: 'bind', threadId: 'original', turnId: 'first' });
    const steered = await core.agent.submit({ sessionId, conversationId: conversation.id, generation: 1, operationId: 'correction', text: '请使用三进制解释', target: { unitId: 'KU-001' } });
    assert.equal(steered.id, task.id);
    const ended = await core.recordAgent({ ...identity, eventId: 'end-first', kind: 'finish', status: 'completed', threadId: 'original', turnId: 'first' });
    assert.equal(ended.status, 'waiting');
    const next = await core.updateAgentWork({ ...identity, action: 'integrate' });
    assert.equal(next.status, 'running'); assert.equal(next.attemptId, task.attemptId);
    await assert.rejects(core.recordAgent({ ...identity, eventId: 'late-old', kind: 'message', threadId: 'original', turnId: 'first', itemId: 'old', text: '旧尾部' }), /旧模型轮次/);
    await core.recordAgent({ ...identity, eventId: 'bind-new', kind: 'bind', threadId: 'original', turnId: 'second' });
    await core.updateAgentWork({ ...identity, action: 'delivery', deliveryId: steered.deliveries![0].id, state: 'accepted', threadId: 'original', turnId: 'second' });
    const done = await core.recordAgent({ ...identity, eventId: 'end-new', kind: 'finish', status: 'completed', threadId: 'original', turnId: 'second' });
    assert.equal(done.status, 'completed');
    const view = await core.agent.get({ sessionId, conversationId: conversation.id });
    assert.equal(view.tasks.length, 1); assert.equal(view.messages.filter(m => m.role === 'user').length, 2);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
