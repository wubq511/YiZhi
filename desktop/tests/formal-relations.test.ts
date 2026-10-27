import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('formal relation correction crosses CourseService, persists once, and shares history/events without changing student input progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relations-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(root);
    const basis = await service.relations.read({ sessionId: opened.sessionId });
    const seed = JSON.parse(await readFile('fixtures/graph.json', 'utf8'));
    assert.equal(basis.graph.edges.length, 43);
    assert.deepEqual(basis.graph.edges, seed.edges);
    assert.deepEqual(basis.graph.requirementGroups, seed.requirementGroups);
    assert.deepEqual(basis.graph.conditions['KU-044'], { required: ['KU-029'], groups: ['G1'] });
    const original = basis.graph.edges.find(edge => edge.id === 'REL-001')!;
    const command = { sessionId: opened.sessionId, operationId: 'formal-correct', basisId: basis.basisId,
      generation: basis.generation, changes: [{ id: original.id, value: { ...original, view: 'auxiliary', value: original.value + '（副本审核说明）' } }] };
    const receipt = await service.relations.commit(command);
    assert.equal(receipt.status, 'committed');
    assert.deepEqual(await service.relations.commit(command), receipt);
    assert.equal((await service.graph(opened.sessionId)).edges.find(edge => edge.id === original.id)?.view, 'auxiliary');
    assert.equal((await service.read(opened.sessionId)).confirmedInputSeq, 0);
    const events = await service.readEvents(opened.sessionId, opened.eventCursor);
    assert.equal(events.kind, 'events');
    if (events.kind === 'events') assert.equal(events.events.filter(event => event.type === 'relations.committed').length, 1);
    assert.equal((await service.commands.history({ sessionId: opened.sessionId })).filter(h => h.operationId === command.operationId).length, 1);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    assert.deepEqual(await service.relations.query({ sessionId: reopened.sessionId, operationId: command.operationId }), receipt);
    assert.deepEqual(await service.relations.commit({ ...command, sessionId: reopened.sessionId }), receipt);
    assert.equal((await service.graph(reopened.sessionId)).edges.length, 43);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('formal candidates reject missing evidence, retired/dangling endpoints, false directions, duplicate identities and requires cycles atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relation-audit-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId } = await service.open(root);
    const basis = await service.relations.read({ sessionId });
    const edge = basis.graph.edges.find(e => e.id === 'REL-001')!;
    const invalids = [
      { ...edge, value: '' }, { ...edge, type: 'contains' }, { ...edge, fromUnitId: 'KU-049' },
      { ...edge, toUnitId: 'KU-999' }, { ...edge, directed: false }, { ...edge, sourceRefs: [] },
      { ...edge, sourceRefs: [{ sourceId: 'SRC-MISSING', pdfPages: [1] }] },
      { ...edge, sourceRefs: [{ ...edge.sourceRefs[0], versionId: 'VER-MISSING' }] },
      { ...edge, sourceRefs: [{ ...edge.sourceRefs[0], pdfPages: [9999] }] },
    ];
    for (let index = 0; index < invalids.length; index++) {
      await assert.rejects(service.relations.commit({ sessionId, generation: basis.generation, basisId: basis.basisId,
        operationId: `invalid-${index}`, changes: [{ id: edge.id, value: invalids[index] }] }));
      assert.deepEqual((await service.graph(sessionId)).edges, basis.graph.edges);
    }
    await assert.rejects(service.relations.commit({ sessionId, generation: basis.generation, basisId: basis.basisId,
      operationId: 'cycle', changes: [{ id: 'REL-cycle', value: { ...edge, id: 'REL-cycle', fromUnitId: 'KU-007', toUnitId: 'KU-006' } }] }), /环/);
    await assert.rejects(service.relations.commit({ sessionId, generation: basis.generation, basisId: basis.basisId,
      operationId: 'double', changes: [{ id: edge.id, value: edge }, { id: edge.id, value: null }] }), /重复/);
    await assert.rejects(service.relations.commit({ sessionId, generation: basis.generation, basisId: basis.basisId,
      operationId: 'identity', changes: [{ id: 'REL-new', value: edge }] }), /身份/);
    assert.equal((await service.commands.history({ sessionId })).length, 0);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('AND/OR route edits/removal are one graph transaction and stale graph bases never flatten G1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relation-routes-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId } = await service.open(root);
    const basis = await service.relations.read({ sessionId });
    const edge = basis.graph.edges.find(e => e.id === 'REL-010')!;
    const group = basis.graph.requirementGroups.find(g => g.id === 'G1')!;
    await assert.rejects(service.relations.commit({ sessionId, basisId: basis.basisId, generation: basis.generation,
      operationId: 'dangling-route', changes: [{ id: edge.id, value: null }] }), /路线组/);
    const corrected = { ...edge, value: edge.value + '（审核备注）' };
    const command = { sessionId, basisId: basis.basisId, generation: basis.generation,
      operationId: 'route-correction', changes: [{ id: edge.id, value: corrected }] };
    await service.relations.commit(command);
    const current = await service.graph(sessionId);
    assert.deepEqual(current.requirementGroups, basis.graph.requirementGroups);
    assert.deepEqual(current.conditions['KU-044'], { required: ['KU-029'], groups: ['G1'] });
    await assert.rejects(service.relations.commit({ ...command, operationId: 'stale', changes: [{ id: 'REL-011', value: null }] }), /依据已变化/);
    const next = await service.relations.read({ sessionId });
    await service.relations.commit({ sessionId, basisId: next.basisId, generation: next.generation,
      operationId: 'route-remove', changes: [{ id: edge.id, value: null }],
      groupChanges: [{ id: group.id, value: { ...group, unitIds: ['KU-035'], relationIds: ['REL-011'] } }] });
    const removed = await service.graph(sessionId);
    assert.equal(removed.edges.length, 42);
    assert.deepEqual(removed.requirementGroups[0].unitIds, ['KU-035']);
    assert.deepEqual(removed.conditions['KU-044'], { required: ['KU-029'], groups: ['G1'] });
    assert.equal(removed.themeEdges?.some(g => g.relationIds.includes('REL-010')), false);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('relation operations share generation, attempt stop ordering and operation identity with existing producers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relation-identity-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(root), { sessionId } = opened;
    const attempt = await service.commands.startAttempt({ sessionId, taskId: 'relation-agent' });
    const basis = await service.relations.read({ sessionId, attemptId: attempt.attemptId });
    const edge = basis.graph.edges.find(e => e.id === 'REL-001')!;
    const command = { sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, generation: basis.generation,
      operationId: 'agent-relation', changes: [{ id: edge.id, value: { ...edge, value: edge.value + '（Agent 审核）' } }] };
    const first = await service.relations.commit(command);
    await service.commands.stop({ sessionId, attemptId: attempt.attemptId });
    assert.deepEqual(await service.relations.commit(command), first);
    await assert.rejects(service.relations.commit({ ...command, operationId: 'late-agent-relation' }), /停止|失效/);
    await assert.rejects(service.relations.read({ sessionId, attemptId: attempt.attemptId }), /停止|失效/);
    await assert.rejects(service.relations.commit({ ...command, operationId: 'changed-identity', attemptId: undefined }), /身份|尝试/);
    const student = await service.relations.read({ sessionId });
    await assert.rejects(service.relations.commit({ sessionId, basisId: student.basisId, generation: student.generation + 1,
      operationId: 'old-generation', changes: command.changes }), /失效|依据/);
    await assert.rejects(service.save({ sessionId, operationId: first.operationId, inputSeq: 1, baseRevision: opened.revision,
      blockId: opened.editableBlockId, text: '不能与关系操作重用身份' }), /身份|操作/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('prerequisite trace retains required-plus-any G1 and never follows constructs, improves or inverse facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relation-trace-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const { sessionId } = await service.open(root);
    const trace = await service.relations.prerequisites({ sessionId, unitId: 'KU-044' });
    assert.deepEqual(trace.conditions['KU-044'], { required: ['KU-029'], groups: ['G1'] });
    assert.equal(trace.requirementGroups.find(g => g.id === 'G1')?.mode, 'any');
    assert.deepEqual(trace.requirementGroups[0].unitIds, ['KU-033', 'KU-035']);
    assert.equal(trace.edges.length, 6);
    assert.ok(trace.edges.every(edge => edge.type === 'requires'));
    const other = await service.relations.prerequisites({ sessionId, unitId: 'KU-007' });
    assert.deepEqual(other.edges.map(e => e.id), ['REL-001']);
    await assert.rejects(service.relations.prerequisites({ sessionId, unitId: 'KU-049' }), /退休|有效/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('final history/event failure rolls back a whole multi-relation group; exact retry and reopening preserve all projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relations-rollback-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  const { DatabaseSync } = await import('node:sqlite');
  let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const { sessionId } = await service.open(root);
    const basis = await service.relations.read({ sessionId });
    const edge = basis.graph.edges.find(e => e.id === 'REL-001')!;
    const added = { ...edge, id: 'REL-test-added', fromUnitId: 'KU-001', toUnitId: 'KU-044', type: 'constructs', view: 'auxiliary',
      value: '临时副本测试关系，仅验证共同事务和图投影，不作为真实课程知识。' };
    const command = { sessionId, generation: basis.generation, basisId: basis.basisId, operationId: 'atomic-relations',
      changes: [{ id: edge.id, value: { ...edge, view: 'auxiliary' } }, { id: added.id, value: added }] };
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    for (const table of ['save_events', 'cg_history']) {
      fault.exec(`CREATE TRIGGER fail_relation BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'relation final write failed'); END`);
      await assert.rejects(service.relations.commit(command), /relation final write failed/);
      assert.deepEqual(await service.graph(sessionId), basis.graph);
      assert.equal(await service.relations.query({ sessionId, operationId: command.operationId }), null);
      assert.equal((await service.commands.history({ sessionId })).length, 0);
      fault.exec('DROP TRIGGER fail_relation');
    }
    const receipt = await service.relations.commit(command);
    assert.equal(receipt.changedObjectIds.length, 2);
    const graph = await service.graph(sessionId);
    assert.equal(graph.edges.filter(e => e.view === 'main').length, 27);
    assert.equal(graph.edges.filter(e => e.view === 'auxiliary').length, 17);
    assert.equal(graph.counts?.relations, 44);
    assert.deepEqual(graph.themeEdges?.find(g => g.fromThemeId === 'TH-01' && g.toThemeId === 'TH-10')?.relationIds, ['REL-test-added']);
    assert.equal((await service.relations.prerequisites({ sessionId, unitId: 'KU-044' })).edges.some(e => e.id === added.id), false);
    fault.close(); fault = undefined;
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    assert.deepEqual(await service.graph(reopened.sessionId), graph);
    assert.deepEqual(await service.relations.commit({ ...command, sessionId: reopened.sessionId }), receipt);
    const next = await service.relations.read({ sessionId: reopened.sessionId });
    await service.relations.commit({ sessionId: reopened.sessionId, generation: next.generation, basisId: next.basisId,
      operationId: 'remove-added', changes: [{ id: added.id, value: null }] });
    const after = await service.graph(reopened.sessionId);
    assert.equal(after.edges.length, 43);
    assert.equal(after.themeEdges?.some(g => g.relationIds.includes(added.id)), false);
    const retired = await service.relations.read({ sessionId: reopened.sessionId });
    await assert.rejects(service.relations.commit({ sessionId: reopened.sessionId, generation: retired.generation, basisId: retired.basisId,
      operationId: 'reuse-retired-relation', changes: [{ id: added.id, value: added }] }), /退休/);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a rejected operation keeps its immutable identity without publishing facts; changed payload/basis needs a new operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relation-rejected-id-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(root), { sessionId } = opened;
    const basis = await service.relations.read({ sessionId });
    const edge = basis.graph.edges.find(e => e.id === 'REL-001')!;
    const command = { sessionId, generation: basis.generation, basisId: basis.basisId, operationId: 'rejected-fixed-id',
      changes: [{ id: edge.id, value: { ...edge, value: '' } }] };
    await assert.rejects(service.relations.commit(command), /具体信息价值/);
    await assert.rejects(service.relations.commit({ ...command, changes: [{ id: edge.id, value: { ...edge, value: edge.value + '（修改后的候选）' } }] }), /同一操作/);
    await assert.rejects(service.save({ sessionId, operationId: command.operationId, inputSeq: 1, baseRevision: opened.revision,
      blockId: opened.editableBlockId, text: '不得重用失败关系操作身份' }), /身份/);
    assert.equal(await service.relations.query({ sessionId, operationId: command.operationId }), null);
    assert.deepEqual((await service.graph(sessionId)).edges, basis.graph.edges);
    assert.equal((await service.commands.history({ sessionId })).length, 0);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
