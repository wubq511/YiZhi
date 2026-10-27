import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { DatabaseSync } from 'node:sqlite';

const premise = 'RB-TH-01-01-what-is-positional-notation';
const target = 'RB-TH-01-03-expansion-terms';
async function fixture(run: (service: CourseService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'yizhi-command-groups-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try { await run(service, directory); }
  finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
}

test('a controlled producer commits a changed block, reports only its before/after history and reopens it', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'controlled-producer' });
    const basis = await service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId,
      objectIds: [target] });
    const before = basis.objects.find(object => object.id === target)!.value;
    const { role: _oldRole, ...withoutRole } = before;
    const command = { sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'group-1',
      basisId: basis.basisId, changes: [{ objectId: target,
        value: { ...withoutRole, payload: { ...before.payload, text: '可控生产者在真实课程副本中保存的候选。' } } }] };
    const receipt = await service.commands.commit(command);
    assert.equal(receipt.status, 'committed');
    assert.deepEqual(receipt.changedObjectIds, [target]);
    const history = await service.commands.history({ sessionId: opened.sessionId });
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].changes, [{ objectId: target, before,
      after: command.changes[0].value, beforeVersion: 1, afterVersion: 2 }]);
    await service.close();
    const reopened = new CourseService(resolve('dist/worker.cjs'));
    try {
      const current = await reopened.open(directory);
      assert.equal(current.unit.reading.blocks.find(block => block.id === target)!.payload.text,
        '可控生产者在真实课程副本中保存的候选。');
      assert.equal('role' in current.unit.reading.blocks.find(block => block.id === target)!, false);
      assert.deepEqual(await reopened.commands.query({ sessionId: current.sessionId, operationId: 'group-1' }), receipt);
      assert.deepEqual(await reopened.commands.commit({ ...command, sessionId: current.sessionId }), receipt);
    } finally { await reopened.close(); }
  });
});

test('only versioned substantive metadata after a saved change prompts a mastered B, and stale confirmation preserves the newer student choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yizhi-review-prompt-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(directory);
    await service.setReviewStatus(opened.sessionId, 'KU-001', 'mastered');
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'review-impact' });
    const submit = async (operationId: string, text: string, conclusionOrMethodChanged: boolean) => {
      const basis = await service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds: ['RB-TH-01-03-expansion-terms'] });
      const old = basis.objects[0].value;
      return service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId, basisId: basis.basisId,
        changes: [{ objectId: old.id, value: { ...old, payload: { ...old.payload, text } } },
          // Keep the existing controlled producer block value valid for this fixture's stable id.
        ], semanticImpact: { version: 1, unitId: 'KU-001', conclusionOrMethodChanged } });
    };
    const wording = await submit('wording-only', '只调整表达方式，不改结论。', false);
    assert.equal(wording.reviewPrompt, undefined);
    const substantive = await submit('substantive', '重要结论与方法已发生实质变化。', true);
    assert.ok(substantive.reviewPrompt);
    assert.equal(substantive.reviewPrompt!.contentRevision, (await service.read(opened.sessionId)).revision);
    assert.equal((await service.reviewStates(opened.sessionId)).units['KU-001'].status, 'mastered');
    await service.setReviewStatus(opened.sessionId, 'KU-001', 'weak');
    assert.equal(await service.confirmReviewPrompt(opened.sessionId, substantive.reviewPrompt!.id, true), 'stale');
    assert.equal((await service.reviewStates(opened.sessionId)).units['KU-001'].status, 'weak');

    await service.setReviewStatus(opened.sessionId, 'KU-001', 'mastered');
    const freshPrompt = await submit('substantive-confirmed', '新的方法结论已保存。', true);
    assert.ok(freshPrompt.reviewPrompt);
    assert.equal((await service.reviewStates(opened.sessionId)).units['KU-001'].status, 'mastered');
    assert.equal(await service.confirmReviewPrompt(opened.sessionId, freshPrompt.reviewPrompt!.id, true), 'adjusted');
    assert.equal((await service.reviewStates(opened.sessionId)).units['KU-001'].status, 'pending');
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('changing a read premise retains the old candidate; only a fresh read and new integrated candidate may commit', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'read-premise' });
    const request = { sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds: [premise, target] };
    const basis = await service.commands.read(request);
    const original = basis.objects.find(object => object.id === target)!.value;
    const command = { sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'stale-candidate',
      basisId: basis.basisId, changes: [{ objectId: target, value: { ...original, payload: { text: '依据旧前提得出的候选' } } }] };
    await service.save({ sessionId: opened.sessionId, operationId: 'student-premise', inputSeq: 1,
      baseRevision: opened.revision, blockId: premise, text: '学生修改了推导前提' });
    const result = await service.commands.commit(command);
    assert.equal(result.status, 'retained');
    assert.match(result.reason!, /依据已变化/);
    const current = await service.read(opened.sessionId);
    assert.equal(current.unit.reading.blocks[0].payload.text, '学生修改了推导前提');
    assert.deepEqual(current.unit.reading.blocks.find(block => block.id === target)!.payload, original.payload);
    assert.deepEqual((await service.commands.candidates({ sessionId: opened.sessionId }))[0].command, command);
    const fresh = await service.commands.read(request);
    await assert.rejects(service.commands.commit({ ...command, basisId: fresh.basisId }), /不同内容/);
    assert.deepEqual(await service.commands.commit(command), result);
    const integrated = await service.commands.commit({ ...command, operationId: 'integrated-candidate', basisId: fresh.basisId,
      changes: [{ objectId: target, value: { ...original, payload: { text: '重读学生修改了推导前提后整合的候选' } } }] });
    assert.equal(integrated.status, 'committed');
    assert.equal((await service.commands.history({ sessionId: opened.sessionId })).length, 1);
  });
});

