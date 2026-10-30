import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openRelations } from './shell-actions';

const repository = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const scratch = join(repository, 'artifacts', 'scratch', 'relations-overlap');

test('relation details and canvas controls remain unobstructed at desktop and narrow sizes', async ({}, testInfo) => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'ui-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await openRelations(page);
    const panel = page.locator('.relations-panel');
    const toolbar = page.locator('.canvas-toolbar');
    const navigation = page.locator('.canvas-navigation');
    const minimap = page.locator('.react-flow__minimap');
    const close = panel.getByRole('button', { name: '关闭关系详情', exact: true });

    for (const [width, toolbarVisible, navigationVisible] of [[1440, true, true], [1024, true, true], [900, false, true], [700, false, false]] as const) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
      // Let the existing side dock and relation entrance finish before checking the rendered layout.
      await page.waitForTimeout(250);
      if (toolbarVisible) await expect(toolbar).toBeVisible(); else await expect(toolbar).toBeHidden();
      if (navigationVisible) { await expect(navigation).toBeVisible(); await expect(minimap).toBeVisible(); }
      else { await expect(navigation).toBeHidden(); await expect(minimap).toBeHidden(); }
      await expect(close).toBeVisible();
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector('.relations-panel')!;
        const rect = panel.getBoundingClientRect();
        const unobstructed = [[rect.left + 24, rect.top + 28], [rect.left + rect.width / 2, rect.bottom - 24]]
          .every(([x, y]) => panel.contains(document.elementFromPoint(x, y)));
        const overlaps = ['.canvas-toolbar', '.canvas-navigation', '.react-flow__minimap'].filter(selector => {
          const item = document.querySelector(selector)!;
          if (getComputedStyle(item).display === 'none') return false;
          const other = item.getBoundingClientRect();
          return other.left < rect.right && other.right > rect.left && other.top < rect.bottom && other.bottom > rect.top;
        });
        return { unobstructed, overlaps };
      });
      expect(geometry).toEqual({ unobstructed: true, overlaps: [] });
      if (width === 1024 || width === 700) await page.screenshot({ path: testInfo.outputPath(`relations-${width}.png`) });
    }

    await close.focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(toolbar).toBeVisible();
    await expect(navigation).toBeVisible();
    await expect(minimap).toBeVisible();
    await expect(page.getByRole('button', { name: '关系', exact: true })).toBeFocused();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 800));
    await page.getByRole('button', { name: '学习对话', exact: true }).click();
    await openRelations(page);
    await expect(toolbar).toBeHidden();
    await expect(close).toBeVisible();
    expect(await page.evaluate(() => {
      const panel = document.querySelector('.relations-panel')!, r = panel.getBoundingClientRect();
      return panel.contains(document.elementFromPoint(r.left + 24, r.top + 28));
    })).toBe(true);
    await close.click();
    await page.getByRole('button', { name: '收起对话', exact: true }).click();

    await page.getByRole('button', { name: '收起小地图', exact: true }).click();
    await openRelations(page);
    await expect(minimap).toHaveCount(0);
    await close.click();
    await expect(page.getByRole('button', { name: '展开小地图', exact: true })).toBeVisible();
    await expect(minimap).toHaveCount(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
