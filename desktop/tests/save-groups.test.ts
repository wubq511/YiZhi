import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ParagraphSaveChannel } from '../src/renderer/save-channel';
import { CourseService } from '../src/core/course-service';
const a = 'RB-TH-01-01-what-is-positional-notation', b = 'RB-TH-01-03-expansion-terms';
async function fixture(run: (s: CourseService, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-save-groups-'));
  const s = new CourseService(resolve('dist/worker.cjs'));
  try { await run(s, root); } finally { await s.close(); await rm(root, { recursive: true, force: true }); }
}

test('producer retains same-target and read-prerequisite drafts while an independent student draft survives a group', async () => {
  await fixture(async (s, root) => {
    const opened = await s.open(root), sessionId = opened.sessionId;
    const attempt = await s.commands.startAttempt({ sessionId, taskId: 'draft-guards' });
    const read = (objectIds: string[]) => s.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds });
    const relations = await read([a, b, 'dependency:draft-guard']);
    await s.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId: 'add-read-prerequisite',
      basisId: relations.basisId, changes: [{ objectId: 'dependency:draft-guard',
        value: { sourceBlockId: a, dependentBlockId: b, status: 'current' } }] });
    const c = 'RB-TH-01-08-example-26-75-ans';
    const same = await read([a]), prerequisite = await read([b]), independent = await read([c]);
    assert.ok(prerequisite.objects.some(object => object.id === a), 'the core expands the actual prerequisite closure');
    const draft = { sessionId, inputSeq: 1, baseRevision: 2, complete: false, changes: [{ blockId: a, text: '尚未提交的前提' }] };
    await s.saveDraft(draft);
    const commit = (basis: Awaited<ReturnType<typeof read>>, id: string, target: string) => {
      const before = basis.objects.find(o => o.id === target)!.value;
      return s.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId: id, basisId: basis.basisId,
        changes: [{ objectId: target, value: { ...before, payload: { ...before.payload, text: `生产者${id}` } } }] });
    };
    assert.equal((await commit(same, 'same-target', a)).status, 'retained');
    assert.equal((await commit(prerequisite, 'read-draft', b)).status, 'retained');
    const reread = await commit(await read([b]), 'cannot-relabel-active-draft', b);
    assert.equal(reread.status, 'retained');
    assert.match(reread.reason!, /存在学生草稿/);
    assert.equal((await commit(independent, 'independent', c)).status, 'committed');
    const current = await s.read(sessionId);
    assert.deepEqual(current.drafts[0].input, draft);
    assert.equal(current.confirmedInputSeq, 0);
    assert.equal((await s.commands.candidates({ sessionId })).length, 3);
  });
});

test('split drafts guard shared sibling structure, and ordinary drafts guard a producer structure reorder', async () => {
  await fixture(async (s, root) => {
    const opened = await s.open(root), sessionId = opened.sessionId;
    const attempt = await s.commands.startAttempt({ sessionId, taskId: 'draft-structure' });
    const read = (objectIds: string[]) => s.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds });
    const sibling = await read([b]);
    await s.saveDraft({ sessionId, inputSeq: 1, baseRevision: 1, complete: false,
      changes: [{ blockId: a, text: '拆分尚未晋升' }], splits: [{ blockId: a, newBlockId: 'pending-new-id', offset: 2 }] });
    const value = sibling.objects.find(o => o.id === b)!.value;
    assert.equal((await s.commands.commit({ sessionId, attemptId: attempt.attemptId,
      operationId: 'shared-split', basisId: sibling.basisId,
      changes: [{ objectId: b, value: { ...value, payload: { ...value.payload, text: '基于旧共享结构的候选' } } }] })).status, 'retained');
    const structure = await read(['structure:KU-001']);
    await s.saveDraft({ sessionId, inputSeq: 2, baseRevision: 1, complete: false,
      changes: [{ blockId: a, text: '未拆分但仍在输入' }] });
    assert.equal((await s.commands.commit({ sessionId, attemptId: attempt.attemptId,
      operationId: 'reorder-with-draft', basisId: structure.basisId,
      changes: [{ objectId: 'structure:KU-001', value: { blockIds: opened.unit.reading.blocks.map(o => o.id).reverse() } }] })).status, 'retained');
    assert.deepEqual((await s.read(sessionId)).unit, opened.unit);
  });
});

test('student formal A-to-B-to-A and transient draft A-to-B-to-A cannot revive a producer read token', async () => {
  await fixture(async (s, root) => {
    const opened = await s.open(root), sessionId = opened.sessionId;
    const attempt = await s.commands.startAttempt({ sessionId, taskId: 'draft-aba' });
    const read = () => s.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds: [a, b] });
    const basis = await read();
    const original = String(opened.unit.reading.blocks[0].payload.text);
    const input = { sessionId, inputSeq: 1, baseRevision: 1, complete: true, changes: [{ blockId: a, text: '临时正式值 B' }] };
    await s.commitEdit({ ...input, operationId: 'formal-away' });
    await s.commitEdit({ ...input, inputSeq: 2, baseRevision: 2, changes: [{ blockId: a, text: original }], operationId: 'formal-back' });
    const commit = (token: Awaited<ReturnType<typeof read>>, operationId: string) => {
      const before = token.objects.find(o => o.id === b)!.value;
      return s.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId, basisId: token.basisId,
        changes: [{ objectId: b, value: { ...before, payload: { ...before.payload, text: operationId } } }] });
    };
    assert.equal((await commit(basis, 'old-formal-token')).status, 'retained');
    const beforeDraft = await read();
    await s.saveDraft({ ...input, inputSeq: 3, baseRevision: 3, changes: [{ blockId: a, text: '未晋升的草稿 B' }] });
    const back = { ...input, inputSeq: 4, baseRevision: 3, changes: [{ blockId: a, text: original }] };
    await s.saveDraft(back);
    await s.commitEdit({ ...back, operationId: 'draft-back-to-original' });
    assert.equal((await s.read(sessionId)).drafts.length, 0);
    assert.equal((await commit(beforeDraft, 'old-draft-token')).status, 'retained');
    assert.equal((await commit(await read(), 'fresh-after-draft')).status, 'committed');
  });
});

