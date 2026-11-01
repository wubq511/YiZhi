import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { courseAction, manageDrawings, openRelations } from './shell-actions';

const repository = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());
const scratch = join(repository, 'artifacts', 'scratch', 'surface-motion');

async function keyboardMenuItem(page: Page, trigger: string, item: string) {
  await page.getByRole('button', { name: trigger, exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: item, exact: true }).focus();
  await page.keyboard.press('Enter');
}

test('pointer surfaces animate, while keyboard and reduced motion retain immediate interaction', async () => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'ui-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 800));
    await page.evaluate(() => {
      const state = window as any;
      state.surfaceTransitions = [];
      state.relationExits = [];
      document.addEventListener('transitionrun', event => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches('.relations-panel, .drawing-tools, .history-panel')) {
          state.surfaceTransitions.push({ surface: target.className, property: event.propertyName, pseudo: event.pseudoElement });
        }
      });
      new MutationObserver(records => {
        for (const record of records) {
          const target = record.target;
          if (target instanceof HTMLElement && target.matches('.relations-panel[data-exiting]')) {
            state.relationExits.push({ inert: target.inert, hidden: target.getAttribute('aria-hidden'), pointerEvents: getComputedStyle(target).pointerEvents });
          }
        }
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-exiting'] });
    });

    await openRelations(page);
    const relations = page.locator('.relations-panel');
    await expect(relations).toHaveAttribute('data-motion', 'pointer');
    await expect.poll(() => page.evaluate(() => (window as any).surfaceTransitions.some((entry: any) => entry.surface.includes('relations-panel') && entry.property === 'transform'))).toBe(true);
    await relations.getByRole('button', { name: '关闭关系详情' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).relationExits)).toContainEqual({ inert: true, hidden: 'true', pointerEvents: 'none' });
    await expect(relations).toHaveCount(0);
    await expect(page.getByRole('button', { name: '关系', exact: true })).toBeFocused();

    await keyboardMenuItem(page, '关系', '查看与编辑正式关系');
    await expect(relations).toBeVisible();
    await expect(relations).not.toHaveAttribute('data-motion');
    await relations.getByRole('button', { name: '关闭关系详情' }).focus();
    await page.keyboard.press('Enter');
    await expect(relations).toHaveCount(0);

    await manageDrawings(page);
    const drawings = page.locator('.drawing-tools');
    await expect(drawings).toHaveAttribute('data-motion', 'pointer');
    await expect.poll(() => page.evaluate(() => (window as any).surfaceTransitions.some((entry: any) => entry.surface.includes('drawing-tools') && entry.property === 'transform'))).toBe(true);
    await page.getByRole('button', { name: '收起个人图形' }).click();
    await keyboardMenuItem(page, '图形', '管理与找回图形');
    await expect(drawings).toBeVisible();
    await expect(drawings).not.toHaveAttribute('data-motion');
    await page.getByRole('button', { name: '收起个人图形' }).click();

    await courseAction(page, '完整备份');
    const backup = page.getByRole('dialog', { name: '完整备份' });
    await expect(backup).toHaveAttribute('data-motion', 'pointer');
    await expect.poll(() => page.evaluate(() => (window as any).surfaceTransitions.some((entry: any) => entry.surface.includes('backup-panel') && entry.property === 'opacity'))).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).surfaceTransitions.some((entry: any) => entry.surface.includes('backup-panel') && entry.pseudo === '::backdrop'))).toBe(true);
    await page.getByRole('button', { name: '返回课程', exact: true }).click();
    await expect(backup).toHaveCount(0);
    await expect(page.getByRole('button', { name: '课程菜单', exact: true })).toBeFocused();
    await keyboardMenuItem(page, '课程菜单', '完整备份');
    await expect(backup).toBeVisible();
    await expect(backup).not.toHaveAttribute('data-motion');
    await expect(backup.getByRole('button', { name: '返回课程', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(backup).toHaveCount(0);

    for (const [item, name, close] of [
      ['课程历史', '修改历史', '返回原阅读位置'],
      ['整课历史恢复', '整课历史恢复', '返回当前课程'],
      ['课程设置', '课程设置', '返回课程'],
    ]) {
      await courseAction(page, item);
      const dialog = page.getByRole('dialog', { name, exact: true });
      await expect(dialog).toHaveAttribute('data-motion', 'pointer');
      const closeButton = dialog.getByRole('button', { name: close, exact: true });
      await expect(closeButton).toBeEnabled();
      await closeButton.click();
      await expect(dialog).toHaveCount(0);
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openRelations(page);
    await expect(relations).toHaveAttribute('data-motion', 'pointer');
    expect(await relations.evaluate(element => ({ transform: getComputedStyle(element).transform, duration: getComputedStyle(element).transitionDuration }))).toEqual({ transform: 'none', duration: '0.1s' });
    await relations.getByRole('button', { name: '关闭关系详情' }).click();
    await expect(relations).toHaveCount(0);
    await manageDrawings(page);
    expect(await drawings.evaluate(element => ({ y: new DOMMatrix(getComputedStyle(element).transform).m42, duration: getComputedStyle(element).transitionDuration }))).toEqual({ y: 0, duration: '0.1s' });
    await page.getByRole('button', { name: '收起个人图形' }).click();
    await courseAction(page, '完整备份');
    expect(await backup.evaluate(element => ({ duration: getComputedStyle(element).transitionDuration, backdrop: getComputedStyle(element, '::backdrop').transitionDuration }))).toEqual({ duration: '0.1s', backdrop: '0.1s' });
    await page.getByRole('button', { name: '返回课程', exact: true }).click();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
