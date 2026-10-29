import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { oldDesktopCourse } from './old-desktop-fixture';
import { resizeBoardWindow } from './board-test-helpers';

test('ordinary Electron opening automatically upgrades a supported course, preserves learning content and reopens without maintenance choices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-auto-upgrade-ui-')), source = join(root, 'course');
  const seed = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await oldDesktopCourse(seed, source);
    await seed.save({ ...opened, operationId: 'before-upgrade', inputSeq: 1, baseRevision: opened.revision,
      blockId: opened.editableBlockId, text: '自动升级前已保存的完整正文' });
    await seed.setReviewStatus(opened.sessionId, 'KU-001', 'weak');
  } finally { await seed.close(); }
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${source}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'not-used') } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const opened = await page.evaluate(() => window.yizhi.open());
    expect(opened.courseFormat).toBe(2);
    expect(opened.unit.reading.blocks[0].payload.text).toBe('自动升级前已保存的完整正文');
    for (const name of ['迁移旧课程', '迁移记录', '内容交换', '可控生产者 · 验证入口', '备份与升级'])
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    const bridge = await page.evaluate(() => Object.keys(window.yizhi));
    expect(bridge).not.toContain('migration'); expect(bridge).not.toContain('exchange'); expect(bridge).not.toContain('upgrade');
    const job = JSON.parse(await readFile(join(source, 'automatic-upgrade.json'), 'utf8'));
    const check = new CourseService(resolve('dist/worker.cjs'));
    try { expect((await check.backup.verify({ directory: job.backupDirectory })).phase).toBe('complete'); }
    finally { await check.close(); }
    const files = await readdir(root);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    expect((await page.evaluate(() => window.yizhi.open())).courseFormat).toBe(2);
    expect(await readdir(root)).toEqual(files);
    await page.screenshot({ path: test.info().outputPath('automatic-course-upgrade.png') });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