test('independent writes survive each other, while a changed shared ancestor invalidates a child candidate', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'independence' });
    const read = (ids: string[]) => service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds: ids });
    const commit = (basis: Awaited<ReturnType<typeof read>>, id: string, objectId: string, payload: Record<string, any>) => {
      const before = basis.objects.find(object => object.id === objectId)!.value;
      return service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: id,
        basisId: basis.basisId, changes: [{ objectId, value: { ...before, payload: { ...before.payload, ...payload } } }] });
    };
    const a = await read([premise]), b = await read([target]);
    assert.equal((await commit(a, 'independent-a', premise, { text: '独立修改 A' })).status, 'committed');
    assert.equal((await commit(b, 'independent-b', target, { text: '独立修改 B' })).status, 'committed');
    const current = await service.read(opened.sessionId);
    assert.equal(current.unit.reading.blocks[0].payload.text, '独立修改 A');
    assert.equal(current.unit.reading.blocks[2].payload.text, '独立修改 B');
    const parent = 'RB-TH-01-07-example-26-75', child = 'RB-TH-01-08-example-26-75-ans';
    const childBasis = await read([child]);
    const parentBasis = await read([parent]);
    await commit(parentBasis, 'changed-parent', parent, { problem: '例题前提发生变化' });
    const rejected = await commit(childBasis, 'old-child', child, { text: '根据旧题目得出的答案' });
    assert.equal(rejected.status, 'retained');
    assert.match(rejected.reason!, /依据已变化/);
  });
});

test('stop and commit share one order: stop first retains a candidate; commit first keeps its receipt; resume never revives old callbacks', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const request = { sessionId: opened.sessionId, taskId: 'stop-race' };
    const first = await service.commands.startAttempt(request);
    const basis = await service.commands.read({ sessionId: opened.sessionId, attemptId: first.attemptId, objectIds: [target] });
    const value = basis.objects.find(object => object.id === target)!.value;
    const command = { sessionId: opened.sessionId, attemptId: first.attemptId, operationId: 'stop-first',
      basisId: basis.basisId, changes: [{ objectId: target, value: { ...value, payload: { text: '停止后的迟到候选' } } }] };
    const [stopped, rejected] = await Promise.all([
      service.commands.stop({ sessionId: opened.sessionId, attemptId: first.attemptId }), service.commands.commit(command),
    ]);
    assert.equal(stopped.status, 'stopped');
    assert.equal(rejected.status, 'retained');
    assert.match(rejected.reason!, /尝试已停止/);
    await assert.rejects(service.commands.startAttempt(request), /明确继续/);
    const next = await service.commands.startAttempt({ ...request, resume: true });
    assert.notEqual(next.attemptId, first.attemptId);
    const fresh = await service.commands.read({ sessionId: opened.sessionId, attemptId: next.attemptId, objectIds: [target] });
    const late = await service.commands.commit({ ...command, operationId: 'late-old-attempt', basisId: fresh.basisId });
    assert.equal(late.status, 'retained');
    const savedCommand = { ...command, operationId: 'commit-first', attemptId: next.attemptId, basisId: fresh.basisId };
    const [saved, ended] = await Promise.all([service.commands.commit(savedCommand),
      service.commands.stop({ sessionId: opened.sessionId, attemptId: next.attemptId })]);
    assert.equal(saved.status, 'committed');
    assert.equal(ended.status, 'stopped');
    assert.deepEqual(await service.commands.commit(savedCommand), saved);
    assert.deepEqual(await service.commands.query({ sessionId: opened.sessionId, operationId: saved.operationId }), saved);
    assert.equal((await service.read(opened.sessionId)).unit.reading.blocks[2].payload.text, '停止后的迟到候选');
    assert.equal((await service.commands.history({ sessionId: opened.sessionId })).length, 1);
  });
});

