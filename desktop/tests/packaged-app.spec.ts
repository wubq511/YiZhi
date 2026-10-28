import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { sourceFixture } from './source-fixture';
import { evidencePath } from './evidence-paths';

test('installed macOS app opens offline without checkout tools, decodes real resources, saves and reopens', async () => {
  test.skip(process.platform !== 'darwin' || !process.env.YIZHI_PACKAGED_APP,
    'Opt in with YIZHI_PACKAGED_APP=/absolute/YiZhi.app after package:mac.');
  test.setTimeout(120_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'yizhi-installed-')));
  const installed = join(root, 'Applications', 'YiZhi.app');
  await mkdir(join(root, 'Applications'));
  await cp(resolve(process.env.YIZHI_PACKAGED_APP!), installed, { recursive: true, verbatimSymlinks: true });
  const empty = join(root, 'empty'); await mkdir(empty);
  const pdf = join(root, 'offline.pdf'); await sourceFixture(pdf, 'Installed app offline evidence');
  const png = join(root, 'native-image.png');
  const canvas = createCanvas(16, 12); const context = canvas.getContext('2d');
  context.fillStyle = '#123456'; context.fillRect(0, 0, 16, 12);
  await writeFile(png, canvas.toBuffer('image/png'));
  const executablePath = join(installed, 'Contents/MacOS/YiZhi');
  const launch = () => electron.launch({ executablePath, timeout: 25_000, args: [`--course=${join(root, 'course')}`,
    '--host-resolver-rules=MAP * ~NOTFOUND'], cwd: empty,
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: '', NODE_OPTIONS: '',
      YIZHI_CODEX_PATH: join(empty, 'missing-codex'), YIZHI_DATA_HOME: join(root, 'profile') } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    await page.context().route(/^https?:\/\//, route => route.abort());
    await page.context().setOffline(true);
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(),
      execPath: process.execPath, versions: process.versions }));
    expect(runtime.packaged).toBe(true);
    expect(runtime.execPath).toBe(executablePath);
    expect(runtime.appPath.startsWith(installed + '/')).toBe(true);
    expect(runtime.versions.electron).toBe('45.0.0');
    expect(runtime.versions.node).toMatch(/^24\./);
    const manifest = JSON.parse(await readFile(join(installed, 'Contents/Resources/app/package-manifest.json'), 'utf8'));
    expect(manifest.productionPackages.some((item: { name: string }) => item.name === 'electron' || item.name === '@playwright/test')).toBe(false);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '编辑首段正文', exact: true });
    await editor.fill('安装副本离线输入：独立运行并自动保存 📝。');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
    await expect(page.getByText(/生成暂不可用/)).toBeVisible();
    await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '收起对话', exact: true }).click();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, pdf);
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Installed app offline evidence');
    await expect(page.locator('.source-pdf canvas')).toBeVisible();
    // A PNG import exercises the packaged Worker's native canvas decoder, not just renderer canvas.
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, png);
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    const source = await page.evaluate(async () => {
      const api = (window as any).yizhi, opened = await api.open(); return api.sources.list({ sessionId: opened.sessionId });
    });
    expect(source.versions.map((item: { mediaType: string }) => item.mediaType).sort()).toEqual(['application/pdf', 'image/png']);
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await expect(editor).toHaveText('安装副本离线输入：独立运行并自动保存 📝。');
    await page.screenshot({ path: evidencePath('packaged-app-offline.png') });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.context().route(/^https?:\/\//, route => route.abort());
    await page.context().setOffline(true);
    await expect(page.getByRole('textbox', { name: '编辑首段正文', exact: true }))
      .toHaveText('安装副本离线输入：独立运行并自动保存 📝。');
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await expect(page.getByRole('status', { name: '原文状态' })).toHaveText('原页已载入');
    console.log('Installed application evidence', JSON.stringify({ runtime, productionPackages: manifest.productionPackages.length,
      coursePath: join(root, 'course'), nativeImage: true, pdfText: true, reopened: true }));
  } finally {
    if (app && app.process().exitCode === null) {
      const timer = setTimeout(() => app!.process().kill('SIGKILL'), 5000);
      try { await app.close(); } finally { clearTimeout(timer); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
