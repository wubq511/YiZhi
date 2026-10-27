import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('keyboard caret navigation keeps board controls fixed and reopens at the actual reading camera', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-caret-camera-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const first = page.getByRole('textbox', { name: '编辑首段正文', exact: true });
    await first.fill('连续输入的长正文应当保持同一个画板相机和输入现场。'.repeat(90));
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const beforeZoom = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
    await first.press('Meta+ArrowDown');
    const board = page.locator('main.board');
    const tools = page.locator('.board-tools');
    const bounds = (await board.boundingBox())!;
    await expect.poll(async () => (await tools.boundingBox())!.y).toBeGreaterThanOrEqual(bounds.y);
    expect(await board.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft }))).toEqual({ top: 0, left: 0 });
    const camera = await page.evaluate(async () => {
      const bridge = (window as any).yizhi, course = await bridge.open();
      return bridge.readingState(course.sessionId);
    });
    const matrix = () => page.locator('.react-flow__viewport').evaluate(el => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a };
    });
    const current = await matrix();
    expect(current.zoom).toBe(beforeZoom);
    await expect(page.getByRole('textbox', { name: '连续编辑正文', exact: true })).toBeFocused();
    await page.screenshot({ path: test.info().outputPath('caret-camera.png') });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    expect(await matrix()).toEqual(current);
    await expect(page.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText('连续输入的长正文应当保持同一个画板相机和输入现场。'.repeat(90));
    expect(camera.unitId).toBe('KU-001');
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
