import { courseAction } from './shell-actions';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('formal learning window exposes student capabilities and cannot invoke development producers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-product-boundary-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '学习对话', exact: true })).toBeVisible();
    const capabilities = await page.evaluate(() => ({ root: Object.keys(window.yizhi), commands: Object.keys(window.yizhi.commands) }));
    for (const name of ['migration', 'exchange', 'upgrade']) expect(capabilities.root).not.toContain(name);
    for (const name of ['startAttempt', 'read', 'commit', 'stop']) expect(capabilities.commands).not.toContain(name);
    const attempts = await page.evaluate(async () => {
      const api = (window as any).yizhi;
      const results: string[] = [];
      for (const name of ['startAttempt', 'read', 'commit', 'stop']) {
        try { await api.commands[name]({}); results.push('callable'); }
        catch (error) { results.push((error as Error).name); }
      }
      return { results, developmentBridge: typeof (window as any).yizhiControlled };
    });
    expect(attempts).toEqual({ results: ['TypeError', 'TypeError', 'TypeError', 'TypeError'], developmentBridge: 'undefined' });
    for (const name of ['protect', 'releaseView', 'recheck', 'resolveInput', 'resolveCandidate', 'candidates', 'history', 'query']) expect(capabilities.commands).toContain(name);
    await expect(page.getByText('可控生产者 · 验证入口', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /迁移旧课程|迁移记录|内容交换|备份与升级/ })).toHaveCount(0);
    await courseAction(page, '完整备份');
    const backup = page.getByRole('dialog', { name: '完整备份', exact: true });
    await expect(backup.getByRole('button', { name: '新建完整备份', exact: true })).toBeVisible();
    await expect(backup.getByRole('button', { name: /升级|接回/ })).toHaveCount(0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
