import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { ParagraphSaveChannel } from '../src/renderer/save-channel';

test('navigation restores the durable body draft beside an unfinished formula after an independent formal update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-draft-navigation-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const course = await service.open(root);
    const [first, independent] = course.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    const formula = course.unit.reading.blocks.find(b => b.kind === 'formula')!;
    channel = new ParagraphSaveChannel(service, course, () => {}, { pollMs: 0 });
    channel.useContentPatches();
    channel.edit({ changes: [], patch: { updates: [{ blockId: first.id, before: first.payload,
      after: { ...first.payload, text: '学生中文标点。english 与纠错后的正文' } }], correspondence: [] },
      formulaDrafts: [{ blockId: formula.id, latex: '\\frac{1}{\\placeholder{}}x' }] });
    assert.equal(await channel.flush(), true);

    const attempt = await service.commands.startAttempt({ sessionId: course.sessionId, taskId: 'independent-draft-navigation' });
    const basis = await service.commands.read({ sessionId: course.sessionId, attemptId: attempt.attemptId, objectIds: [independent.id] });
    const block = basis.objects.find(o => o.id === independent.id)!.value;
    const receipt = await service.commands.commit({ sessionId: course.sessionId, attemptId: attempt.attemptId,
      basisId: basis.basisId, operationId: 'independent-draft-navigation',
      changes: [{ objectId: independent.id, value: { ...block, payload: { ...block.payload, text: '独立正式更新仍然存在' } } }] });
    assert.equal(receipt.status, 'committed');
    await service.commands.stop({ sessionId: course.sessionId, attemptId: attempt.attemptId });
    channel.dispose();
    await service.read(course.sessionId, 'KU-002');
    const returned = await service.read(course.sessionId, course.unit.id);
    assert.ok(returned.drafts[0].input.baseRevision < returned.revision);
    assert.equal(returned.drafts[0].input.patch!.updates[0].after.text, '学生中文标点。english 与纠错后的正文');
    channel = new ParagraphSaveChannel(service, returned, () => {}, { pollMs: 0 });
    channel.useContentPatches();
    const recovery = channel.recovery();
    assert.equal(recovery.patch!.updates[0].after.text, '学生中文标点。english 与纠错后的正文',
      'the selected recovery patch still contains the durable student input');
    assert.equal(recovery.blocks.find(b => b.id === first.id)!.payload.text, '学生中文标点。english 与纠错后的正文');
    assert.equal(recovery.blocks.find(b => b.id === independent.id)!.payload.text, '独立正式更新仍然存在');
    assert.deepEqual(recovery.formulaDrafts, [{ blockId: formula.id, latex: '\\frac{1}{\\placeholder{}}x' }]);
    assert.equal(returned.unit.reading.blocks.find(b => b.id === first.id)!.payload.text, first.payload.text,
      'recovering a projection does not promote unfinished input into formal content');
    assert.equal((await service.read(course.sessionId, course.unit.id)).drafts[0].input.complete, false);
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('draft recovery preserves a conflicting formal payload and keeps the student version durable for resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-draft-conflict-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const original = await service.open(root), first = original.unit.reading.blocks[0];
    const formula = original.unit.reading.blocks.find(b => b.kind === 'formula')!;
    await service.commitEdit({ sessionId: original.sessionId, inputSeq: 1, baseRevision: original.revision,
      operationId: 'conflicting-formal-content', complete: true, changes: [{ blockId: first.id, text: '当前正式正文不能被旧稿覆盖' }] });
    await service.saveDraft({ sessionId: original.sessionId, inputSeq: 2, baseRevision: original.revision, complete: false,
      changes: [], patch: { updates: [{ blockId: first.id, before: first.payload,
        after: { ...first.payload, text: '仍需处理的学生同处草稿' } }], correspondence: [] },
      formulaDrafts: [{ blockId: formula.id, latex: '\\frac{1}{\\placeholder{}}x' }] });
    const returned = await service.read(original.sessionId, original.unit.id);
    channel = new ParagraphSaveChannel(service, returned, () => {}, { pollMs: 0 });
    channel.useContentPatches();
    const recovery = channel.recovery();
    assert.equal(recovery.blocks.find(b => b.id === first.id)!.payload.text, '当前正式正文不能被旧稿覆盖');
    assert.equal(recovery.patch!.updates[0].after.text, '仍需处理的学生同处草稿');
    assert.deepEqual(recovery.formulaDrafts, [{ blockId: formula.id, latex: '\\frac{1}{\\placeholder{}}x' }]);
    assert.deepEqual((await service.read(original.sessionId, original.unit.id)).drafts, returned.drafts,
      'a conflicting projection must not discard or rewrite the durable draft');
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