test('body, order, references, dependency state, history and receipt roll back together on an actual SQLite history failure', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'atomic-group' });
    const formula = 'RB-TH-01-02-expansion-formula';
    const ids = [formula, target, 'structure:KU-001', 'reference:controlled-example', 'dependency:controlled-example'];
    const request = { sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds: ids };
    const basis = await service.commands.read(request);
    const original = basis.objects.find(object => object.id === formula)!.value;
    const order = opened.unit.reading.blocks.map(block => block.id);
    const reordered = [order[1], order[0], ...order.slice(2)];
    const command = { sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'atomic-command', basisId: basis.basisId,
      changes: [
        { objectId: formula, value: { ...original, payload: { ...original.payload, latex: 'N = 2^3 + 1' } } },
        { objectId: 'structure:KU-001', value: { blockIds: reordered } },
        { objectId: 'reference:controlled-example', value: { fromBlockId: formula, toBlockId: target, meaning: '符号说明' } },
        { objectId: 'dependency:controlled-example', value: { sourceBlockId: formula, dependentBlockId: target, status: 'needs-review' } },
      ] };
    const fault = new DatabaseSync(join(directory, 'course.sqlite'));
    try {
      fault.exec("CREATE TRIGGER reject_group_history BEFORE INSERT ON cg_history BEGIN SELECT RAISE(ABORT, 'history disk fault'); END");
      await assert.rejects(service.commands.commit(command), /history disk fault/);
      assert.deepEqual((await service.read(opened.sessionId)).unit, opened.unit);
      assert.equal(await service.commands.query({ sessionId: opened.sessionId, operationId: command.operationId }), null);
      assert.deepEqual(await service.commands.history({ sessionId: opened.sessionId }), []);
      const unchanged = await service.commands.read(request);
      assert.equal(unchanged.objects.find(object => object.id === 'reference:controlled-example')!.version, 0);
      assert.equal(unchanged.objects.find(object => object.id === 'dependency:controlled-example')!.version, 0);
      assert.deepEqual(unchanged.objects.find(object => object.id === 'structure:KU-001')!.value.blockIds, order);
      fault.exec('DROP TRIGGER reject_group_history');
      const saved = await service.commands.commit(command);
      assert.equal(saved.status, 'committed');
      assert.deepEqual(saved.changedObjectIds, command.changes.map(change => change.objectId));
      const current = await service.read(opened.sessionId);
      assert.deepEqual(current.unit.reading.blocks.map(block => block.id), reordered);
      assert.equal(current.unit.reading.blocks[0].payload.latex, 'N = 2^3 + 1');
      const result = await service.commands.read(request);
      assert.deepEqual(result.objects.find(object => object.id === 'dependency:controlled-example')!.value,
        { sourceBlockId: formula, dependentBlockId: target, status: 'needs-review' });
      const history = await service.commands.history({ sessionId: opened.sessionId });
      assert.equal(history.length, 1);
      assert.equal(history[0].changes.length, 4);
      assert.deepEqual(history[0].changes.find(change => change.objectId === 'structure:KU-001')!.before, { blockIds: order });
    } finally { fault.close(); }
  });
});

