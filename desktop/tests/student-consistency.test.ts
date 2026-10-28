import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('public student insertion cannot publish an unverified formula/experiment half-group; its draft survives and independent text remains editable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-student-consistency-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    const source = await core.readUnit(sessionId, 'KU-057');
    const experiment = structuredClone(source.reading.blocks.find(b => b.kind === 'interactive' && b.payload.component === 'mux')!);
    experiment.id = 'RB-STUDENT-COUPLED-EXPERIMENT';
    const formula = { id: 'RB-STUDENT-COUPLED-FORMULA', kind: 'formula', payload: { latex: 'Z=0', experimentBlockId: experiment.id } };
    const input = { sessionId, inputSeq: 1, baseRevision: c.revision, complete: true, changes: [],
      patch: { updates: [], correspondence: [], structure: { parentId: c.unit.id,
        before: c.unit.reading.blocks.map(b => b.id), after: [...c.unit.reading.blocks.map(b => b.id), experiment.id, formula.id], inserted: [experiment, formula] } } };
    await core.saveDraft(input);
    await assert.rejects(core.commitEdit({ ...input, operationId: 'inconsistent-student-insertion' }), /一致|共同|关联/);
    assert.deepEqual((await core.read(sessionId)).unit, c.unit);
    assert.equal(await core.queryOperation(sessionId, 'inconsistent-student-insertion'), null);
    assert.equal((await core.history(sessionId)).length, 0);
    assert.deepEqual((await core.read(sessionId)).drafts[0].input, input);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(root);
    assert.deepEqual(reopened.drafts[0].input, input);
    // An explicitly corrected latest input replaces the invalid local proposal, retaining ordinary editing.
    const block = reopened.unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const corrected = { sessionId: reopened.sessionId, inputSeq: 1, baseRevision: reopened.revision, complete: true,
      changes: [{ blockId: block.id, text: '学生独立文字仍可正常保存。' }], replacesDraft: { sessionId, inputSeq: 1 } };
    await core.saveDraft(corrected);
    const receipt = await core.commitEdit({ ...corrected, operationId: 'ordinary-student-text' });
    assert.equal(receipt.revision, 2);
    assert.equal((await core.read(reopened.sessionId)).unit.reading.blocks.find(b => b.id === block.id)!.payload.text, '学生独立文字仍可正常保存。');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('each active B has its own formal revision and recoverable input progress in the same course session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-unit-input-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const first = await core.open(root), sessionId = first.sessionId;
    const other = await core.read(sessionId, 'KU-057');
    assert.equal(other.unit.id, 'KU-057');
    const a = first.unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const b = other.unit.reading.blocks.find(b => b.kind === 'paragraph')!;
    const left = { sessionId, unitId: first.unit.id, inputSeq: 1, baseRevision: first.revision, complete: false,
      changes: [{ blockId: a.id, text: '第一单元的未完成输入' }] };
    const right = { sessionId, unitId: other.unit.id, inputSeq: 1, baseRevision: other.revision, complete: true,
      changes: [{ blockId: b.id, text: '多路选择器的独立正文修改。' }] };
    await core.saveDraft(left); await core.saveDraft(right);
    assert.equal((await core.read(sessionId, first.unit.id)).drafts.length, 1);
    assert.equal((await core.read(sessionId, other.unit.id)).drafts.length, 1);
    const saved = await core.commitEdit({ ...right, operationId: 'edit-other-b' });
    assert.equal(saved.unitId, 'KU-057'); assert.equal(saved.revision, 2);
    assert.equal((await core.read(sessionId, 'KU-057')).confirmedInputSeq, 1);
    assert.equal((await core.read(sessionId)).confirmedInputSeq, 0);
    assert.deepEqual((await core.read(sessionId)).unit, first.unit);
    await assert.rejects(core.commitEdit({ ...right, unitId: 'KU-001', inputSeq: 2, operationId: 'wrong-b' }), /草稿|段落|对象|范围/);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(root);
    assert.deepEqual(reopened.drafts[0].input, left);
    assert.equal((await core.read(reopened.sessionId, 'KU-057')).unit.reading.blocks.find(p => p.id === b.id)!.payload.text, right.changes[0].text);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
