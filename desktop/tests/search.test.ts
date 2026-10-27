import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('offline search finds actual nested knowledge, aliases, short words and distinct literal mathematical symbols in the ten delivered units', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root);
    const find = (query: string) => core.search.query({ sessionId: c.sessionId, query, scopes: ['knowledge'] });
    const aliases = await find('Nibble');
    assert.ok(aliases.hits.some(h => h.entityId === 'KU-004' && h.field.startsWith('aliases.')));
    for (const query of ['模', '位权', '基数']) assert.ok((await find(query)).hits.length, query);
    const unit = await core.readUnit(c.sessionId, 'KU-002');
    const nested = unit.reading.blocks.find(b => b.kind === 'exercise')!;
    const text = nested.children![0].payload.items[0];
    const hit = (await find(text.slice(0, 12))).hits.find(h => h.blockId === nested.children![0].id)!;
    assert.ok(hit); assert.ok(hit.disclosure.includes(nested.id)); assert.ok(hit.disclosure.includes(`${nested.id}:answer`));
    assert.equal(hit.quote, text.slice(0, 12)); assert.ok(hit.version); assert.equal(hit.unitId, 'KU-002');
    const first = c.unit.reading.blocks[0];
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'literal', inputSeq: 1, baseRevision: c.revision, complete: true,
      changes: [{ blockId: first.id, text: '𠮷 x² x2 A−B A-B A×B A*B " OR * NEAR( 实际正文' }] });
    for (const query of ['x²', 'x2', 'A−B', 'A-B', 'A×B', 'A*B', '" OR *', '𠮷']) {
      const h = (await find(query)).hits.find(h => h.blockId === first.id)!;
      assert.equal(h?.quote, query);
      assert.equal(Array.from(h.text).slice(h.start, h.end).join(''), query);
    }
    assert.equal((await find('假命中')).hits.length, 0);
    for (const query of ['a−b', 'X²']) assert.equal((await find(query)).hits.filter(h => h.blockId === first.id).length, 0);
    let status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    while (status.pending) status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    for (const query of ['x²', 'x2', 'A−B', 'A-B', 'A×B', 'A*B', '\" OR *', '𠮷']) assert.equal((await find(query)).hits.find(h => h.blockId === first.id)?.quote, query);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('batched disposable trigram index and dirty direct search never resurrect stale content or hidden payloads, including reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-dirty-')); let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root);
    const find = (query: string) => core.search.query({ sessionId: c.sessionId, query });
    assert.ok((await core.search.status({ sessionId: c.sessionId })).pending > 1);
    let status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 1 });
    assert.ok(status.pending > 0, 'one batch does not synchronously rebuild the whole course');
    for (let i = 0; status.pending && i < 100; i++) status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 2 });
    assert.equal(status.pending, 0);
    assert.equal((await find('Nibble')).mode, 'trigram'); assert.ok((await find('Nibble')).hits.length);
    assert.equal((await find('位权')).mode, 'literal'); assert.ok((await find('位权')).hits.length);
    assert.equal((await find('visualStatus')).hits.length, 0, 'serialized metadata is not readable prose');
    const block = c.unit.reading.blocks[0];
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'dirty-one', inputSeq: 1, baseRevision: c.revision, complete: true, changes: [{ blockId: block.id, text: '变更尚未索引的真实正文' }] });
    const dirty = await find('尚未索引'); assert.ok(dirty.hits.some(h => h.blockId === block.id)); assert.ok(dirty.directChecked > 0);
    const held = dirty.hits.find(h => h.blockId === block.id)!;
    assert.deepEqual(await core.search.locate({ sessionId: c.sessionId, hit: held }), held);
    await assert.rejects(core.search.locate({ sessionId: c.sessionId, hit: { ...held, start: 0, end: Array.from(held.text).length + 1, quote: held.text } }), /版本已变化|范围/);
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'dirty-two', inputSeq: 2, baseRevision: 2, complete: true, changes: [{ blockId: block.id, text: '已经移走旧命中' }] });
    assert.equal((await find('尚未索引')).hits.length, 0);
    await assert.rejects(core.search.locate({ sessionId: c.sessionId, hit: held }), /版本已变化/);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(root);
    assert.ok((await find('移走旧命中')).hits.length); assert.equal((await find('尚未索引')).hits.length, 0);
    status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 1 });
    assert.equal(status.pending, 0); assert.ok((await find('移走旧命中')).hits.length);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('search uses durable personal notes and actual saved message identity/version, excluding composer and hidden tool recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-personal-')); let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root); const block = c.unit.reading.blocks[0];
    const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'note-search', text: '个人推理𠮷并非课程原文', selection: { unitId: c.unit.id, fragments: [{ blockId: block.id, block, field: 'text', formalRevision: c.revision, source: 'formal', projection: { version: 1, encoding: 'unicode-code-points', text: block.payload.text }, from: 0, to: 2, quote: Array.from(block.payload.text).slice(0, 2).join('') }] } });
    const conversation = await core.agent.create({ sessionId: c.sessionId, operationId: 'conversation-search' });
    const task = await core.agent.submit({ sessionId: c.sessionId, conversationId: conversation.id, operationId: 'message-search', generation: 1, text: '持久问题的独特用语', target: { unitId: c.unit.id } });
    await core.recordAgent({ sessionId: c.sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'answer', kind: 'message', itemId: 'actual-item', text: '确实收到并持久保存的回答𠮷' });
    await core.recordAgent({ sessionId: c.sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'tool', kind: 'tool', tool: { name: 'yizhi_read_target', input: '隐藏工具参数唯一词', output: '隐藏工具结果唯一词', references: [] } });
    await core.agent.saveDraft({ sessionId: c.sessionId, conversationId: conversation.id, seq: 1, text: '尚未发送的唯一词' });
    const find = (query: string, scopes?: any) => core.search.query({ sessionId: c.sessionId, query, scopes });
    const noteHit = (await find('个人推理')).hits[0];
    assert.equal(noteHit?.noteId, note.id); assert.equal(noteHit?.version, String(note.version));
    const messageHit = (await find('保存的回答')).hits[0];
    assert.equal(messageHit?.conversationId, conversation.id); assert.equal(messageHit?.messageId, `${task.id}:actual-item`);
    assert.ok((await find('独特用语', ['messages'])).hits.length);
    assert.equal((await find('独特用语', ['knowledge'])).hits.length, 0);
    assert.equal((await find('隐藏工具')).hits.length, 0); assert.equal((await find('尚未发送')).hits.length, 0);
    assert.deepEqual(await core.search.locate({ sessionId: c.sessionId, hit: messageHit }), messageHit);
    const updated = await core.annotations.update({ sessionId: c.sessionId, operationId: 'note-new', id: note.id, expectedVersion: note.version, text: '现在笔记内容不同' });
    await assert.rejects(core.search.locate({ sessionId: c.sessionId, hit: noteHit }), /版本已变化/);
    assert.equal((await find('现在笔记')).hits[0].version, String(updated.version));
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(root);
    assert.equal((await find('保存的回答')).hits[0].messageId, messageHit.messageId);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('sources search pins actual immutable PDF page projections, isolates missing originals and repairs/reindexes without changing other scopes', async () => {
  const { sourceFixture } = await import('./source-fixture');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-sources-')); let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const path = join(root, 'original.pdf'); await sourceFixture(path, 'Unique original source phrase');
    let c = await core.open(join(root, 'course'));
    const version = (await core.sources.importFile({ sessionId: c.sessionId, generation: 1, operationId: 'search-source', path, title: '实际原件' })).version;
    const find = (query: string) => core.search.query({ sessionId: c.sessionId, query });
    const result = await find('original source');
    const hit = result.hits.find(h => h.scope === 'sources')!; assert.ok(hit);
    assert.equal(hit.versionId, version.versionId); assert.equal(hit.pdfPageIndex, 0);
    const page = await core.sources.page({ sessionId: c.sessionId, versionId: version.versionId, pdfPageIndex: 0 });
    assert.equal(hit.projectionId, page.projection.id); assert.equal(hit.text, page.projection.text);
    assert.deepEqual(await core.search.locate({ sessionId: c.sessionId, hit }), hit);
    let status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    for (let i = 0; status.pending && i < 100; i++) status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    assert.equal(status.pending, 0); assert.ok(status.noText.some(e => e.entityId === version.versionId));
    await writeFile(join(root, 'course', 'resources', version.sha256), 'corrupt source');
    const broken = await find('original source');
    assert.equal(broken.hits.filter(h => h.scope === 'sources').length, 0); assert.ok(broken.status.unreadable.some(e => e.entityId === version.versionId));
    assert.ok((await find('Nibble')).hits.length, 'bad source cannot break knowledge');
    await assert.rejects(core.search.locate({ sessionId: c.sessionId, hit }), /损坏|版本已变化/);
    await core.sources.repairFile({ sessionId: c.sessionId, generation: 1, operationId: 'search-repair', versionId: version.versionId, path });
    status = await core.search.rebuild({ sessionId: c.sessionId, retryErrors: true, batchSize: 8 });
    for (let i = 0; status.pending && i < 100; i++) status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    assert.equal(status.unreadable.length, 0); assert.ok((await find('original source')).hits.length);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(join(root, 'course'));
    assert.equal((await find('original source')).hits.find(h => h.scope === 'sources')?.versionId, version.versionId);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('pending coverage is explicit and bounded; independent course saving proceeds between real source indexing batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-bounds-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const a = await core.open(join(root, 'a')), b = await core.open(join(root, 'b'));
    for (let i = 0; i < 20; i++) {
      const conv = await core.agent.create({ sessionId: a.sessionId, operationId: `bounds-conversation-${i}` });
      await core.agent.submit({ sessionId: a.sessionId, conversationId: conv.id, operationId: `bounds-question-${i}`, generation: 1, text: `待查范围的消息${i}`, target: { unitId: a.unit.id } });
    }
    const partial = await core.search.query({ sessionId: a.sessionId, query: '消息19' });
    assert.equal(partial.directChecked, 16); assert.equal(partial.incomplete, true);
    await core.save({ sessionId: b.sessionId, operationId: 'independent-save', inputSeq: 1, baseRevision: b.revision, blockId: b.editableBlockId, text: '另一课程仍可保存' });
    assert.equal((await core.read(b.sessionId)).unit.reading.blocks[0].payload.text, '另一课程仍可保存');
    let status = await core.search.rebuild({ sessionId: a.sessionId, batchSize: 1 });
    assert.ok(status.pending > 0);
    for (let i = 0; status.pending && i < 100; i++) status = await core.search.rebuild({ sessionId: a.sessionId, batchSize: 2 });
    const final = await core.search.query({ sessionId: a.sessionId, query: '消息19' });
    assert.equal(final.incomplete, false); assert.equal(final.hits[0].quote, '消息19');
    assert.equal((await core.search.query({ sessionId: b.sessionId, query: '消息19' })).hits.length, 0);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('a failed derived index write remains unindexed and directly searchable, while an authoritative save rollback never creates a ghost hit', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-fault-')); const core = new CourseService(resolve('dist/worker.cjs')); let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const c = await core.open(root);
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_search_index BEFORE INSERT ON search_documents BEGIN SELECT RAISE(ABORT,'index disk fault'); END");
    const status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 1 });
    assert.equal(status.unreadable.length, 0, 'index write failure does not make the authority unreadable');
    assert.equal(status.indexErrors.length, 1);
    assert.ok((await core.search.query({ sessionId: c.sessionId, query: '位权' })).hits.length);
    await core.save({ sessionId: c.sessionId, operationId: 'save-despite-index', inputSeq: 1, baseRevision: 1, blockId: c.editableBlockId, text: '索引故障时保存成功' });
    assert.ok((await core.search.query({ sessionId: c.sessionId, query: '保存成功' })).hits.length);
    fault.exec("CREATE TRIGGER fail_formal_search BEFORE INSERT ON save_events WHEN json_extract(new.event,'$.type')='content.committed' BEGIN SELECT RAISE(ABORT,'formal rollback'); END");
    await assert.rejects(core.save({ sessionId: c.sessionId, operationId: 'rolled-back', inputSeq: 2, baseRevision: 2, blockId: c.editableBlockId, text: '回滚内容不得搜索到' }), /formal rollback/);
    assert.equal((await core.search.query({ sessionId: c.sessionId, query: '回滚内容' })).hits.length, 0);
    assert.ok((await core.search.query({ sessionId: c.sessionId, query: '保存成功' })).hits.length);
    fault.exec('DROP TRIGGER fail_search_index; DROP TRIGGER fail_formal_search');
    let fixed = await core.search.rebuild({ sessionId: c.sessionId, retryErrors: true, batchSize: 8 });
    while (fixed.pending) fixed = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    assert.equal(fixed.indexErrors.length, 0);
  } finally { fault?.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('retained opaque payloads stay out of search while actual readable descendants retain a disclosure path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-opaque-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), ids = c.unit.reading.blocks.map(b => b.id);
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'opaque-search', inputSeq: 1, baseRevision: 1, complete: true, changes: [], patch: { updates: [], correspondence: [], structure: { parentId: c.unit.id, before: ids, after: [...ids, 'retained-container'], inserted: [{ id: 'retained-container', kind: 'unsupported-container', payload: { hidden: '隐藏载荷唯一词' }, children: [{ id: 'visible-descendant', kind: 'paragraph', payload: { text: '实际可读子段落唯一词' } }] }] } } });
    const child = await core.search.query({ sessionId: c.sessionId, query: '实际可读子段落' });
    assert.equal(child.hits[0]?.blockId, 'visible-descendant');
    assert.deepEqual(child.hits[0].disclosure, ['retained-container:retained']);
    assert.equal((await core.search.query({ sessionId: c.sessionId, query: '隐藏载荷唯一词' })).hits.length, 0);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
