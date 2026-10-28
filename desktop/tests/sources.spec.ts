import { evidencePath } from './evidence-paths';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceFixture } from './source-fixture';
import type { ElectronApplication } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';

test('local PDF.js renders a real text layer, cites actual selection, preserves old source and the live board editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-source-ui-'));
  const path = join(root, 'evidence.pdf'); await sourceFixture(path, 'Original course evidence', 180000);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '编辑首段正文' });
    await editor.fill('阅读原文时保留的正文与编辑实例');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const editorHandle = await editor.elementHandle();
    const before = await page.locator('.reading-layer').first().getAttribute('style');
    // Only the native chooser is controlled; host copy, protocol, Worker, PDF.js and SQLite are real.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toContainText('原页已载入');
    await expect(page.locator('.source-pdf canvas')).toBeVisible();
    expect(await page.locator('.source-pdf canvas').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 3] === 255) ink++;
      return ink;
    })).toBeGreaterThan(100);
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Original course evidence');
    await expect(page.getByText('印刷页：未核对', { exact: true })).toBeVisible();
    await page.getByLabel('已核对的印刷页').fill('iv');
    await page.getByRole('button', { name: '登记印刷页', exact: true }).click();
    await expect(page.getByText('印刷页：iv', { exact: true })).toBeVisible();
    const firstText = page.locator('.source-pdf .textLayer span').filter({ hasText: 'Original course evidence' });
    // Browser DOM range selects exactly the real first text item. No quote is supplied over IPC.
    await firstText.evaluate(span => {
      const range = document.createRange(); range.setStart(span.firstChild!, 0); range.setEnd(span.firstChild!, 8);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    });
    await page.getByRole('button', { name: '保留选文与出处', exact: true }).click();
    await expect(page.locator('.source-citations blockquote')).toHaveText('Original');
    await sourceFixture(path, 'New revision evidence', 180000);
    await page.getByRole('button', { name: '导入此来源新版', exact: true }).click();
    await expect(page.locator('.source-pdf .textLayer')).toContainText('New revision evidence');
    await page.getByRole('button', { name: '暂不更新', exact: true }).click();
    await page.getByRole('button', { name: '根据新版更新', exact: true }).click();
    await expect(page.getByText('已记录更新意图，尚未执行画板修改。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '打开引用原页', exact: true }).click();
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Original course evidence');
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await expect(editor).toHaveText('阅读原文时保留的正文与编辑实例');
    expect(await page.locator('.reading-layer').first().getAttribute('style')).toBe(before);
    expect(await editorHandle!.evaluate(node => node.isConnected)).toBe(true);
    await editor.fill('核对原文后继续编辑');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await revealBoardControl(page, page.locator('.source-references').getByRole('button', { name: '核对来源原页', exact: true }));
    await page.locator('.source-references').getByRole('button', { name: '核对来源原页', exact: true }).click();
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Original course evidence');
    await expect(page.locator('.source-citation-marker')).toBeVisible();
    await expect(page.getByRole('status', { name: '原文位置保存' })).toHaveText('原文位置已保存');
    await page.screenshot({ path: evidencePath('t14-source.png') });
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await page.getByRole('button', { name: '查看关系', exact: true }).click();
    const relation = page.getByLabel('关系详情');
    await relation.getByRole('button', { name: '审核 REL-001', exact: true }).click();
    const imported = await page.evaluate(async () => {
      const api = (window as any).yizhi, opened = await api.open(); return (await api.sources.list({ sessionId: opened.sessionId })).versions.at(-1);
    });
    await relation.getByRole('combobox', { name: '来源 1', exact: true }).selectOption(imported.sourceId);
    await relation.getByRole('combobox', { name: '固定版本 1', exact: true }).selectOption(imported.versionId);
    await relation.getByRole('textbox', { name: 'PDF 页码 1', exact: true }).fill('1');
    await relation.getByRole('button', { name: '保存正式关系', exact: true }).click();
    await expect(relation.getByRole('status', { name: '正式关系结果' })).toContainText('已保存');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('graphic-only page carries a real region without fabricated quote; offline cache-cleared reopen restores page and source scroll', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-source-offline-'));
  const path = join(root, 'graphic-fixture.pdf'); await sourceFixture(path, 'Local evidence', 1_500_000);
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    app = await launch(); let page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    const ranges: string[] = [];
    page.on('request', request => { if (request.url().startsWith('yizhi-resource:') && request.headers().range) ranges.push(request.headers().range); });
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByText(/本页没有可靠文本层/)).toBeVisible();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    await page.getByLabel('原页缩放').selectOption('2.5');
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    await page.getByRole('button', { name: '选取页面区域', exact: true }).click();
    await page.locator('.source-scroll').scrollIntoViewIfNeeded();
    const box = (await page.locator('.source-region-picker').boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 140, { steps: 8 }); await page.mouse.up();
    await page.getByRole('button', { name: '保留选区出处', exact: true }).click();
    await expect(page.locator('.source-citations')).toContainText('无可靠文本层 · 原页选区');
    const saved = await page.evaluate(async () => {
      const api = (window as any).yizhi, opened = await api.open(); return api.sources.citations({ sessionId: opened.sessionId });
    });
    expect(saved[0].quote).toBeNull(); expect(saved[0].pdfPageIndex).toBe(1);
    expect(saved[0].region.x1 - saved[0].region.x0).toBeCloseTo(52, 0);
    expect(saved[0].region.y1 - saved[0].region.y0).toBeCloseTo(44, 0);
    await page.locator('.source-scroll').evaluate(element => { element.scrollTop = 150; element.scrollLeft = 80; });
    await expect(page.getByRole('status', { name: '原文位置保存' })).toHaveText('原文位置已保存');
    expect(ranges.length).toBeGreaterThan(0); // Actual PDF.js range transport, not a whole-file IPC mount.
    await app.evaluate(async ({ session }) => { await session.defaultSession.clearCache(); await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] }); });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.waitForLoadState('load');
    await page.context().setOffline(true);
    await page.reload();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    await expect(page.getByLabel('PDF 页序')).toHaveValue('2');
    await expect(page.getByLabel('原页缩放')).toHaveValue('2.5');
    await expect.poll(() => page.locator('.source-scroll').evaluate(element => [element.scrollTop, element.scrollLeft])).toEqual([150, 80]);
    await expect(page.locator('.source-pdf canvas')).toHaveCount(1);
    await expect(page.locator('.source-pdf .textLayer')).toHaveText('');
    await page.setViewportSize({ width: 680, height: 650 });
    await expect(page.getByRole('dialog', { name: '原文资料' })).toBeVisible();
    expect(await page.locator('.board-workspace').evaluate(element => (element as HTMLElement).inert)).toBe(true);
    await page.screenshot({ path: evidencePath('t14-source-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '原文资料' })).toHaveCount(0);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('host IPC denies paths and unregistered routes; real storage faults retain retry and keep board readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-source-retry-ui-'));
  const path = join(root, 'retry.pdf'); await sourceFixture(path);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let fault: DatabaseSync | undefined;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    fault.exec("CREATE TRIGGER source_failure BEFORE INSERT ON source_versions BEGIN SELECT RAISE(ABORT,'source registry unavailable'); END");
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('source registry unavailable');
    fault.exec('DROP TRIGGER source_failure');
    await page.getByRole('button', { name: '重试资料操作', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    const boundary = await page.evaluate(async () => {
      const api = (window as any).yizhi, opened = await api.open();
      const versions = await api.sources.list({ sessionId: opened.sessionId });
      let pathDenied = false;
      try { await api.sources.chooseImport({ sessionId: opened.sessionId, generation: 1, operationId: 'forged-path', path: '/etc/passwd' }); } catch { pathDenied = true; }
      const known = `yizhi-resource://course/${opened.sessionId}/${versions.versions[0].versionId}`;
      return { pathDenied, importFile: typeof api.sources.importFile, readResource: typeof api.sources.readResource,
        sourceCount: versions.versions.length, partialStatus: (await fetch(known, { headers: { Range: 'bytes=0-7' } })).status,
        bytes: await (await fetch(known, { headers: { Range: 'bytes=0-7' } })).text(),
        forged: (await fetch(`yizhi-resource://course/${opened.sessionId}/00000000-0000-0000-0000-000000000000`)).status,
        traversal: (await fetch('yizhi-app://app/../../course.sqlite')).status };
    });
    expect(boundary).toEqual({ pathDenied: true, importFile: 'undefined', readResource: 'undefined', sourceCount: 1,
      partialStatus: 206, bytes: '%PDF-1.7', forged: 404, traversal: 404 });
    fault.exec("CREATE TRIGGER source_context_failure BEFORE INSERT ON source_reading BEGIN SELECT RAISE(ABORT,'source reading write fault'); END");
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文位置保存' })).toContainText('未保存');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(page.isClosed()).toBe(false);
    fault.exec('DROP TRIGGER source_context_failure');
    await page.getByRole('button', { name: '重试保存原文位置', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文位置保存' })).toHaveText('原文位置已保存');
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '编辑首段正文' })).toContainText('位置记数法');
    const registered = await page.evaluate(async () => {
      const api = (window as any).yizhi, opened = await api.open(); return (await api.sources.list({ sessionId: opened.sessionId })).versions[0];
    });
    await rm(join(root, 'course/resources', registered.sha256));
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('画板正文仍可阅读');
    await page.getByRole('button', { name: '从原件修复此版本', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '编辑首段正文' })).toContainText('位置记数法');
  } finally { fault?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
