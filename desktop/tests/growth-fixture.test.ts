import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DevelopmentCourseService as CourseService } from '../../tools/desktop/course-service';
import { legacyFixture } from './migration-fixture';
import { spawnSync } from 'node:child_process';
// JS is also the directly executable opt-in fixture tool.
// @ts-ignore
import { prepareGrowthFixture } from '../scripts/prepare-growth-fixture.mjs';

test('growth copy preserves original raw payloads/revisions and identities while Core admits distinct synthetic units', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-growth-tool-'));
  const source = join(root, 'source'), target = join(root, 'target');
  let core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    await mkdir(source);
    const original = [JSON.parse(await readFile('fixtures/unit-001.json', 'utf8')), JSON.parse(await readFile('fixtures/unit-002.json', 'utf8'))];
    const graph = JSON.parse(await readFile('fixtures/graph.json', 'utf8'));
    graph.nodes = graph.nodes.filter((n: any) => original.some(u => u.id === n.id));
    const themes = new Set(graph.nodes.map((n: any) => n.themeId));
    graph.groups = graph.groups.filter((g: any) => themes.has(g.id));
    graph.edges = []; graph.layout.nodes = graph.layout.nodes.filter((n: any) => original.some(u => u.id === n.unitId));
    graph.layout.groups = graph.layout.groups.filter((g: any) => themes.has(g.themeId));
    const db = new DatabaseSync(join(source, 'course.sqlite'));
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE units(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL); PRAGMA user_version=1');
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('courseId', 'synthetic-growth-test');
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('course-graph', JSON.stringify(graph));
    for (const unit of original) db.prepare('INSERT INTO units VALUES(?,?,?)').run(unit.id, JSON.stringify(unit), 7);
    db.close();
    const sourceBytes = await readFile(join(source, 'course.sqlite'));
    const manifest = await prepareGrowthFixture({ source, target, total: 4, workerPath: join(developmentDirectory(), 'worker.cjs') });
    assert.equal(manifest.syntheticUnits, 2);
    assert.deepEqual(await readFile(join(source, 'course.sqlite')), sourceBytes);
    const opened = await core.open(target), actualGraph = await core.graph(opened.sessionId);
    assert.equal(actualGraph.nodes.length, 4);
    for (const unit of original) {
      const actual = await core.read(opened.sessionId, unit.id);
      assert.deepEqual(actual.unit, unit); assert.equal(actual.revision, 7);
    }
    const synthetic = await core.readUnit(opened.sessionId, manifest.appended[0].id);
    assert.match(synthetic.name, /合成负载/);
    assert.notEqual(synthetic.reading.blocks[0].id, original[0].reading.blocks[0].id);
    await assert.rejects(prepareGrowthFixture({ source, target, total: 5, workerPath: join(developmentDirectory(), 'worker.cjs') }), /new|新|exists/i);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('growth tooling respects final T25 authority: a verified copy cannot publish itself and a published portable copy grows without rewriting its proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-growth-authority-'));
  const source = join(root, 'legacy'), candidate = join(root, 'content'), published = join(root, 'published'), target = join(root, 'growth');
  let core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    await legacyFixture(source);
    const made = spawnSync('python3', ['-B', resolve('tests/personal-migration-fixture.py'), source], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    await core.migration.convert({ sourceDirectory: source, directory: candidate });
    const prepared = await core.migration.prepare({ sourceDirectory: source, contentCandidateDirectory: candidate, directory: published, operationId: 'synthetic-growth-authority' });
    assert.equal(prepared.phase, 'verified');
    await assert.rejects(prepareGrowthFixture({ source: published, target: join(root, 'unpublished-copy'), total: 4, workerPath: join(developmentDirectory(), 'worker.cjs') }), /尚未发布|未发布|切换/);
    await core.migration.publish({ sourceDirectory: source, operationId: 'synthetic-growth-authority' });
    await core.close();
    const proof = await readFile(join(published, 'directory-authority.json'));
    const manifest = await prepareGrowthFixture({ source: published, target, total: 4, workerPath: join(developmentDirectory(), 'worker.cjs') });
    assert.equal(manifest.syntheticUnits, 2);
    assert.deepEqual(await readFile(join(target, 'directory-authority.json')), proof);
    core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
    const status = await core.migration.status({ directory: target });
    assert.equal(status.role, 'target'); assert.equal(status.phase, 'published');
    const opened = await core.open(target); assert.equal((await core.graph(opened.sessionId)).nodes.length, 4);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
