import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

const selection = (c: any, blocks = c.unit.reading.blocks.filter((b: any) => b.kind === 'paragraph').slice(0, 2)) => ({ unitId: c.unit.id,
  fragments: blocks.map((block: any) => ({ blockId: block.id, block, field: 'text', formalRevision: c.revision, source: 'formal',
    projection: { version: 1, encoding: 'unicode-code-points', text: block.payload.text }, from: 1, to: 4,
    quote: Array.from(block.payload.text).slice(1, 4).join('') })) });

test('one note owns ordered Unicode fragments and immutable creation context across note save and course reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-annotations-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root);
    const ps = c.unit.reading.blocks.filter(b => b.kind === 'paragraph').slice(0, 2);
    await core.commitEdit({ sessionId: c.sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'unicode', changes: ps.map(b => ({ blockId: b.id, text: '中𠮷文重复。重复。' })), complete: true });
    c = await core.read(c.sessionId);
    const captured = selection(c);
    const request = { sessionId: c.sessionId, operationId: 'create-note', selection: captured, text: '只记录一次' };
    const note = await core.annotations.create(request);
    assert.equal(note.original.fragments.length, 2);
    assert.equal(note.original.fragments[0].quote, '𠮷文重');
    assert.deepEqual(await core.annotations.create(request), note);
    const edited = await core.annotations.update({ sessionId: c.sessionId, operationId: 'note-edit', id: note.id, expectedVersion: note.version, text: '我的理解' });
    assert.equal(edited.text, '我的理解');
    assert.deepEqual(edited.original, note.original);
    assert.equal((await core.read(c.sessionId)).revision, c.revision, 'note editing never changes course content');
    await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    c = await core.open(root);
    assert.deepEqual(await core.annotations.list({ sessionId: c.sessionId }), [edited]);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('proven split, merge, move and saved Undo retain one note; deletion and repeated rewrites orphan until explicit reassociation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-anchor-proof-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root), seq = 0;
    const a = c.unit.reading.blocks[0], originalUnit = structuredClone(c.unit);
    const write = async (patch: any) => { await core.commitEdit({ sessionId: c.sessionId, inputSeq: ++seq, baseRevision: c.revision, operationId: `proof-${seq}`, changes: [], complete: true, patch }); c = await core.read(c.sessionId); };
    await write({ updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '中文𠮷重复重复尾' } }], correspondence: [] });
    let captured = selection(c, [c.unit.reading.blocks[0]]); captured.fragments[0].to = 7; captured.fragments[0].quote = '文𠮷重复重复';
    const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'proof-note', selection: captured, text: '一条批注' });
    const old = c.unit.reading.blocks[0], ids = c.unit.reading.blocks.map(b => b.id), tail = { id: 'split-tail', kind: 'paragraph', payload: { text: '重复尾' } };
    await write({ updates: [{ blockId: a.id, before: old.payload, after: { ...old.payload, text: '中文𠮷重复' } }], structure: { parentId: c.unit.id, before: ids, after: [a.id, tail.id, ...ids.slice(1)], inserted: [tail] }, correspondence: [{ kind: 'split', sourceId: a.id, targetId: tail.id, offset: 5 }] });
    let notes = await core.annotations.list({ sessionId: c.sessionId });
    assert.equal(notes.length, 1); assert.equal(notes[0].current.status, 'attached');
    assert.deepEqual(notes[0].current.fragments.map(f => [f.blockId, f.from, f.to, f.quote]), [[a.id, 1, 5, '文𠮷重复'], [tail.id, 0, 2, '重复']]);
    await write({ updates: [{ blockId: a.id, before: c.unit.reading.blocks[0].payload, after: old.payload }], structure: { parentId: c.unit.id, before: c.unit.reading.blocks.map(b => b.id), after: ids, inserted: [] }, correspondence: [{ kind: 'merge', sourceId: tail.id, targetId: a.id, offset: 5 }] });
    notes = await core.annotations.list({ sessionId: c.sessionId }); assert.equal(notes[0].current.status, 'attached');
    await write({ updates: [], structure: { parentId: c.unit.id, before: ids, after: [...ids.slice(1), a.id], inserted: [] }, correspondence: [{ kind: 'move', sourceId: a.id, targetId: a.id }] });
    assert.equal((await core.annotations.list({ sessionId: c.sessionId }))[0].current.status, 'attached');
    await write({ updates: [{ blockId: a.id, before: old.payload, after: { ...old.payload, text: '重复，另一处重复' } }], correspondence: [] });
    notes = await core.annotations.list({ sessionId: c.sessionId }); assert.equal(notes[0].current.status, 'orphan'); assert.deepEqual(notes[0].original, note.original);
    await write({ updates: [{ blockId: a.id, before: c.unit.reading.blocks.at(-1)!.payload, after: old.payload }], correspondence: [], restorations: [old] });
    assert.equal((await core.annotations.list({ sessionId: c.sessionId }))[0].current.status, 'attached', 'exact saved Undo recovers correspondence');
    const order = c.unit.reading.blocks.map(b => b.id);
    await write({ updates: [], structure: { parentId: c.unit.id, before: order, after: order.filter(id => id !== a.id), inserted: [] }, correspondence: [] });
    notes = await core.annotations.list({ sessionId: c.sessionId }); assert.equal(notes[0].current.status, 'orphan');
    const rebound = await core.annotations.reassociate({ sessionId: c.sessionId, operationId: 'rebind', id: note.id, expectedVersion: notes[0].version, selection: selection(c) });
    assert.equal(rebound.id, note.id); assert.deepEqual(rebound.original, note.original); assert.equal(rebound.current.status, 'attached');
    assert.deepEqual(c.unit.reading.blocks.filter(b => b.kind !== 'paragraph'), originalUnit.reading.blocks.filter(b => b.kind !== 'paragraph'));
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('late old displayed offsets remain on their immutable version after a producer rewrite; a different same-name block cannot steal them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-old-selection-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), captured = selection(c), target = c.unit.reading.blocks[0];
    const attempt = await core.commands.startAttempt({ sessionId: c.sessionId, taskId: 'rewrite-before-note' });
    const basis = await core.commands.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [target.id] });
    const object = basis.objects.find(o => o.id === target.id)!;
    await core.commands.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'rewrite-before-note', changes: [{ objectId: target.id, value: { ...object.value, payload: { ...target.payload, text: '现在内容完全不同' } } }] });
    const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'old-capture', selection: captured, text: '屏幕原文' });
    assert.deepEqual(note.original, captured); assert.equal(note.current.status, 'orphan');
    assert.equal(note.current.fragments[0].from, 1); assert.equal(note.original.fragments[0].projection.encoding, 'unicode-code-points');
    assert.equal(note.original.fragments[0].block.payload.text, target.payload.text);
    await assert.rejects(core.annotations.create({ sessionId: c.sessionId, operationId: 'forged', text: '', selection: { ...captured, fragments: [{ ...captured.fragments[0], block: { ...target, payload: { text: '伪造版本' } } }] } }), /版本无法核对/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('a captured student projection can be formalized before annotation IPC without relabeling its displayed basis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-draft-anchor-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), b = c.unit.reading.blocks[0];
    const captured = selection(c, [{ ...b, payload: { ...b.payload, text: '草稿𠮷原语境' } }]); captured.fragments[0].source = 'student-draft';
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'formalize-before-note', inputSeq: 1, baseRevision: c.revision, complete: true, changes: [{ blockId: b.id, text: '草稿𠮷原语境' }] });
    const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'draft-note', selection: captured, text: '草稿上的思考' });
    assert.deepEqual(note.original, captured); assert.equal(note.current.status, 'attached');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('annotation relocation, formal body, original note and receipts share the real SQLite rollback boundary', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-note-atomic-')); const core = new CourseService(resolve('dist/worker.cjs')); let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const c = await core.open(root), b = c.unit.reading.blocks[0];
    const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'atomic-note', selection: selection(c), text: '不可丢失' });
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER annotation_fail AFTER UPDATE ON personal_notes BEGIN SELECT RAISE(ABORT, 'annotation transaction failure'); END");
    const command = { sessionId: c.sessionId, operationId: 'atomic-body', inputSeq: 1, baseRevision: c.revision, complete: true, changes: [{ blockId: b.id, text: '改写原文' }] };
    await assert.rejects(core.commitEdit(command), /annotation transaction failure/);
    assert.deepEqual((await core.read(c.sessionId)).unit, c.unit); assert.deepEqual(await core.annotations.list({ sessionId: c.sessionId }), [note]);
    assert.equal(await core.queryOperation(c.sessionId, 'atomic-body'), null);
    fault.exec('DROP TRIGGER annotation_fail');
    await core.commitEdit(command); assert.equal((await core.annotations.list({ sessionId: c.sessionId }))[0].current.status, 'orphan');
    const orphan = (await core.annotations.list({ sessionId: c.sessionId }))[0];
    fault.exec("CREATE TRIGGER note_receipt_fail BEFORE INSERT ON annotation_operations BEGIN SELECT RAISE(ABORT, 'note receipt failure'); END");
    const update = { sessionId: c.sessionId, operationId: 'atomic-edit-note', id: note.id, expectedVersion: note.version, text: '更新笔记' };
    await assert.rejects(core.annotations.update(update), /note receipt failure/);
    assert.deepEqual(await core.annotations.list({ sessionId: c.sessionId }), [orphan]);
    assert.equal(await core.annotations.query({ sessionId: c.sessionId, operationId: update.operationId }), null);
    fault.exec('DROP TRIGGER note_receipt_fail');
    const saved = await core.annotations.update(update); assert.equal(saved.text, '更新笔记');
    assert.deepEqual(await core.annotations.update(update), saved);
    await assert.rejects(core.commitEdit({ ...command, operationId: update.operationId, inputSeq: 2, baseRevision: 2 }), /操作身份已用于个人笔记/);
  } finally { fault?.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('rewriting the same complete text later is not an Undo proof and cannot silently reclaim an orphan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-no-guessed-restore-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root); const block = c.unit.reading.blocks[0];
    const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'no-guess-note', selection: selection(c, [block]), text: '保持这一次出现的身份' });
    for (const [i, text] of ['完全改写', String(block.payload.text)].entries()) {
      await core.commitEdit({ sessionId: c.sessionId, operationId: `no-guess-${i}`, inputSeq: i + 1, baseRevision: c.revision, complete: true, changes: [{ blockId: block.id, text }] });
      c = await core.read(c.sessionId);
    }
    const orphan = (await core.annotations.list({ sessionId: c.sessionId }))[0];
    assert.equal(orphan.current.status, 'orphan'); assert.deepEqual(orphan.original, note.original);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('annotations and generated extensions retain both directions of the shared operation identity fence after integration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-note-extension-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    let extension = await core.extensions.open({ sessionId });
    const note = await core.annotations.create({ sessionId, operationId: 'note-owned-operation', selection: selection(c), text: '个人记录' });
    const command = { sessionId, instanceId: extension.instanceId, generation: extension.generation, operationId: 'extension-owned-operation',
      action: { kind: 'validate' as const, version: '1.0.0' as const, report: { outputs: '01101001', lifecycle: true, migration: true } } };
    await assert.rejects(core.extensions.act({ ...command, operationId: 'note-owned-operation' }), /操作身份已用于个人笔记/);
    extension = await core.extensions.act(command); assert.equal(extension.phase, 'paused');
    await assert.rejects(core.annotations.update({ sessionId, operationId: command.operationId, id: note.id, expectedVersion: note.version, text: '不能盗用扩展回执' }), /操作身份已用于扩展修改/);
    assert.deepEqual(await core.annotations.list({ sessionId }), [note]); assert.deepEqual((await core.extensions.read({ sessionId })).definition, extension.definition);
    assert.deepEqual((await core.read(sessionId)).unit, c.unit);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('active B annotation follows its own proven edit and cross-unit reassociation without touching original creation context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-b-note-')), core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const a = await core.open(root), b = await core.read(a.sessionId, 'KU-057');
    const block = b.unit.reading.blocks.find(x => x.kind === 'paragraph')!, captured = selection(b, [block]);
    const note = await core.annotations.create({ sessionId: a.sessionId, operationId: 'B-note', selection: captured, text: 'B 的理解' });
    await assert.rejects(core.annotations.create({ sessionId: a.sessionId, operationId: 'wrong-owner', selection: { ...captured, unitId: 'KU-001' }, text: 'wrong' }), /所属|单元/);
    const before = String(block.payload.text), after = '前缀' + before;
    await core.commitEdit({ sessionId: a.sessionId, unitId: b.unit.id, inputSeq: 1, baseRevision: b.revision, operationId: 'B-edit', complete: true, changes: [], patch: {
      updates: [{ blockId: block.id, before: block.payload, after: { ...block.payload, text: after } }], correspondence: [], textEdits: [{ blockId: block.id, before, after, from: 0, to: 0, inserted: '前缀' }] } });
    const latest = (await core.annotations.list({ sessionId: a.sessionId }))[0];
    assert.equal(latest.current.status, 'attached'); assert.equal(latest.current.fragments[0].from, captured.fragments[0].from + 2);
    const moved = await core.annotations.reassociate({ sessionId: a.sessionId, operationId: 'to-A', id: note.id, expectedVersion: latest.version, selection: selection(a) });
    assert.equal(moved.current.unitId, 'KU-001'); assert.deepEqual(moved.original, captured);
    assert.deepEqual((await core.read(a.sessionId)).unit, a.unit);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
