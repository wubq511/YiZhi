import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';

test('closing the narrow Agent dialog with keyboard returns focus to its enabled trigger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-narrow-focus-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page, 700, 700);
    await page.getByRole('button', { name: '关闭目录', exact: true }).click();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const trigger = page.getByRole('button', { name: 'Agent · 学习对话', exact: true });
    await trigger.focus(); await expect(trigger).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: '学习对话草稿', exact: true })).toBeFocused();
    const close = page.getByRole('button', { name: '收起对话', exact: true }); await close.focus(); await page.keyboard.press('Enter');
    await expect(trigger).toBeFocused();
  } catch (error) {
    const page = app.windows()[0];
    await writeFile(test.info().outputPath('focus-scene.json'), JSON.stringify(await page.evaluate(() => ({ active: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute('aria-label'),
      headerInert: (document.querySelector('header') as HTMLElement)?.inert, documentFocused: document.hasFocus() })), null, 2));
    throw error;
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('closing the narrow source dialog with Escape returns focus after the header is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-narrow-source-focus-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page, 700, 700);
    await page.getByRole('button', { name: '关闭目录', exact: true }).click();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const trigger = page.getByRole('button', { name: '原文资料', exact: true });
    await trigger.focus(); await expect(trigger).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '原文资料', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回画板', exact: true }).focus();
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
