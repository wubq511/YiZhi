import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CourseService } from '../src/core/course-service';
import { CourseOpening } from '../src/host/course-opening';
import { fork } from 'node:child_process';
import { once } from 'node:events';

async function sourceBytes(directory: string) {
  return Promise.all(['course.sqlite', 'course.sqlite-wal'].map(async name => {
    try { return await readFile(join(directory, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }));
}

async function oldDesktopCourse(directory: string) {
  const seed = new CourseService(resolve('dist/worker.cjs'));
  try { await seed.open(directory); } finally { await seed.close(); }
  const db = new DatabaseSync(join(directory, 'course.sqlite'));
  try { db.exec("PRAGMA user_version=1; DELETE FROM metadata WHERE key='minimum-reader'"); }
  finally { db.close(); }
}

test('new and current courses open directly while a newer unsupported format remains untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-auto-format-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const source = join(root, 'course'), opening = new CourseOpening(core);
    assert.equal((await opening.open(source)).opened.courseFormat, 2);
    assert.equal((await opening.open(source)).directory, await realpath(source));
    assert.deepEqual(await readdir(root), ['course']);
    await core.close();
    const db = new DatabaseSync(join(source, 'course.sqlite')); db.exec('PRAGMA user_version=999'); db.close();
    const before = await readFile(join(source, 'course.sqlite'));
    const newer = new CourseService(resolve('dist/worker.cjs'));
    try { await assert.rejects(new CourseOpening(newer).open(source), /不支持|版本/); }
    finally { await newer.close(); }
    assert.deepEqual(await readFile(join(source, 'course.sqlite')), before);
    assert.deepEqual(await readdir(root), ['course']);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('normal course admission upgrades an old desktop course once, verifies its independent backup, and rejoins the published course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-auto-opening-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const source = join(root, 'course'); await oldDesktopCourse(source);
    const opening = new CourseOpening(core);
    const result = await opening.open(source);
    assert.equal(result.opened.courseFormat, 2);
    assert.notEqual(result.directory, source);
    const status = await core.upgrade.status({ directory: source });
    assert.equal(status.decision?.phase, 'published');
    assert.equal((await core.backup.verify({ directory: status.decision!.report.backupDirectory })).phase, 'complete');
    const files = await readdir(root);
    const reopened = await opening.open(source);
    assert.equal(reopened.directory, result.directory);
    assert.equal(reopened.opened.sessionId, result.opened.sessionId);
    assert.deepEqual(await readdir(root), files);
    await assert.rejects(core.open(source), /目标|权威|迁移/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

for (const point of ['beforePublish', 'afterPublish']) test('ordinary reopen reconciles SIGKILL ' + point + ' without asking for upgrade steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-auto-kill-'));
  let child: ReturnType<typeof fork> | undefined;
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const source = join(root, 'course'); await oldDesktopCourse(source);
    child = fork(resolve('dist/tests/automatic-opening-process.cjs'), [source, point], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const [event] = await once(child, 'message'); assert.deepEqual(event, { point });
    child.kill('SIGKILL'); await once(child, 'exit'); child = undefined;
    const job = JSON.parse(await readFile(join(source, 'automatic-upgrade.json'), 'utf8'));
    const result = await new CourseOpening(core).open(source);
    assert.equal(result.directory, job.directory);
    assert.equal(result.opened.courseFormat, 2);
    assert.equal((await core.upgrade.status({ directory: source })).decision?.phase, 'published');
    assert.equal((await core.backup.verify({ directory: job.backupDirectory })).phase, 'complete');
    await assert.rejects(core.open(source), /权威|目标|迁移/);
  } finally { child?.kill('SIGKILL'); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('a failed work-copy check keeps the original and complete backup, and reopening retries the same automatic maintenance identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-auto-retry-')), gate = new SharedArrayBuffer(4);
  let core = new CourseService(resolve('dist/worker.cjs'), { upgradeScheduling: { beforeValidation: gate } });
  try {
    const source = join(root, 'course'); await oldDesktopCourse(source);
    const pending = new CourseOpening(core).open(source); pending.catch(() => {});
    const end = Date.now() + 20000;
    while (Atomics.load(new Int32Array(gate), 0) !== 1) {
      if (Date.now() > end) throw new Error('维护阶段未到达');
      await new Promise(r => setTimeout(r, 5));
    }
    const job = JSON.parse(await readFile(join(source, 'automatic-upgrade.json'), 'utf8'));
    const fault = new DatabaseSync(join(job.directory, 'course.sqlite'));
    fault.exec("PRAGMA foreign_keys=OFF; INSERT INTO source_citations VALUES('broken','missing-source','{}')"); fault.close();
    Atomics.store(new Int32Array(gate), 0, 2);
    await assert.rejects(pending, /结构|外键/);
    assert.equal((await core.format.inspect({ directory: source })).courseFormat, 1);
    const backup = await core.backup.verify({ directory: job.backupDirectory });
    await core.close(); core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(source), beforeIdle = await sourceBytes(source);
    await assert.rejects(core.setReviewStatus(reopened.sessionId, 'KU-001', 'mastered'), /升级|停/);
    assert.equal((await core.format.inspect({ directory: source })).courseFormat, 1);
    await new Promise(r => setTimeout(r, 1250));
    assert.deepEqual(await sourceBytes(source), beforeIdle);
    const result = await new CourseOpening(core).open(source);
    assert.equal(result.directory, job.directory);
    assert.equal(result.opened.courseFormat, 2);
    assert.equal((await core.backup.verify({ directory: job.backupDirectory })).database?.sha256, backup.database?.sha256);
    assert.equal((await core.upgrade.status({ directory: source })).decision?.operationId, 'upgrade:' + job.upgradeId);
  } finally { Atomics.store(new Int32Array(gate), 0, 2); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('automatic maintenance retries in the same Core after failure feedback and idle time without changing the original or blocking another course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-auto-idle-retry-')), gate = new SharedArrayBuffer(4);
  const core = new CourseService(resolve('dist/worker.cjs'), { upgradeScheduling: { beforeValidation: gate } });
  const reached = async () => {
    const end = Date.now() + 20000;
    while (Atomics.load(new Int32Array(gate), 0) !== 1) {
      if (Date.now() > end) throw new Error('维护阶段未到达');
      await new Promise(r => setTimeout(r, 5));
    }
  };
  try {
    const source = join(root, 'course'); await oldDesktopCourse(source);
    const other = await core.open(join(root, 'other')), opening = new CourseOpening(core);
    const pending = opening.open(source); pending.catch(() => {});
    await reached();
    const job = JSON.parse(await readFile(join(source, 'automatic-upgrade.json'), 'utf8'));
    const fault = new DatabaseSync(join(job.directory, 'course.sqlite'));
    try { fault.exec("PRAGMA foreign_keys=OFF; INSERT INTO source_citations VALUES('broken','missing-source','{}')"); }
    finally { fault.close(); }
    Atomics.store(new Int32Array(gate), 0, 2);
    await assert.rejects(pending, /结构|外键/);

    // The failed-open UI inspects the format; subsequent successful requests must
    // not restart this course's one-second idle history/resource maintenance.
    assert.equal((await core.format.inspect({ directory: source })).courseFormat, 1);
    const original = await core.open(source);
    const beforeIdle = await sourceBytes(source);
    const backup = await core.backup.verify({ directory: job.backupDirectory });
    await assert.rejects(core.setReviewStatus(original.sessionId, 'KU-001', 'mastered'), /升级|停/);
    await assert.rejects(core.commands.startAttempt({ sessionId: original.sessionId, taskId: 'blocked-during-maintenance' }), /升级|停/);
    await core.save({ ...other, operationId: 'other-course-during-maintenance', inputSeq: 1,
      baseRevision: other.revision, blockId: other.editableBlockId, text: '另一门课程仍可保存' });
    await new Promise(r => setTimeout(r, 1250));
    assert.equal((await core.read(other.sessionId)).unit.reading.blocks[0].payload.text, '另一门课程仍可保存');
    assert.deepEqual(await sourceBytes(source), beforeIdle);

    const retry = opening.open(source); retry.catch(() => {});
    await reached();
    Atomics.store(new Int32Array(gate), 0, 2);
    const result = await retry;
    assert.equal(result.directory, job.directory);
    assert.equal(result.opened.courseFormat, 2);
    assert.deepEqual(result.opened.unit, original.unit);
    assert.deepEqual(JSON.parse(await readFile(join(source, 'automatic-upgrade.json'), 'utf8')), job);
    assert.equal((await core.backup.verify({ directory: job.backupDirectory })).database?.sha256, backup.database?.sha256);
    assert.equal((await core.upgrade.status({ directory: source })).decision?.operationId, 'upgrade:' + job.upgradeId);
    await core.setReviewStatus(result.opened.sessionId, 'KU-001', 'mastered');
    assert.equal((await core.reviewStates(result.opened.sessionId)).units['KU-001'].status, 'mastered');
    await assert.rejects(core.open(source), /权威|目标|迁移/);
  } finally { Atomics.store(new Int32Array(gate), 0, 2); await core.close(); await rm(root, { recursive: true, force: true }); }
});
