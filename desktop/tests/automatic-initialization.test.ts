import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { CourseOpening } from '../src/host/course-opening';
import { oldDesktopCourse } from './old-desktop-fixture';

for (const point of ['backup-initializing', 'workcopy-initializing']) test('ordinary reopening recovers a reserved ' + point + ' directory whose first marker was interrupted', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'yizhi-auto-init-'))), source = join(root, 'course');
  const seed = new CourseService(resolve('dist/worker.cjs'));
  try { await oldDesktopCourse(seed, source); } finally { await seed.close(); }
  const upgradeId = 'initialization-interrupted', job = { schema: 'yizhi-automatic-upgrade-1', upgradeId,
    directory: source + '.format2-' + upgradeId, backupDirectory: source + '.before-format2-' + upgradeId };
  await writeFile(join(source, 'automatic-upgrade.json'), JSON.stringify(job));
  const stage = point === 'backup-initializing' ? job.backupDirectory + '.backup-starting-upgrade-' + upgradeId : job.directory;
  await mkdir(stage);
  await writeFile(join(stage, point === 'backup-initializing' ? 'backup-manifest.json.partial' : 'directory-authority.json.interrupted.partial'), '{');
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const result = await new CourseOpening(core).open(source);
    assert.equal(result.directory, job.directory);
    assert.equal(result.opened.courseFormat, 2);
    assert.equal((await core.backup.verify({ directory: job.backupDirectory })).phase, 'complete');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});
