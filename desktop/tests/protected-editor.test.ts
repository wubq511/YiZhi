import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { ParagraphSaveChannel } from '../src/renderer/save-channel';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sourceFixture } from './source-fixture';

test('current paragraph protection retains its producer while an independent group commits; release rechecks the saved student basis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-protection-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), [a, b] = c.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    const api = service.commands as any;
    const attempt = await api.startAttempt({ sessionId: c.sessionId, taskId: 'protected-producer' });
    const make = async (id: string, text: string, operationId: string) => {
      const basis = await api.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [id] });
      const block = basis.objects.find((o: any) => o.id === id).value;
      return { sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId,
        changes: [{ objectId: id, value: { ...block, payload: { ...block.payload, text } } }] };
    };
    await api.protect({ sessionId: c.sessionId, editorId: 'student-editor', sequence: 1, blockIds: [a.id], mode: 'editing', inputSeq: 0 });
    const waiting = await make(a.id, a.payload.text + ' 外部补充', 'waiting-a');
    assert.equal((await api.commit(waiting)).status, 'retained');
    assert.equal((await api.commit(await make(b.id, '独立部分照常更新', 'independent-b'))).status, 'committed');
    const latest = await service.read(c.sessionId);
    await service.commitEdit({ sessionId: c.sessionId, inputSeq: 1, baseRevision: latest.revision, operationId: 'student-a', complete: true, changes: [],
      patch: { updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '学生补充 ' + a.payload.text } }], correspondence: [] } });
    await api.protect({ sessionId: c.sessionId, editorId: 'student-editor', sequence: 2, blockIds: [], mode: 'editing', inputSeq: 1 });
    const results = await api.recheck({ sessionId: c.sessionId });
    assert.equal(results[0].status, 'committed');
    const saved = await service.read(c.sessionId);
    assert.equal(saved.unit.reading.blocks.find(x => x.id === a.id)!.payload.text, '学生补充 ' + a.payload.text + ' 外部补充');
    assert.equal(saved.unit.reading.blocks.find(x => x.id === b.id)!.payload.text, '独立部分照常更新');
    const expected = structuredClone(c.unit);
    expected.reading.blocks.find(x => x.id === a.id)!.payload.text = '学生补充 ' + a.payload.text + ' 外部补充';
    expected.reading.blocks.find(x => x.id === b.id)!.payload.text = '独立部分照常更新';
    assert.deepEqual(saved.unit, expected, 'opaque and unopened payloads keep their exact identity and content');
    assert.equal((await api.query({ sessionId: c.sessionId, operationId: 'waiting-a' })).status, 'retained', 'original operation remains immutable');
    assert.deepEqual(await api.recheck({ sessionId: c.sessionId }), [], 'resolved candidate cannot replay');
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('automatic recheck cannot relabel a changed non-target prerequisite, even when the target did not change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-recheck-prerequisite-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), [a, b] = c.unit.reading.blocks.filter(b => b.kind === 'paragraph'), api = service.commands;
    const attempt = await api.startAttempt({ sessionId: c.sessionId, taskId: 'dependent-waiter' });
    const basis = await api.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id, b.id] });
    await api.protect({ sessionId: c.sessionId, editorId: 'dependent-editor', sequence: 1, blockIds: [b.id], mode: 'editing', inputSeq: 0 });
    const command = { sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'dependent-waiter',
      changes: [{ objectId: b.id, value: { ...basis.objects.find(o => o.id === b.id)!.value, payload: { ...b.payload, text: '根据旧前提推导的结果' } } }] };
    assert.equal((await api.commit(command)).status, 'retained');
    await service.commitEdit({ sessionId: c.sessionId, inputSeq: 1, baseRevision: 1, operationId: 'prerequisite-change', complete: true,
      changes: [{ blockId: a.id, text: '前提已经改变' }] });
    await api.protect({ sessionId: c.sessionId, editorId: 'dependent-editor', sequence: 2, blockIds: [], mode: 'editing', inputSeq: 1 });
    const checked = await api.recheck({ sessionId: c.sessionId });
    assert.equal(checked[0].status, 'needs-reread'); assert.ok(checked[0].reason!.includes(a.id));
    await assert.rejects(api.resolveCandidate({ sessionId: c.sessionId, candidateId: command.operationId, basisRevision: 2, choice: 'incoming' }), /前提已变化/);
    assert.equal((await service.read(c.sessionId)).unit.reading.blocks.find(x => x.id === b.id)!.payload.text, b.payload.text);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a real final SQLite rejection rolls automatic integration, receipt, event and candidate consumption back together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-recheck-atomic-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let fault: DatabaseSync | undefined;
  try {
    const c = await service.open(root), a = c.unit.reading.blocks[0], api = service.commands;
    const attempt = await api.startAttempt({ sessionId: c.sessionId, taskId: 'atomic-waiter' });
    const basis = await api.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id] });
    await api.protect({ sessionId: c.sessionId, editorId: 'atomic-editor', sequence: 1, blockIds: [a.id], mode: 'editing', inputSeq: 0 });
    const command = { sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'atomic-waiter',
      changes: [{ objectId: a.id, value: { ...basis.objects.find(o => o.id === a.id)!.value, payload: { ...a.payload, text: a.payload.text + ' 已核对补充' } } }] };
    await api.commit(command);
    await api.protect({ sessionId: c.sessionId, editorId: 'atomic-editor', sequence: 2, blockIds: [], mode: 'editing', inputSeq: 0 });
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_recheck AFTER INSERT ON cg_resolved BEGIN SELECT RAISE(ABORT, 'integration final failure'); END");
    await assert.rejects(api.recheck({ sessionId: c.sessionId }), /integration final failure/);
    assert.deepEqual((await service.read(c.sessionId)).unit, c.unit);
    assert.deepEqual(await api.history({ sessionId: c.sessionId }), []);
    assert.equal((await api.candidates({ sessionId: c.sessionId })).length, 1);
    fault.exec('DROP TRIGGER fail_recheck');
    assert.equal((await api.recheck({ sessionId: c.sessionId }))[0].status, 'committed');
    assert.equal((await api.history({ sessionId: c.sessionId })).length, 1);
    assert.deepEqual(await api.recheck({ sessionId: c.sessionId }), []);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('internally generated integration operations obey the same source and conversation identity fence as direct IPC writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-integration-fence-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(join(root, 'course')), a = c.unit.reading.blocks[0], api = service.commands;
    const path = join(root, 'source.pdf'); await sourceFixture(path);
    for (const domain of ['source', 'conversation']) {
      const candidateId = `fenced-${domain}`, operationId = `integrate-${createHash('sha256').update(candidateId).digest('hex')}`;
      const attempt = await api.startAttempt({ sessionId: c.sessionId, taskId: candidateId });
      const basis = await api.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id] });
      await api.protect({ sessionId: c.sessionId, editorId: candidateId, sequence: 1, blockIds: [a.id], mode: 'editing', inputSeq: 0 });
      await api.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: candidateId,
        changes: [{ objectId: a.id, value: { ...basis.objects.find(o => o.id === a.id)!.value, payload: { ...a.payload, text: a.payload.text + ' 提交候选' } } }] });
      if (domain === 'source') await service.sources.importFile({ sessionId: c.sessionId, generation: 1, operationId, path, title: 'Operation fence evidence' });
      else await service.agent.create({ sessionId: c.sessionId, operationId });
      await api.protect({ sessionId: c.sessionId, editorId: candidateId, sequence: 2, blockIds: [], mode: 'editing', inputSeq: 0 });
      await assert.rejects(api.recheck({ sessionId: c.sessionId }), /操作身份/);
      assert.deepEqual((await service.read(c.sessionId)).unit, c.unit);
      await api.resolveCandidate({ sessionId: c.sessionId, candidateId, basisRevision: 1, choice: 'current' });
    }
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('leave rechecks real prerequisites and attempt eligibility, asks only incompatible groups, and never splits a necessary consistency group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-recheck-guards-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), [a, b] = c.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    const api = service.commands;
    await api.protect({ sessionId: c.sessionId, editorId: 'guard-editor', sequence: 1, blockIds: [a.id], mode: 'editing', inputSeq: 0 });
    const attempt = await api.startAttempt({ sessionId: c.sessionId, taskId: 'guarded-group' });
    const basis = await api.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id, b.id] });
    const changes = [a, b].map(block => ({ objectId: block.id, value: { ...basis.objects.find(o => o.id === block.id)!.value, payload: { ...block.payload, text: '需要共同成立的新内容' } } }));
    const command = { sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'joint-conflict', changes };
    assert.equal((await api.commit(command)).status, 'retained');
    assert.deepEqual((await service.read(c.sessionId)).unit, c.unit, 'no independent-looking half of a joint group may publish');
    await service.commitEdit({ sessionId: c.sessionId, inputSeq: 1, baseRevision: 1, operationId: 'change-prerequisite', complete: true,
      changes: [{ blockId: a.id, text: '学生对同处的另一改写' }] });
    await api.protect({ sessionId: c.sessionId, editorId: 'guard-editor', sequence: 2, blockIds: [], mode: 'editing', inputSeq: 1 });
    assert.equal((await api.recheck({ sessionId: c.sessionId }))[0].status, 'conflict');
    const current = await service.read(c.sessionId);
    await api.resolveCandidate({ sessionId: c.sessionId, candidateId: command.operationId, basisRevision: current.revision, choice: 'current' });
    assert.deepEqual(await api.recheck({ sessionId: c.sessionId }), []);
    assert.equal((await service.read(c.sessionId)).unit.reading.blocks.find(x => x.id === b.id)!.payload.text, b.payload.text);
    // A late stopped callback remains ineligible after release, even if its old values still match.
    const stopped = await api.startAttempt({ sessionId: c.sessionId, taskId: 'stopped-waiter' });
    const read = await api.read({ sessionId: c.sessionId, attemptId: stopped.attemptId, objectIds: [b.id] });
    await api.stop({ sessionId: c.sessionId, attemptId: stopped.attemptId });
    await api.commit({ sessionId: c.sessionId, attemptId: stopped.attemptId, basisId: read.basisId, operationId: 'stopped-waiter', changes: [changes[1]] });
    assert.equal((await api.recheck({ sessionId: c.sessionId }))[0].status, 'ineligible');
    await assert.rejects(api.resolveCandidate({ sessionId: c.sessionId, candidateId: 'stopped-waiter', basisRevision: current.revision, choice: 'incoming' }), /停止|失效/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('late overlapping student draft keeps both versions across reopen, refuses premature release, and resolves only the named conflict against a current basis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-conflict-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(root), a = c.unit.reading.blocks[0], api = service.commands as any;
    const attempt = await api.startAttempt({ sessionId: c.sessionId, taskId: 'external-conflict' });
    const basis = await api.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id] });
    const object = basis.objects.find((o: any) => o.id === a.id);
    await api.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'external-conflict',
      changes: [{ objectId: a.id, value: { ...object.value, payload: { ...a.payload, text: '外部的同处版本' } } }] });
    await api.protect({ sessionId: c.sessionId, editorId: 'late-editor', sequence: 1, blockIds: [a.id], mode: 'editing', inputSeq: 0 });
    await assert.rejects(api.protect({ sessionId: c.sessionId, editorId: 'late-editor', sequence: 2, blockIds: [], mode: 'editing', inputSeq: 1 }), /尚未持久保留/);
    const input = { sessionId: c.sessionId, inputSeq: 1, baseRevision: 1, complete: true, changes: [], patch: {
      updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '学生的同处版本' } }], correspondence: [] } };
    await service.saveDraft(input);
    await assert.rejects(service.commitEdit({ ...input, operationId: 'late-student' }), /不兼容/);
    assert.equal((await service.read(c.sessionId)).unit.reading.blocks[0].payload.text, '外部的同处版本');
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    assert.equal(reopened.drafts[0].input.patch!.updates[0].after.text, '学生的同处版本');
    const request = { sessionId: reopened.sessionId, operationId: 'resolve-late-input', draftSessionId: c.sessionId,
      inputSeq: 1, basisRevision: reopened.revision, blockIds: [a.id], choice: 'student' };
    await assert.rejects((service.commands as any).resolveInput({ ...request, basisRevision: 1 }), /版本已变化/);
    const receipt = await (service.commands as any).resolveInput(request);
    assert.deepEqual(await (service.commands as any).resolveInput(request), receipt);
    const resolved = await service.read(reopened.sessionId);
    assert.equal(resolved.unit.reading.blocks[0].payload.text, '学生的同处版本');
    assert.deepEqual(resolved.drafts, []);
    assert.equal((await service.commands.history({ sessionId: reopened.sessionId })).length, 1);
    assert.equal((await service.history(reopened.sessionId)).length, 1);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('external commit before student IPC keeps its history, merges a compatible original-basis draft and confirms only durable input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-external-first-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const c = await service.open(root), a = c.unit.reading.blocks[0];
    const attempt = await service.commands.startAttempt({ sessionId: c.sessionId, taskId: 'external-first' });
    const basis = await service.commands.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id] });
    const object = basis.objects.find(o => o.id === a.id)!;
    const external = await service.commands.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'external-first',
      changes: [{ objectId: a.id, value: { ...object.value, payload: { ...a.payload, text: a.payload.text + ' 外部尾部' } } }] });
    assert.equal(external.status, 'committed');
    const states: any[] = [];
    channel = new ParagraphSaveChannel(service, c, s => states.push(s), { pollMs: 0 });
    channel.useContentPatches();
    // The formal event can be known while a held DOM still shows its original projection.
    await channel.synchronize();
    channel.edit({ changes: [], patch: { updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '学生前部 ' + a.payload.text } }], correspondence: [] } });
    assert.notEqual(states.at(-1).status, 'saved');
    assert.equal(await channel.flush(), true);
    assert.equal((await service.read(c.sessionId)).unit.reading.blocks[0].payload.text, '学生前部 ' + a.payload.text + ' 外部尾部');
    assert.equal((await service.commands.history({ sessionId: c.sessionId })).length, 1);
    assert.equal((await service.history(c.sessionId)).length, 1);
    assert.deepEqual((await service.read(c.sessionId)).drafts, []);
    channel.dispose(); channel = undefined;
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    assert.equal((await service.open(root)).unit.reading.blocks[0].payload.text, '学生前部 ' + a.payload.text + ' 外部尾部');
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
