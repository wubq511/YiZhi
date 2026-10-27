import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('local read projection moves only the collision chain and collapse uses the latest durable manual baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-layout-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    let opened = await service.open(root);
    const unit = opened.unit;
    const original = await service.graph(opened.sessionId);
    await service.setLayout(opened.sessionId, [
      { unitId: 'KU-001', x: -10000, y: 0, width: 200 },
      { unitId: 'KU-002', x: -10000, y: 120, width: 200 },
      { unitId: 'KU-003', x: -10000, y: 240, width: 200 },
      { unitId: 'KU-004', x: -9700, y: 0, width: 200 },
    ]);
    assert.deepEqual((await service.relations.read({ sessionId: opened.sessionId })).graph.layout, (await service.graph(opened.sessionId)).layout);
    const projected = await service.projectLayout(opened.sessionId, { 'KU-001': { width: 200, height: 240 } });
    const at = (id: string) => projected.find(p => p.unitId === id)!;
    assert.equal(at('KU-002').y, 264);
    assert.equal(at('KU-003').y, 374);
    assert.equal(at('KU-004').y, 0);
    assert.deepEqual(projected.find(p => p.unitId === 'KU-080'), original.layout.nodes.find(p => p.unitId === 'KU-080'));
    await service.setLayout(opened.sessionId, [{ unitId: 'KU-002', x: -9990, y: 500, width: 260 }]);
    const collapsed = await service.projectLayout(opened.sessionId, {});
    assert.equal(collapsed.find(p => p.unitId === 'KU-002')!.y, 500);
    assert.equal(collapsed.find(p => p.unitId === 'KU-003')!.y, 240);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    opened = await service.open(root);
    const saved = (await service.graph(opened.sessionId)).layout.nodes.find(p => p.unitId === 'KU-002')!;
    assert.equal(saved.x, -9990); assert.equal(saved.y, 500); assert.equal(saved.width, 260);
    assert.deepEqual((await service.read(opened.sessionId)).unit, unit);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('width growth includes adjacent columns, active drag stays fixed, invalid batch never changes confirmed placements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-layout-width-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(root);
    await service.setLayout(opened.sessionId, [
      { unitId: 'KU-001', x: -10000, y: 0, width: 200 },
      { unitId: 'KU-002', x: -9700, y: 0, width: 200 },
      { unitId: 'KU-003', x: -9700, y: 120, width: 200 },
    ]);
    const projected = await service.projectLayout(opened.sessionId, { 'KU-001': { width: 600, height: 200 } });
    assert.equal(projected.find(n => n.unitId === 'KU-002')!.y, 224);
    assert.equal(projected.find(n => n.unitId === 'KU-003')!.y, 334);
    const fixed = { unitId: 'KU-002', x: -9990, y: 90, width: 200 };
    const dragging = await service.projectLayout(opened.sessionId, { 'KU-001': { width: 600, height: 800 } }, fixed);
    assert.equal(dragging.find(n => n.unitId === 'KU-002')!.y, 90);
    assert.equal(dragging.find(n => n.unitId === 'KU-001')!.y, 200);
    const before = await service.graph(opened.sessionId);
    await assert.rejects(service.setLayout(opened.sessionId, [
      { unitId: 'KU-001', x: 50, y: 50, width: 600 },
      { unitId: 'missing', x: 0, y: 0, width: 600 },
    ]), /无效/);
    assert.deepEqual(await service.graph(opened.sessionId), before);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});


test('SQLite failure rolls back a manual placement batch; retry confirms the same baseline after reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-layout-fault-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  let fault: DatabaseSync | undefined;
  try {
    let c = await service.open(root);
    const before = await service.graph(c.sessionId);
    const updates = [{ unitId: 'KU-001', x: 500, y: 800, width: 750 }, { unitId: 'KU-002', x: 1500, y: 800, width: 650 }];
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER reject_layout BEFORE INSERT ON layout_baseline WHEN NEW.unit_id='KU-002' BEGIN SELECT RAISE(ABORT, 'layout disk unavailable'); END");
    await assert.rejects(service.setLayout(c.sessionId, updates), /layout disk unavailable/);
    assert.deepEqual(await service.graph(c.sessionId), before);
    fault.exec('DROP TRIGGER reject_layout');
    await service.setLayout(c.sessionId, updates);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs')); c = await service.open(root);
    const reopened = await service.graph(c.sessionId);
    for (const update of updates) assert.deepEqual(reopened.layout.nodes.find(n => n.unitId === update.unitId), { ...before.layout.nodes.find(n => n.unitId === update.unitId), ...update });
    await assert.rejects(service.projectLayout(c.sessionId, { 'KU-001': { width: -1, height: 20 } }), /尺寸无效/);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
