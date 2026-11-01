import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { AgentRuntime } from '../src/agent/executor';

const fixture = resolve('dist/tests/agent-executor-fixture.cjs');
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  for (let n = 0; n < 200; n++) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Timed out waiting for durable executor result');
}
async function harness(t: { reasoning?: 'summary' | 'content'; mode?: string }) {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-reasoning-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  await chmod(fixture, 0o755);
  const nudges: string[] = [];
  const runtime = new AgentRuntime(core, { cliPath: fixture, directory: join(root, 'executor'),
    env: { ...process.env, ...(t.reasoning ? { YIZHI_FIXTURE_REASONING: t.reasoning === 'content' ? 'content' : '1' } : {}), ...(t.mode ? { YIZHI_FIXTURE_MODE: t.mode } : {}) },
    notify: sessionId => nudges.push(sessionId) });
  const opened = await core.open(join(root, 'course')), sessionId = opened.sessionId;
  const conversation = await core.agent.create({ sessionId, operationId: 'create' });
  return { core, runtime, sessionId, conversationId: conversation.id, nudges,
    cleanup: async () => { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); } };
}

test('reasoning summaries stream, close, survive reopen, and are not destroyed by the recovery-payload clearing', async () => {
  const h = await harness({ reasoning: 'summary' });
  try {
    assert.equal((await h.runtime.status()).supportsReasoning, true);
    await h.runtime.submit({ sessionId: h.sessionId, operationId: 'submit', conversationId: h.conversationId, generation: 1, text: '解释位权', target: { unitId: 'KU-001' } });
    const streaming = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }),
      v => v.reasonings.some(r => r.state === 'streaming'));
    assert.equal(streaming.reasonings.length, 1);
    assert.equal(streaming.reasonings[0].state, 'streaming');
    assert.match(streaming.reasonings[0].text, /^先读单元正文/);
    const done = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }), v => v.tasks[0].status === 'completed');
    // The completed item replaces the streamed prefix with the real summary, echoing the params the host actually sent.
    assert.equal(done.reasonings[0].state, 'complete');
    assert.match(done.reasonings[0].text, /^先读单元正文，再按位权展开。effort=medium summary=detailed$/);
    assert.ok(h.nudges.length > 0, 'every applied executor event must nudge its own session');
    // finish() nulls recovery payloads for tool facts; reasoning is a projection of its own and must remain.
    assert.ok((await h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId })).reasonings[0].text.length > 0);
    assert.ok(done.toolFacts.length > 0);
    assert.equal(done.toolFacts.every(f => f.purpose === 'result-fact'), true);
  } finally { await h.cleanup(); }
});

test('a completed reasoning item carrying no summary text never wipes the streamed text', async () => {
  for (const mode of ['reasoning-empty', 'reasoning-unclosed']) {
    const h = await harness({ reasoning: 'summary', mode });
    try {
      await h.runtime.submit({ sessionId: h.sessionId, operationId: 'submit', conversationId: h.conversationId, generation: 1, text: '解释位权', target: { unitId: 'KU-001' } });
      const done = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }), v => ['completed', 'failed'].includes(v.tasks[0].status));
      assert.equal(done.reasonings.length, 1, mode);
      assert.equal(done.reasonings[0].state, 'partial', mode);
      assert.equal(done.reasonings[0].text, '先读单元正文，再按位权展开', mode);
    } finally { await h.cleanup(); }
  }
});

test('reasoning effort is validated against the model catalog and threaded to turn/start', async () => {
  const h = await harness({ reasoning: 'summary' });
  try {
    const status = await h.runtime.status();
    const model = status.models.find(m => m.model === 'fixture')!;
    assert.deepEqual(model.supportedReasoningEfforts?.map(e => e.effort), ['low', 'medium', 'high']);
    await assert.rejects(h.runtime.submit({ sessionId: h.sessionId, operationId: 'bogus', conversationId: h.conversationId, generation: 1,
      text: '解释位权', target: { unitId: 'KU-001' }, reasoningEffort: 'ludicrous' }), /实际申报/);
    await h.runtime.submit({ sessionId: h.sessionId, operationId: 'submit', conversationId: h.conversationId, generation: 1,
      text: '解释位权', target: { unitId: 'KU-001' }, reasoningEffort: 'high' });
    const done = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }), v => v.tasks[0].status === 'completed');
    assert.equal(done.tasks[0].reasoningEffort, 'high');
    assert.match(done.reasonings[0].text, /effort=high/);
  } finally { await h.cleanup(); }
});

test('open-source models streaming raw reasoning content instead of a summary are captured too', async () => {
  const h = await harness({ reasoning: 'content' });
  try {
    await h.runtime.submit({ sessionId: h.sessionId, operationId: 'submit', conversationId: h.conversationId, generation: 1, text: '解释位权', target: { unitId: 'KU-001' } });
    const streaming = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }),
      v => v.reasonings.some(r => r.state === 'streaming'));
    assert.match(streaming.reasonings[0].text, /^先读单元正文/);
    const done = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }), v => v.tasks[0].status === 'completed');
    // The completed item carries the chain in `content` with an empty `summary`; reading only the summary lost the entire stream.
    assert.equal(done.reasonings[0].state, 'complete');
    assert.match(done.reasonings[0].text, /summary=detailed$/);
  } finally { await h.cleanup(); }
});

test('an executor whose schema lacks reasoning stays usable and simply never shows thinking', async () => {
  const h = await harness({});
  try {
    assert.equal((await h.runtime.status()).supportsReasoning, false);
    await h.runtime.submit({ sessionId: h.sessionId, operationId: 'submit', conversationId: h.conversationId, generation: 1, text: '解释位权', target: { unitId: 'KU-001' } });
    const done = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }), v => v.tasks[0].status === 'completed');
    assert.deepEqual(done.reasonings, []);
    assert.ok(done.messages.some(m => m.role === 'assistant' && m.state === 'complete'));
  } finally { await h.cleanup(); }
});

test('reasoning arrivals advance the shared event cursor so the panel can pull instead of refetching', async () => {
  const h = await harness({ reasoning: 'summary' });
  try {
    await h.runtime.submit({ sessionId: h.sessionId, operationId: 'submit', conversationId: h.conversationId, generation: 1, text: '解释位权', target: { unitId: 'KU-001' } });
    const streaming = await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }),
      v => v.reasonings.some(r => r.state === 'streaming'));
    const first = await h.core.readEvents(h.sessionId, 0, 128);
    assert.equal(first.kind, 'events');
    if (first.kind !== 'events') throw new Error('unreachable');
    const changed = first.events.filter(e => e.type === 'agent.changed' && e.conversationId === h.conversationId);
    assert.ok(changed.length >= 2, 'streaming must produce more than one cursor position');
    assert.ok(first.cursor >= changed.at(-1)!.cursor);
    await until(() => h.core.agent.get({ sessionId: h.sessionId, conversationId: h.conversationId }), v => v.tasks[0].status === 'completed');
    const next = await h.core.readEvents(h.sessionId, first.cursor, 128);
    assert.equal(next.kind, 'events');
    if (next.kind !== 'events') throw new Error('unreachable');
    assert.ok(next.cursor > first.cursor);
    assert.ok(streaming.reasonings.length === 1);
  } finally { await h.cleanup(); }
});
