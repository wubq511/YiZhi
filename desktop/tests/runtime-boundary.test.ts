import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { CourseService } from '../src/core/course-service';

class BoundaryProbe extends CourseService {
  invoke(action: string, payload?: unknown): Promise<unknown> { return this.request(action, payload); }
}
test('formal course service exposes learning resources and refuses development and retired commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-runtime-boundary-'));
  const service = new BoundaryProbe(resolve(process.env.YIZHI_RUNTIME_WORKER ?? 'dist/worker.cjs'));
  try {
    assert.equal('migration' in service, false);
    assert.equal('exchange' in service, false);
    const opened = await service.open(root);
    assert.equal(opened.courseFormat, 2);
    assert.equal((await service.format.inspect({directory:root})).minimumReader,2);
    for (const action of ['migration:content', 'migration:records', 'migration:convert', 'exchange:available', 'exchange:importPackage'])
      await assert.rejects(service.invoke(action, { sessionId: opened.sessionId }), /未知课程命令/);
  } finally { await service.close(); await rm(root, {recursive:true, force:true}); }
});
