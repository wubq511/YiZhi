import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { DescriptionRuntime } from '../src/agent/description-search';
async function finished(runtime: DescriptionRuntime, sessionId: string, id: string) {
  for (let n = 0; n < 200; n++) { const run = await runtime.get({ sessionId, id }); if (run.state !== 'running') return run; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('description did not finish');
}

test('description rewrite and reorder return only actual CourseService hits with checkable query identities, without a QA message or board/state/draft change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-')), core = new CourseService(resolve('dist/worker.cjs'));
  const cliPath = resolve('dist/tests/description-executor-fixture.cjs'); await chmod(cliPath, 0o755);
  const runtime = new DescriptionRuntime(core, { directory: join(root, 'executor'), cliPath });
  try {
    const c = await core.open(join(root, 'course')), sessionId = c.sessionId;
    const conversation = await core.agent.create({ sessionId, operationId: 'description-draft' });
    await core.agent.saveDraft({ sessionId, conversationId: conversation.id, seq: 1, text: '不能替我发送的问题' });
    const before = await core.agent.get({ sessionId, conversationId: conversation.id }), review = await core.reviewStates(sessionId);
    const request = { sessionId, id: 'description-request', description: '同一个数字放到不同的位置，值怎么就变了', scopes: ['knowledge'] as const };
    const started = await runtime.start({ ...request, scopes: [...request.scopes] });
    const result = await finished(runtime, sessionId, started.id);
    assert.equal(result.state, 'completed', result.error); assert.ok(result.hits.length);
    assert.equal(result.queries[0].query, '位权'); assert.ok(result.queries[0].callId);
    const actual = await core.search.query({ sessionId, query: '位权', scopes: ['knowledge'], limit: 8 });
    assert.deepEqual(result.hits.map(h => h.hit), actual.hits.slice(0, 2).reverse());
    for (const selected of result.hits) {
      assert.ok(result.queries[0].hitIds.includes(selected.id));
      assert.equal(selected.basis[0].queryId, result.queries[0].id);
      assert.equal(selected.basis[0].query, '位权');
      assert.deepEqual(await core.search.locate({ sessionId, hit: selected.hit }), selected.hit);
    }
    assert.ok(!JSON.stringify(result).includes('模型新解释'));
    assert.deepEqual((await core.read(sessionId)).unit, c.unit); assert.deepEqual(await core.reviewStates(sessionId), review);
    assert.deepEqual(await core.agent.get({ sessionId, conversationId: conversation.id }), before);
    assert.deepEqual(await runtime.start({ ...request, scopes: [...request.scopes] }), result, 'exact request retry does not invoke inference twice');
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('invented IDs, invented quotes, QA/filesystem tools and model prose never become existing-content results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-forged-')), core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new DescriptionRuntime(core, { directory: join(root, 'executor'), cliPath: resolve('dist/tests/description-executor-fixture.cjs'), env: { ...process.env, YIZHI_DESCRIPTION_FIXTURE: 'invented' } });
  try {
    const c = await core.open(join(root, 'course'));
    const run = await runtime.start({ sessionId: c.sessionId, id: 'forged-result', description: '想找位置和值的讲解', scopes: ['knowledge'] });
    const result = await finished(runtime, c.sessionId, run.id);
    assert.equal(result.state, 'failed'); assert.equal(result.hits.length, 0); assert.ok(result.queries[0].hitIds.length);
    assert.match(result.error!, /可核对/); assert.equal(result.toolErrors.length, 4);
    assert.ok(!JSON.stringify(result.hits).includes('伪造'));
    assert.deepEqual((await core.read(c.sessionId)).unit, c.unit);
    assert.ok((await core.search.query({ sessionId: c.sessionId, query: '位权' })).hits.length);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['no-hit', 'failed', 'disconnect', 'malformed']) test(`description ${mode} preserves actual query coverage and leaves literal search available`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-failure-')), core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new DescriptionRuntime(core, { directory: join(root, 'executor'), cliPath: resolve('dist/tests/description-executor-fixture.cjs'), env: { ...process.env, YIZHI_DESCRIPTION_FIXTURE: mode } });
  try {
    const c = await core.open(join(root, 'course'));
    const run = await runtime.start({ sessionId: c.sessionId, id: `request-${mode}`, description: '记得按位置区分数值', scopes: ['knowledge'] });
    const result = await finished(runtime, c.sessionId, run.id);
    assert.equal(result.state, mode === 'no-hit' ? 'completed' : 'failed', result.error);
    assert.equal(result.hits.length, 0); assert.equal(result.queries.length, 1);
    if (mode === 'no-hit') { assert.equal(result.outcome, 'no-hit'); assert.deepEqual(result.queries[0].hitIds, []); assert.equal(result.queries[0].incomplete, false); }
    assert.ok((await core.search.query({ sessionId: c.sessionId, query: '基数' })).hits.length);
    assert.deepEqual((await core.read(c.sessionId)).unit, c.unit);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('simultaneous exact retries share one request; cancellation and stale hit versions cannot publish late results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-race-')), core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new DescriptionRuntime(core, { directory: join(root, 'executor'), cliPath: resolve('dist/tests/description-executor-fixture.cjs'), env: { ...process.env, YIZHI_DESCRIPTION_FIXTURE: 'stale' } });
  try {
    const c = await core.open(join(root, 'course'));
    const request = { sessionId: c.sessionId, id: 'concurrent', description: '位置影响一个数字的数值', scopes: ['knowledge'] as const };
    const [a, b] = await Promise.all([runtime.start({ ...request, scopes: [...request.scopes] }), runtime.start({ ...request, scopes: [...request.scopes] })]);
    assert.equal(a.id, b.id);
    for (let i = 0; i < 100; i++) { if ((await runtime.get({ sessionId: c.sessionId, id: a.id })).queries.length) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    await core.save({ sessionId: c.sessionId, operationId: 'user-change-during-search', inputSeq: 1, baseRevision: 1, blockId: c.editableBlockId, text: '用户独立更新了这段内容' });
    const result = await finished(runtime, c.sessionId, a.id);
    assert.equal(result.state, 'completed', result.error); assert.equal(result.hits.length, 0); assert.equal(result.rejected.length, 2);
    await assert.rejects(runtime.start({ ...request, scopes: [...request.scopes], description: '同一请求换内容' }), /不能换用/);
    await assert.rejects(runtime.get({ sessionId: 'other-course-session', id: a.id }), /当前课程/);
    const cancel = await runtime.start({ ...request, scopes: [...request.scopes], id: 'cancelled' });
    assert.equal((await runtime.cancel({ sessionId: c.sessionId, id: cancel.id })).state, 'cancelled');
    await runtime.close();
    assert.equal((await runtime.get({ sessionId: c.sessionId, id: cancel.id })).hits.length, 0);
    assert.equal((await core.read(c.sessionId)).unit.reading.blocks[0].payload.text, '用户独立更新了这段内容');
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('description preserves source unreadable, textless and unindexed distinctions from actual query coverage', async () => {
  const { sourceFixture } = await import('./source-fixture'); const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-coverage-')), core = new CourseService(resolve('dist/worker.cjs'));
  const runtime = new DescriptionRuntime(core, { directory: join(root, 'executor'), cliPath: resolve('dist/tests/description-executor-fixture.cjs') });
  try {
    const c = await core.open(join(root, 'course')), path = join(root, 'original.pdf'); await sourceFixture(path);
    const good = (await core.sources.importFile({ sessionId: c.sessionId, operationId: 'good-original', generation: 1, path, title: '带图像页的原件' })).version;
    const bad = (await core.sources.importFile({ sessionId: c.sessionId, operationId: 'bad-original', generation: 1, path, title: '损坏的原件' })).version;
    await writeFile(join(root, 'course/resources', bad.sha256), 'damaged shared bytes');
    // Both imports share immutable bytes; exact repair recovers both, then one independent source is damaged.
    await core.sources.repairFile({ sessionId: c.sessionId, generation: 1, operationId: 'repair-shared', versionId: good.versionId, path });
    const other = join(root, 'different.pdf'); await sourceFixture(other, 'Different readable version');
    const broken = (await core.sources.importFile({ sessionId: c.sessionId, operationId: 'separate-bad', generation: 1, path: other, title: '单独损坏' })).version;
    await writeFile(join(root, 'course/resources', broken.sha256), 'actual missing/corrupt original');
    let status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    while (status.pending) status = await core.search.rebuild({ sessionId: c.sessionId, batchSize: 8 });
    const run = await runtime.start({ sessionId: c.sessionId, id: 'coverage-request', description: '想找位置的权', scopes: ['knowledge', 'sources'] });
    const result = await finished(runtime, c.sessionId, run.id);
    assert.ok(result.hits.length); assert.equal(result.queries[0].status.unreadable[0].entityId, broken.versionId);
    assert.ok(result.queries[0].status.noText.some(p => p.entityId === good.versionId));
    assert.equal(result.queries[0].incomplete, false); assert.equal(result.queries[0].status.pending, 0);
  } finally { await runtime.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('missing CLI and a bounded remote deadline fail only enhancement, without waiting for index rebuild or changing literal search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-unavailable-')), core = new CourseService(resolve('dist/worker.cjs'));
  const missing = new DescriptionRuntime(core, { directory: join(root, 'missing'), cliPath: join(root, 'absent') });
  const held = new DescriptionRuntime(core, { directory: join(root, 'held'), cliPath: resolve('dist/tests/description-executor-fixture.cjs'), deadlineMs: 800, env: { ...process.env, YIZHI_DESCRIPTION_FIXTURE: 'linger' } });
  try {
    const c = await core.open(join(root, 'course')), pending = await core.search.status({ sessionId: c.sessionId });
    assert.equal((await missing.status()).available, false);
    const unavailable = await missing.start({ sessionId: c.sessionId, id: 'no-cli', description: '位置和值', scopes: ['knowledge'] });
    assert.equal((await finished(missing, c.sessionId, unavailable.id)).state, 'failed');
    const waiting = await held.start({ sessionId: c.sessionId, id: 'deadline', description: '位置和值', scopes: ['knowledge'] });
    assert.ok((await core.search.query({ sessionId: c.sessionId, query: '基数' })).hits.length);
    assert.equal((await core.search.status({ sessionId: c.sessionId })).pending, pending.pending, 'description performs no rebuild');
    const expired = await finished(held, c.sessionId, waiting.id); assert.equal(expired.state, 'failed'); assert.match(expired.error!, /超时/);
    assert.equal(expired.hits.length, 0); assert.deepEqual((await core.read(c.sessionId)).unit, c.unit);
  } finally { await missing.close(); await held.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});
