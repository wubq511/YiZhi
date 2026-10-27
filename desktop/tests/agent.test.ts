import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('course conversations retain separate composer drafts and fixed submitted targets across core reopen without board changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await core.open(root), sessionId = opened.sessionId;
    const first = await core.agent.create({ sessionId, operationId: 'conversation-first' });
    await core.agent.saveDraft({ sessionId, conversationId: first.id, seq: 1, text: '为什么位置改变值？' });
    const second = await core.agent.create({ sessionId, operationId: 'conversation-second' });
    await core.agent.saveDraft({ sessionId, conversationId: second.id, seq: 1, text: '稍后继续的问题', target: { unitId: 'KU-001', blockId: opened.editableBlockId, selectedText: '位置记数法' } });
    const request = { sessionId, conversationId: first.id, operationId: 'question-first', generation: 1,
      text: '为什么位置改变值？', target: { unitId: 'KU-001', blockId: opened.editableBlockId, selectedText: '位置记数法' } };
    const task = await core.agent.submit(request);
    assert.equal(task.snapshot.target.selectedText, '位置记数法');
    assert.equal(task.snapshot.target.unitId, 'KU-001');
    assert.equal(task.snapshot.text, request.text);
    assert.deepEqual(await core.agent.submit(request), task);
    await assert.rejects(core.agent.submit({ ...request, text: 'different request' }), /不同内容/);
    assert.deepEqual((await core.read(sessionId)).unit, opened.unit);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(root);
    const saved = await core.agent.get({ sessionId: reopened.sessionId, conversationId: first.id });
    assert.equal(saved.messages.length, 1);
    assert.equal(saved.messages[0].text, request.text);
    assert.equal(saved.tasks[0].status, 'unknown');
    assert.equal((await core.agent.get({ sessionId: reopened.sessionId, conversationId: second.id })).draft.text, '稍后继续的问题');
    assert.equal((await core.agent.get({ sessionId: reopened.sessionId, conversationId: second.id })).draft.target?.selectedText, '位置记数法');
    assert.deepEqual((await core.read(reopened.sessionId)).unit, opened.unit);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

import { chmod } from 'node:fs/promises';
import { AgentRuntime, detectExecutor } from '../src/agent/executor';
import { DatabaseSync } from 'node:sqlite';
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  for (let n = 0; n < 150; n++) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for durable executor result');
}

