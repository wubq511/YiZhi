import { openFaultDatabase } from './fault-database';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { exchangeFixture } from './exchange-fixture';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('explicit exchange scope, failed real registration, retry and independent offline reopen at 1024 and 700', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-ui-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'source') });
    await core.close();
    app = await electron.launch({
      args: [resolve('.'), `--course=${join(root, 'source')}`],
      env: { ...process.env, YIZHI_DATA_HOME: join(root, 'source-profile') },
    });
    let page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '内容交换', exact: true }).click();
    const panel = page.getByRole('region', { name: '内容交换包' });
    await expect(panel).toContainText('yizhi-exchange-1');
    await expect(panel).toContainText('不是完整课程备份');
    await panel.getByLabel('包含所选单元的文字与公式批注').check();
    await app.evaluate(
      ({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      },
      join(root, '中文 Exchange 包'),
    );
    await panel.getByRole('button', { name: '导出所选内容' }).click();
    await expect(panel.getByRole('status')).toContainText('已导出');
    await app.close();
    app = undefined;
    const prep = new CourseService(resolve('dist/worker.cjs'));
    await exchangeFixture(join(root, 'legacy-dest'), 'KU-087');
    await prep.migration.convert({ sourceDirectory: join(root, 'legacy-dest'), directory: join(root, 'dest') });
    await prep.close();
    app = await electron.launch({
      args: [resolve('.'), `--course=${join(root, 'dest')}`],
      env: { ...process.env, YIZHI_DATA_HOME: join(root, 'dest-profile') },
    });
    page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '内容交换', exact: true }).click();
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      },
      join(root, '中文 Exchange 包'),
    );
    await page.getByRole('button', { name: '选择交换包并检查' }).click();
    await expect(page.getByRole('region', { name: '内容交换包' })).toContainText('2 个单元');

    const fault = openFaultDatabase(join(root, 'dest/course.sqlite'));
    fault.exec(
      "CREATE TRIGGER reject_ui_exchange BEFORE INSERT ON exchange_operations BEGIN SELECT RAISE(ABORT,'交换登记写入失败');END",
    );
    await page.getByRole('button', { name: '导入已检查内容' }).click();
    await expect(page.getByRole('alert')).toContainText('交换登记写入失败');
    expect(
      await page.evaluate(async () => {
        const c = await window.yizhi.open();
        return (await window.yizhi.graph(c.sessionId)).nodes.some((n) => n.id === 'KU-086');
      }),
    ).toBe(false);
    fault.exec('DROP TRIGGER reject_ui_exchange');
    fault.close();
    await page.getByRole('button', { name: '重试本次导入' }).click();
    await expect(page.getByRole('region', { name: '内容交换包' }).getByRole('status')).toContainText('已导入');
    await resizeBoardWindow(app, page, 700, 700);
    await expect(page.getByRole('button', { name: '关闭内容交换' })).toBeInViewport();
    await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
    await page.keyboard.press('Tab');
    expect(
      await page.getByRole('dialog', { name: '内容交换包' }).evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await mkdir(resolve('dist/t27-acceptance'), { recursive: true });
    await page.screenshot({ path: resolve('dist/t27-acceptance/ui-narrow.png') });
    await page.getByRole('button', { name: '关闭内容交换' }).click();
    await app.close();
    app = undefined;
    await rm(join(root, 'source'), { recursive: true });
    await rm(join(root, '中文 Exchange 包'), { recursive: true });
    app = await electron.launch({
      args: [resolve('.'), `--course=${join(root, 'dest')}`],
      env: { ...process.env, YIZHI_DATA_HOME: join(root, 'dest-profile') },
    });
    page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.context().setOffline(true);
    const result = await page.evaluate(async () => {
      const c = await window.yizhi.open();
      return {
        unit: await window.yizhi.readUnit(c.sessionId, 'KU-086'),
        pdf: await window.yizhi.sources.page({ sessionId: c.sessionId, versionId: 'VER-EXTRA', pdfPageIndex: 0 }),
      };
    });
    expect(result.unit.reading.blocks[0].payload.text).toBe('末单元完整正文');
    expect(result.pdf.projection.text).toContain('Independent fixed source');
    // Locate the new object through the real course navigation and camera, never force-click.
    await page.getByRole('button', { name: '末主题', exact: true }).first().click();
    const nav = page.getByRole('button', { name: '持久化末单元', exact: true }).first();
    await nav.click();
    await expect(page.locator('article[data-unit-id="KU-086"]')).toContainText('末单元完整正文');
    const image = page.locator('article[data-unit-id="KU-086"] img');
    await revealBoardControl(page, image);
    await expect.poll(() => image.evaluate((v: HTMLImageElement) => v.complete && v.naturalWidth)).toBeGreaterThan(100);
    await page.getByRole('button', { name: '内容交换', exact: true }).click();
    await expect(page.getByRole('region', { name: '内容交换包' })).toContainText('持久化末单元');
    await page.screenshot({ path: resolve('dist/t27-acceptance/ui-desktop.png') });
    await resizeBoardWindow(app, page, 700, 700);
    await expect(page.getByRole('button', { name: '选择交换包并检查' })).toBeInViewport();
    expect(
      await page.evaluate(() => 'importPackage' in window.yizhi.exchange || 'exportPackage' in window.yizhi.exchange),
    ).toBe(false);
  } finally {
    await core.close();
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared unit imported into a native course uses its registered image and fixed source instead of sample assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-native-ui-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await exchangeFixture(join(root, 'legacy'), 'KU-NEW');
    const { readFile, writeFile } = await import('node:fs/promises');
    const path = join(root, 'legacy/data/map.json');
    const k = JSON.parse(await readFile(path, 'utf8'));
    k.units[1].themeId = 'TH-EXCHANGE';
    k.themes[1] = { ...k.themes[1], id: 'TH-EXCHANGE', name: '新导入主题' };
    await writeFile(path, JSON.stringify(k));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'source') });
    const c = await core.open(join(root, 'source'));
    await core.exchange.exportPackage({
      sessionId: c.sessionId,
      directory: join(root, 'package'),
      unitIds: ['KU-NEW'],
      annotations: false,
    });
    await core.close();
    app = await electron.launch({
      args: [resolve('.'), `--course=${join(root, 'native-target')}`],
      env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') },
    });
    const page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '内容交换', exact: true }).click();
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      },
      join(root, 'package'),
    );
    await page.getByRole('button', { name: '选择交换包并检查' }).click();
    await page.getByRole('button', { name: '导入已检查内容' }).click();
    await expect(page.getByRole('region', { name: '内容交换包' }).getByRole('status')).toContainText('已导入');
    await page.getByRole('button', { name: '关闭内容交换' }).click();
    await page.getByRole('button', { name: '新导入主题', exact: true }).first().click();
    const image = page.locator('article[data-unit-id="KU-NEW"] img');
    await expect(image).toHaveAttribute('src', /^yizhi-resource:/);
    await revealBoardControl(page, image);
    await expect.poll(() => image.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(100);
    const source = page.locator('article[data-unit-id="KU-NEW"]').getByRole('button', { name: '查看固定原页' });
    await revealBoardControl(page, source);
    await source.click();
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Fixed legacy source');
  } finally {
    await core.close();
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
