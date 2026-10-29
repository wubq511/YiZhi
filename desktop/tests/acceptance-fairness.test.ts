import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { exerciseDirtyIndex, prepareLongHistory, exerciseHistoryPreview, exerciseParserPreparation } from './acceptance-workload';
import { parsingFixture } from './parsing-fixture';

test('course B reads and acknowledges its latest input during a real dirty-index rebuild in the shared Core', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-overlap-'));
  const core = new CourseService(resolve('dist/worker.cjs'), { observe: true });
  try {
    const a = await core.open(join(root, 'a')), b = await core.open(join(root, 'b'));
    const evidence = await exerciseDirtyIndex(core, a, b);
    assert.ok(evidence.pendingAtStart > 0);
    assert.equal(evidence.pendingAtEnd, 0);
    assert.ok(evidence.progress.acknowledgedWhileActive);
    assert.ok(evidence.progress.readBackWhileActive);
    assert.equal(evidence.progress.savedText, evidence.progress.readText);
    assert.ok(evidence.progress.inputSeq > b.confirmedInputSeq);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('course B reads and saves while the real parser is preparing another course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-parse-overlap-'));
  const core = new CourseService(resolve('dist/worker.cjs'), { observe: true });
  try {
    const a = await core.open(join(root, 'a')), b = await core.open(join(root, 'b'));
    const path = join(root, 'synthetic.pdf'); await parsingFixture(path, 1);
    const source = await core.sources.importFile({ sessionId: a.sessionId, generation: a.generation, operationId: 'synthetic-parser-source', path, title: 'Synthetic parser fairness source' });
    const evidence = await exerciseParserPreparation(core, a, b, source.version.versionId);
    assert.equal(evidence.statusAfterB, 'running');
    assert.equal(evidence.statusAtEnd, 'completed');
    assert.equal(evidence.confirmedPages, 3);
    assert.equal(evidence.progress.savedText, evidence.progress.readText);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('course B reads and saves during repeated previews over publicly committed formal history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-history-overlap-'));
  const core = new CourseService(resolve('dist/worker.cjs'), { observe: true });
  try {
    const a = await core.open(join(root, 'a')), b = await core.open(join(root, 'b'));
    const history = await prepareLongHistory(core, a, 12);
    const evidence = await exerciseHistoryPreview(core, a, b, history.anchorOperationId);
    assert.equal(history.groups, 12);
    assert.ok(evidence.progress.readBackWhileActive);
    assert.ok(evidence.previewCount > 1);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