test('host app-server handles async real course tool reads while core stays responsive; item completion and late deltas never duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-protocol-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  const cliPath = resolve('dist/tests/agent-executor-fixture.cjs'); await chmod(cliPath, 0o755);
  const runtime = new AgentRuntime(core, { cliPath, directory: join(root, 'executor') });
  try {
    const opened = await core.open(join(root, 'course')), sessionId = opened.sessionId;
    const status = await runtime.status(); assert.equal(status.available, true, status.error);
    const conversation = await core.agent.create({ sessionId, operationId: 'create' });
    const task = await runtime.submit({ sessionId, operationId: 'submit', conversationId: conversation.id, generation: 1,
      text: '解释位权', target: { unitId: 'KU-001' } });
    const received = await until(() => core.agent.get({ sessionId, conversationId: conversation.id }), v => v.messages.some(m => m.state === 'streaming') || v.tasks[0].status !== 'running');
    assert.equal(received.tasks[0].status, 'running');
    assert.deepEqual((await core.read(sessionId)).unit, opened.unit);
    const complete = await until(() => core.agent.get({ sessionId, conversationId: conversation.id }), v => v.tasks[0].status === 'completed');
    assert.equal(complete.messages.filter(m => m.role === 'assistant').length, 1);
    assert.equal(complete.messages[1].text, '课程依据：位置的权决定数值。\n补充解释：例如 22 的两个 2 分别表示 20 和 2。');
    assert.equal(complete.messages[1].state, 'complete');
    assert.ok(complete.tasks[0].threadId); assert.ok(complete.tasks[0].turnId);
    assert.equal(complete.tasks[0].attemptId, task.attemptId);
    assert.deepEqual(complete.toolFacts.map(f => f.name), ['yizhi_read_target']);
    assert.equal(complete.toolFacts[0].hasRecoveryPayload, false);
    assert.equal(complete.toolFacts[0].purpose, 'result-fact');
    assert.deepEqual((await core.read(sessionId)).unit, opened.unit);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['disconnect', 'malformed', 'failed', 'tool-error']) test(`protocol ${mode} retains exact partial/error facts and never changes course content`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-failure-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new AgentRuntime(core, { cliPath: resolve('dist/tests/agent-executor-fixture.cjs'), directory: join(root, 'executor'), env: { ...process.env, YIZHI_FIXTURE_MODE: mode } });
  try {
    const opened = await core.open(join(root, 'course')), sessionId = opened.sessionId;
    const conversation = await core.agent.create({ sessionId, operationId: 'create' });
    await runtime.submit({ sessionId, operationId: 'submit', generation: 1, conversationId: conversation.id, text: '只读', target: { unitId: 'KU-001' } });
    const result = await until(() => core.agent.get({ sessionId, conversationId: conversation.id }), v => v.tasks[0].status !== 'running');
    assert.equal(result.tasks[0].status, mode === 'failed' ? 'failed' : mode === 'tool-error' ? 'completed' : 'unknown');
    assert.ok(result.messages[1].text.startsWith('课程依据：位置的权决定数值。'));
    assert.equal(result.messages[1].state, mode === 'tool-error' ? 'complete' : 'partial');
    if (mode === 'failed') assert.match(result.tasks[0].error!, /provider failed precisely/);
    if (mode === 'malformed') assert.match(result.tasks[0].error!, /协议错误/);
    if (mode === 'disconnect') assert.match(result.tasks[0].error!, /17/);
    const task = result.tasks[0];
    await assert.rejects(core.recordAgent({ sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'late', kind: 'message', itemId: 'answer', text: 'late overwrite' }), /停止或失效/);
    await runtime.close(); await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(join(root, 'course'));
    const durable = await core.agent.get({ sessionId: reopened.sessionId, conversationId: conversation.id });
    assert.deepEqual(durable.messages, result.messages);
    assert.deepEqual((await core.read(reopened.sessionId)).unit, opened.unit);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed durable registration creates no ghost request and operation/generation/attempt/thread fences reject cross-domain or late work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-fences-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  let fault: DatabaseSync | undefined;
  try {
    const opened = await core.open(root), sessionId = opened.sessionId;
    const conversation = await core.agent.create({ sessionId, operationId: 'conversation' });
    await core.agent.saveDraft({ sessionId, conversationId: conversation.id, seq: 1, text: '原问题草稿' });
    const question = { sessionId, operationId: 'question', generation: 1, conversationId: conversation.id, text: '原问题草稿', target: { unitId: 'KU-001' } };
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_task BEFORE INSERT ON agent_tasks BEGIN SELECT RAISE(ABORT,'task disk fault'); END");
    await assert.rejects(core.agent.submit(question), /task disk fault/);
    const empty = await core.agent.get({ sessionId, conversationId: conversation.id });
    assert.equal(empty.tasks.length, 0); assert.equal(empty.messages.length, 0); assert.equal(empty.draft.text, question.text);
    fault.exec('DROP TRIGGER fail_task');
    const task = await core.agent.submit(question);
    await assert.rejects(core.save({ sessionId, operationId: 'question', inputSeq: 1, baseRevision: 1, blockId: opened.editableBlockId, text: 'No' }), /操作身份/);
    await assert.rejects(core.agent.submit({ ...question, operationId: 'stale-generation', generation: 2 }), /代际/);
    const event = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'binding', kind: 'bind' as const, threadId: 'thread', turnId: 'turn' };
    await core.recordAgent(event); await core.recordAgent(event);
    await assert.rejects(core.recordAgent({ ...event, threadId: 'different-thread' }), /身份冲突/);
    await assert.rejects(core.recordAgent({ ...event, eventId: 'wrong-thread', threadId: 'different-thread' }), /thread\/turn/);
    await core.commands.stop({ sessionId, attemptId: task.attemptId });
    await assert.rejects(core.recordAgent({ ...event, eventId: 'after-stop', kind: 'delta', itemId: 'x', text: 'No' }), /停止或失效/);
    const saved = await core.save({ sessionId, operationId: 'student-save', inputSeq: 1, baseRevision: 1, blockId: opened.editableBlockId, text: 'student text' });
    await assert.rejects(core.agent.create({ sessionId, operationId: saved.operationId }), /操作身份/);
    await assert.rejects(core.parsing.start({ sessionId, generation: 1, operationId: 'parser-reservation', versionId: 'missing-source' }), /未登记/);
    await assert.rejects(core.agent.create({ sessionId, operationId: 'parser-reservation' }), /操作身份/);
    await assert.rejects(core.parsing.start({ sessionId, generation: 1, operationId: 'question', versionId: 'missing-source' }), /操作身份/);
  } finally { fault?.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('missing executable disables only generation and reduced launch PATH still detects the installed CLI without credential copies', async () => {
  const absent = await detectExecutor({ cliPath: join(tmpdir(), 'nonexistent-yizhi-codex') });
  assert.equal(absent.available, false); assert.match(absent.error!, /未找到/);
  const status = await detectExecutor({ cliPath: resolve('dist/tests/agent-executor-fixture.cjs'), env: { ...process.env, PATH: '/usr/bin:/bin' } });
  assert.equal(status.available, true, status.error);
  const incapable = await detectExecutor({ cliPath: resolve('dist/tests/agent-executor-fixture.cjs'), env: { ...process.env, YIZHI_FIXTURE_MODE: 'incapable' } });
  assert.equal(incapable.available, false); assert.match(incapable.error!, /协议能力/);
});

test('interleaved message items retain first-seen order and completion replaces only its own received partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-items-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId } = await core.open(root), conversation = await core.agent.create({ sessionId, operationId: 'c' });
    const task = await core.agent.submit({ sessionId, conversationId: conversation.id, operationId: 'q', generation: 1, text: 'read', target: { unitId: 'KU-001' } });
    const event = { sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1 };
    await core.recordAgent({ ...event, eventId: '1', kind: 'delta', itemId: 'commentary', text: 'first' });
    await core.recordAgent({ ...event, eventId: '2', kind: 'delta', itemId: 'answer', text: 'second' });
    await core.recordAgent({ ...event, eventId: '3', kind: 'message', itemId: 'commentary', text: 'first complete' });
    const view = await core.agent.get({ sessionId, conversationId: conversation.id });
    assert.deepEqual(view.messages.map(m => m.text), ['read', 'first complete', 'second']);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('host shutdown drains accepted question registration and leaves no running ghost attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-quit-')); const core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new AgentRuntime(core, { cliPath: resolve('dist/tests/agent-executor-fixture.cjs'), directory: join(root, 'runtime') });
  try {
    const { sessionId } = await core.open(join(root, 'course')); const c = await core.agent.create({ sessionId, operationId: 'c' });
    await runtime.status();
    // Delay only the public Core reply after its real Worker/SQLite registration.
    const originalSubmit = core.agent.submit; let registered!: () => void, release!: () => void;
    const durable = new Promise<void>(resolve => { registered = resolve; });
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    core.agent.submit = async request => { const task = await originalSubmit(request); registered(); await acknowledgement; return task; };
    const submitting = runtime.submit({ sessionId, conversationId: c.id, operationId: 'q', generation: 1, text: 'close while registering', target: { unitId: 'KU-001' } });
    await durable; const closing = runtime.close();
    const outcome = await Promise.race([closing.then(() => 'closed'), new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 100))]);
    release(); await Promise.allSettled([submitting, closing]);
    assert.equal(outcome, 'waiting', 'host must drain a durably registered question whose acknowledgement is still pending');
    const result = await core.agent.get({ sessionId, conversationId: c.id });
    assert.ok(result.tasks.every(task => task.status !== 'running'));
    assert.equal(await core.commands.history({ sessionId }).then(h => h.length), 0);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('mutation protocol exposes actual grouped receipts and partial status; a later QA uses a distinct ephemeral read-only thread',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-mutation-rpc-')),core=new CourseService(resolve('dist/worker.cjs'));
 const runtime=new AgentRuntime(core,{cliPath:resolve('dist/tests/agent-executor-fixture.cjs'),directory:join(root,'runtime'),env:{...process.env,YIZHI_FIXTURE_MODE:'mutation'}});
 try{
  const c=await core.open(join(root,'course')),sessionId=c.sessionId,conv=await core.agent.create({sessionId,operationId:'create'});
  await runtime.submit({sessionId,conversationId:conv.id,operationId:'explicit-modify',generation:1,intent:'modify',text:'受控协议修改',target:{unitId:'KU-001'}});
  const done=await until(()=>core.agent.get({sessionId,conversationId:conv.id}),v=>v.tasks[0].status!=='running');
  assert.equal(done.tasks[0].status,'partial');assert.ok(done.messages.filter(m=>m.role==='assistant').every(m=>m.state==='complete'));assert.deepEqual(done.tasks[0].groups!.map(g=>g.status),['committed','retained']);assert.ok(done.toolFacts.every(f=>!f.hasRecoveryPayload));
  const saved=(await core.read(sessionId)).unit;
  await runtime.submit({sessionId,conversationId:conv.id,operationId:'ordinary-qa',generation:1,text:'只读解释',target:{unitId:'KU-001'}});
  const qa=await until(()=>core.agent.get({sessionId,conversationId:conv.id}),v=>v.tasks.length===2&&v.tasks[1].status!=='running');
  assert.equal(qa.tasks[1].status,'completed');assert.notEqual(qa.tasks[0].threadId,qa.tasks[1].threadId);assert.deepEqual((await core.read(sessionId)).unit,saved);
 }finally{await runtime.close();await core.close();await rm(root,{recursive:true,force:true});}
});