test('producer events share the save cursor and actual event-insert failure rolls formal state, projection, history and receipt back', async () => {
  await fixture(async (s, root) => {
    const opened = await s.open(root), sessionId = opened.sessionId;
    const attempt = await s.commands.startAttempt({ sessionId, taskId: 'shared-events' });
    const read = () => s.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds: [b] });
    const basis = await read(), value = basis.objects.find(o => o.id === b)!.value;
    const command = { sessionId, attemptId: attempt.attemptId, operationId: 'producer-event-1', basisId: basis.basisId,
      changes: [{ objectId: b, value: { ...value, payload: { ...value.payload, text: '生产者进入共同事件流' } } }] };
    const receipt = await s.commands.commit(command);
    assert.equal(receipt.status, 'committed');
    assert.ok(Number.isSafeInteger(receipt.cursor));
    const page = await s.readEvents(sessionId, opened.eventCursor);
    assert.equal(page.kind, 'events');
    assert.deepEqual(page.events.map(e => e.type), ['group.committed']);
    assert.equal(page.events[0].cursor, receipt.cursor);
    assert.deepEqual(await s.commands.commit(command), receipt);
    assert.equal((await s.read(sessionId)).confirmedInputSeq, 0);
    const afterFirst = await s.read(sessionId);
    const next = { ...command, operationId: 'event-insert-failure', basisId: (await read()).basisId,
      changes: [{ objectId: b, value: { ...value, payload: { ...value.payload, text: '必须整组回滚' } } }] };
    const fault = new DatabaseSync(join(root, 'course.sqlite'));
    try {
      fault.exec("CREATE TRIGGER fail_save_event BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT, 'actual event insert failure'); END");
      await assert.rejects(s.commands.commit(next), /actual event insert failure/);
      assert.deepEqual(await s.read(sessionId), afterFirst);
      assert.equal(await s.commands.query({ sessionId, operationId: next.operationId }), null);
      assert.equal((await s.commands.history({ sessionId })).length, 1);
      fault.exec('DROP TRIGGER fail_save_event');
      const retried = await s.commands.commit(next);
      assert.equal(retried.status, 'committed');
      assert.ok(retried.cursor! > receipt.cursor!);
      const tail = await s.readEvents(sessionId, page.cursor);
      assert.equal(tail.kind, 'events');
      assert.equal(tail.events.length, 1);
      assert.equal(tail.events[0].type, 'group.committed');
      assert.equal((await s.commands.history({ sessionId })).length, 2);
    } finally { fault.close(); }
  });
});

test('replacing a draft on another block cannot relabel the read basis that observed its old scope', async () => {
  await fixture(async (s, root) => {
    const opened = await s.open(root), sessionId = opened.sessionId;
    const attempt = await s.commands.startAttempt({ sessionId, taskId: 'replace-draft' });
    const basis = await s.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds: [a, b] });
    await s.saveDraft({ sessionId, inputSeq: 1, baseRevision: 1, complete: false, changes: [{ blockId: a, text: '输入曾经过 A' }] });
    await s.saveDraft({ sessionId, inputSeq: 2, baseRevision: 1, complete: false,
      changes: [{ blockId: 'RB-TH-01-08-example-26-75-ans', text: '现在的独立草稿' }] });
    const before = basis.objects.find(o => o.id === b)!.value;
    const result = await s.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId: 'old-scope-basis',
      basisId: basis.basisId, changes: [{ objectId: b, value: { ...before, payload: { text: '不能忽略 A 输入曾变化' } } }] });
    assert.equal(result.status, 'retained');
    assert.match(result.reason!, /学生输入依据已变化/);
    assert.equal((await s.read(sessionId)).drafts[0].input.inputSeq, 2);
  });
});

test('the live save adapter receives producer events and keeps the student acknowledgement sequence independent', async () => {
  await fixture(async (s, root) => {
    const opened = await s.open(root), sessionId = opened.sessionId;
    const observed: string[] = [];
    const channel = new ParagraphSaveChannel(s, opened, () => {}, { pollMs: 0,
      onSnapshot: snapshot => observed.push(String(snapshot.unit.reading.blocks.find(block => block.id === b)!.payload.text)) });
    try {
      const attempt = await s.commands.startAttempt({ sessionId, taskId: 'adapter-events' });
      const basis = await s.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds: [b] });
      const value = basis.objects.find(object => object.id === b)!.value;
      await s.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId: 'notify-other-client', basisId: basis.basisId,
        changes: [{ objectId: b, value: { ...value, payload: { ...value.payload, text: '其他客户端看到生产者的正式修改' } } }] });
      await channel.synchronize();
      assert.deepEqual(observed, ['其他客户端看到生产者的正式修改']);
      await channel.synchronize();
      assert.equal(observed.length, 1);
      channel.input('学生在生产者事件之后继续输入');
      assert.equal(await channel.flush(), true);
      const saved = await s.read(sessionId);
      assert.equal(saved.confirmedInputSeq, 1);
      assert.equal(saved.unit.reading.blocks[0].payload.text, '学生在生产者事件之后继续输入');
      assert.equal(saved.unit.reading.blocks.find(block => block.id === b)!.payload.text, '其他客户端看到生产者的正式修改');
    } finally { channel.dispose(); }
  });
});
