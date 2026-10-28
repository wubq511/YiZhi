import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Observation } from '../src/acceptance-observation';
import { CourseService } from '../src/core/course-service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('opt-in observation aggregates concurrent resources, retains peaks after release and does not retain samples', () => {
  const observation = new Observation();
  observation.count('disabled');
  assert.deepEqual(observation.snapshot(), {});
  observation.enable();
  const first = observation.resource('pdf.rangeBytes'), second = observation.resource('pdf.rangeBytes');
  first.set(65536); second.set(131072); first.set(0); second.close(); first.close(); first.close();
  for (let i = 0; i < 10000; i++) observation.sample('navigation.ms', i % 10);
  const snapshot = observation.snapshot();
  assert.equal(snapshot['pdf.rangeBytes'].current, 0);
  assert.equal(snapshot['pdf.rangeBytes'].peak, 196608);
  assert.equal(snapshot['navigation.ms'].count, 10000);
  assert.equal(snapshot['navigation.ms'].max, 9);
  assert.equal(Object.keys(snapshot).length, 2);
  snapshot['pdf.rangeBytes'].peak = -1;
  assert.equal(observation.snapshot()['pdf.rangeBytes'].peak, 196608, 'callers cannot rewrite captured evidence');
});

test('two distinct courses expose the same observed Core identity and actual dispatched work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-observe-'));
  const core = new CourseService(resolve('dist/worker.cjs'), { observe: true });
  try {
    const a = await core.open(join(root, 'a'));
    const before = await core.observe();
    const b = await core.open(join(root, 'b'));
    await core.readUnit(b.sessionId, b.unit.id);
    const after = await core.observe();
    assert.notEqual(a.courseId, b.courseId);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.threadId, before.threadId);
    assert.deepEqual(new Set(after.courseIds), new Set([a.courseId, b.courseId]));
    assert.equal(after.counters['core.request.readUnit.ms'].count, 1);
    assert.ok(after.memory.rss > 0);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
