import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import type { ContentPatch } from '../src/editor-api';
import { ParagraphSaveChannel } from '../src/renderer/save-channel';
import { DatabaseSync } from 'node:sqlite';

test('editor split and merge save only changed blocks, preserve the complete hidden course and reopen with unique identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-editor-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(root);
    const original = structuredClone(opened.unit);
    const a = original.reading.blocks[0];
    const ids = original.reading.blocks.map(b => b.id);
    const next = { id: 'student-split', kind: 'paragraph', payload: { text: '后半 📝' } };
    const patch: ContentPatch = {
      updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '前半' } }],
      structure: { parentId: original.id, before: ids, after: [a.id, next.id, ...ids.slice(1)], inserted: [next] },
      correspondence: [{ kind: 'split', sourceId: a.id, targetId: next.id, offset: 2 }],
    };
    const input = { sessionId: opened.sessionId, inputSeq: 1, baseRevision: 1, complete: true, changes: [], patch };
    await service.saveDraft(input);
    const receipt = await service.commitEdit({ ...input, operationId: 'editor-split' });
    const expected = structuredClone(original);
    expected.reading.blocks[0].payload.text = '前半';
    expected.reading.blocks.splice(1, 0, next);
    assert.deepEqual((await service.read(opened.sessionId)).unit, expected);
    assert.deepEqual(await service.commitEdit({ ...input, operationId: 'editor-split' }), receipt);
    const history = await service.history(opened.sessionId);
    assert.ok(!JSON.stringify(history).includes('"columns"'), 'unchanged tables must not be copied into edit history');
    await service.close();
    service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    assert.deepEqual(reopened.unit, expected);
    const merged = { ...a.payload, text: '前半后半 📝' };
    await service.commitEdit({ sessionId: reopened.sessionId, inputSeq: 1, baseRevision: reopened.revision,
      operationId: 'editor-merge', complete: true, changes: [], patch: {
        updates: [{ blockId: a.id, before: expected.reading.blocks[0].payload, after: merged }],
        structure: { parentId: original.id, before: expected.reading.blocks.map(b => b.id), after: ids, inserted: [] },
        correspondence: [{ kind: 'merge', sourceId: next.id, targetId: a.id, offset: 2 }],
      } } as any);
    expected.reading.blocks.splice(1, 1);
    expected.reading.blocks[0].payload = merged;
    assert.deepEqual((await service.read(reopened.sessionId)).unit, expected);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('structural deletion, projection, receipt and identity retirement roll back together; saved deletion Undo restores the proven full object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-editor-atomic-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let fault: DatabaseSync | undefined;
  try {
    const c = await service.open(root), blocks = c.unit.reading.blocks;
    const hidden = blocks.find(b => b.kind === 'exercise')!;
    const ids = blocks.map(b => b.id), after = ids.filter(id => id !== hidden.id);
    const input = { sessionId: c.sessionId, baseRevision: 1, inputSeq: 1, complete: true, changes: [], patch: {
      updates: [], structure: { parentId: c.unit.id, before: ids, after, inserted: [] }, correspondence: [],
    } };
    await service.saveDraft(input);
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_editor AFTER DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'editor atomic failure'); END");
    await assert.rejects(service.commitEdit({ ...input, operationId: 'delete-hidden' }), /editor atomic failure/);
    assert.deepEqual((await service.read(c.sessionId)).unit, c.unit);
    assert.equal(await service.queryOperation(c.sessionId, 'delete-hidden'), null);
    assert.deepEqual(await service.history(c.sessionId), []);
    fault.exec('DROP TRIGGER fail_editor');
    await service.commitEdit({ ...input, operationId: 'delete-hidden' });
    await service.commitEdit({ sessionId: c.sessionId, baseRevision: 2, inputSeq: 2, complete: true, changes: [], operationId: 'undo-delete', patch: {
      updates: [], structure: { parentId: c.unit.id, before: after, after: ids, inserted: [hidden] },
      correspondence: [{ kind: 'restore', sourceId: hidden.id, targetId: hidden.id }],
    } });
    assert.deepEqual((await service.read(c.sessionId)).unit, c.unit);
    const producer = await service.commands.startAttempt({ sessionId: c.sessionId, taskId: 'after-editor-undo' });
    const basis = await service.commands.read({ sessionId: c.sessionId, attemptId: producer.attemptId, objectIds: [hidden.id] });
    assert.equal(basis.objects.find(b => b.id === hidden.id)?.value.kind, hidden.kind);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('in-flight editor receipt covers only its input while the pending union composes cross-block edits and a cancelled split', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-editor-union-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let release!: () => void, committed!: () => void;
  const held = new Promise<void>(r => { release = r; }), reached = new Promise<void>(r => { committed = r; });
  let channel: ParagraphSaveChannel | undefined;
  try {
    const c = await service.open(root), [a, b] = c.unit.reading.blocks.filter(b => b.kind === 'paragraph'), ids = c.unit.reading.blocks.map(b => b.id);
    const states: string[] = [];
    channel = new ParagraphSaveChannel({ saveDraft: i => service.saveDraft(i), read: s => service.read(s), readEvents: (s, a, n) => service.readEvents(s, a, n),
      queryOperation: (s, o) => service.queryOperation(s, o), commitEdit: async command => {
        const receipt = await service.commitEdit(command); if (command.inputSeq === 1) { committed(); await held; } return receipt;
      } }, c, state => states.push(state.status), { pollMs: 0 });
    channel.edit({ changes: [], patch: { updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '第一笔' } }], correspondence: [] } });
    const flushed = channel.flush(); await reached;
    channel.edit({ changes: [], patch: { updates: [{ blockId: a.id, before: { ...a.payload, text: '第一笔' }, after: { ...a.payload, text: '甲乙' } }],
      structure: { parentId: c.unit.id, before: ids, after: [a.id, 'pending-tail', ...ids.slice(1)], inserted: [{ id: 'pending-tail', kind: 'paragraph', payload: { text: '丙丁' } }] }, correspondence: [] } });
    channel.edit({ changes: [], patch: { updates: [{ blockId: b.id, before: b.payload, after: { ...b.payload, text: '第二块也要保留' } }], correspondence: [] } });
    channel.edit({ changes: [], patch: { updates: [{ blockId: a.id, before: { ...a.payload, text: '甲乙' }, after: { ...a.payload, text: '甲乙丙丁' } }],
      structure: { parentId: c.unit.id, before: [a.id, 'pending-tail', ...ids.slice(1)], after: ids, inserted: [] }, correspondence: [] } });
    const beforeAck = states.length; await channel.synchronize();
    assert.equal(states.slice(beforeAck).includes('saved'), false);
    release(); assert.equal(await flushed, true);
    const expected = structuredClone(c.unit);
    expected.reading.blocks.find(x => x.id === a.id)!.payload.text = '甲乙丙丁';
    expected.reading.blocks.find(x => x.id === b.id)!.payload.text = '第二块也要保留';
    assert.deepEqual((await service.read(c.sessionId)).unit, expected);
    assert.equal((await service.read(c.sessionId)).confirmedInputSeq, 4);
    assert.equal((await service.history(c.sessionId)).length, 2);
  } finally { release(); channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a retained legacy text/split draft can continue as structural editor input without losing its original basis or hidden objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-editor-legacy-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const c = await service.open(root), first = c.unit.reading.blocks[0];
    await service.saveDraft({ sessionId: c.sessionId, inputSeq: 12, baseRevision: 1, complete: false,
      changes: [{ blockId: first.id, text: '甲乙丙丁' }], splits: [{ blockId: first.id, newBlockId: 'legacy-tail', offset: 2 }] });
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    channel = new ParagraphSaveChannel(service, reopened, () => {}, { pollMs: 0 });
    channel.useContentPatches();
    channel.edit({ changes: [], patch: { updates: [{ blockId: first.id, before: { ...first.payload, text: '甲乙' }, after: { ...first.payload, text: '修正输入' } }], correspondence: [] } });
    assert.equal(await channel.flush(), true);
    const expected = structuredClone(c.unit);
    expected.reading.blocks[0].payload.text = '修正输入';
    expected.reading.blocks.splice(1, 0, { id: 'legacy-tail', kind: 'paragraph', payload: { text: '丙丁' }, role: first.role, sourceRefs: first.sourceRefs });
    assert.deepEqual((await service.read(reopened.sessionId)).unit, expected);
    assert.deepEqual((await service.read(reopened.sessionId)).drafts, []);
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