test('a dependency read includes its source and references; student changes invalidate that basis and dependent current state', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'dependency-reader' });
    const read = (objectIds: string[]) => service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds });
    const initial = await read([premise, target, 'dependency:derivation', 'reference:derivation']);
    await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'add-dependency', basisId: initial.basisId,
      changes: [
        { objectId: 'dependency:derivation', value: { sourceBlockId: premise, dependentBlockId: target, status: 'current' } },
        { objectId: 'reference:derivation', value: { fromBlockId: target, toBlockId: premise, meaning: '推导前提' } },
      ] });
    const basis = await read([target]);
    assert.ok(basis.objects.some(object => object.id === premise));
    assert.ok(basis.objects.some(object => object.id === 'reference:derivation'));
    const before = basis.objects.find(object => object.id === target)!.value;
    const current = await service.read(opened.sessionId);
    await service.save({ sessionId: opened.sessionId, operationId: 'change-dependent-source', inputSeq: 1,
      baseRevision: current.revision, blockId: premise, text: '依赖源已由学生修改' });
    const result = await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'old-dependent',
      basisId: basis.basisId, changes: [{ objectId: target, value: { ...before, payload: { text: '不能依据旧源写入' } } }] });
    assert.equal(result.status, 'retained');
    const reread = await read([target]);
    assert.equal(reread.objects.find(object => object.id === 'dependency:derivation')!.value.status, 'needs-review');
  });
});

test('adding a dependency after a read invalidates the old candidate instead of silently omitting the new prerequisite', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'new-prerequisite' });
    const read = (objectIds: string[]) => service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds });
    const basis = await read([target]);
    const value = basis.objects.find(object => object.id === target)!.value;
    const relation = await read([premise, target, 'dependency:added-later']);
    await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'new-dependency',
      basisId: relation.basisId, changes: [{ objectId: 'dependency:added-later',
        value: { sourceBlockId: premise, dependentBlockId: target, status: 'current' } }] });
    const result = await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId,
      operationId: 'missing-new-prerequisite', basisId: basis.basisId,
      changes: [{ objectId: target, value: { ...value, payload: { text: '未读取新前提的旧候选' } } }] });
    assert.equal(result.status, 'retained');
  });
});

test('a group cannot smuggle children through a payload replacement or claim an unread reference endpoint', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'bounded-write-set' });
    const basis = await service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId,
      objectIds: [premise, 'reference:unread-endpoint'] });
    const value = basis.objects.find(object => object.id === premise)!.value;
    const hidden = await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId,
      operationId: 'hidden-child', basisId: basis.basisId, changes: [{ objectId: premise, value: { ...value, children: [] } }] });
    assert.equal(hidden.status, 'retained');
    const reference = await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId,
      operationId: 'unread-endpoint', basisId: basis.basisId, changes: [{ objectId: 'reference:unread-endpoint',
        value: { fromBlockId: premise, toBlockId: target, meaning: '未读端点' } }] });
    assert.equal(reference.status, 'retained');
    assert.deepEqual((await service.read(opened.sessionId)).unit, opened.unit);
    assert.deepEqual(await service.commands.history({ sessionId: opened.sessionId }), []);
  });
});

test('restoring identical text does not revive old read versions, and reordered shared structure invalidates old candidates', async () => {
  await fixture(async (service, directory) => {
    const opened = await service.open(directory);
    const attempt = await service.commands.startAttempt({ sessionId: opened.sessionId, taskId: 'version-fences' });
    const read = (objectIds: string[]) => service.commands.read({ sessionId: opened.sessionId, attemptId: attempt.attemptId, objectIds });
    const basis = await read([premise, target]);
    const value = basis.objects.find(object => object.id === target)!.value;
    await service.save({ sessionId: opened.sessionId, operationId: 'aba-away', inputSeq: 1,
      baseRevision: 1, blockId: premise, text: '临时改动' });
    await service.save({ sessionId: opened.sessionId, operationId: 'aba-back', inputSeq: 2,
      baseRevision: 2, blockId: premise, text: opened.unit.reading.blocks[0].payload.text });
    const old = { sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'before-aba', basisId: basis.basisId,
      changes: [{ objectId: target, value: { ...value, payload: { text: '旧候选' } } }] };
    assert.equal((await service.commands.commit(old)).status, 'retained');
    const child = await read([target]);
    const structure = await read(['structure:KU-001']);
    const blockIds = opened.unit.reading.blocks.map(block => block.id).reverse();
    await service.commands.commit({ sessionId: opened.sessionId, attemptId: attempt.attemptId, operationId: 'reorder-shared-structure',
      basisId: structure.basisId, changes: [{ objectId: 'structure:KU-001', value: { blockIds } }] });
    assert.equal((await service.commands.commit({ ...old, operationId: 'before-reorder', basisId: child.basisId })).status, 'retained');
  });
});
