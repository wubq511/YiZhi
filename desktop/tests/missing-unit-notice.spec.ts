import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForReadingLayout } from './board-test-helpers';
import { openFirstUnit } from './shell-actions';

test('missing example units do not interrupt reading, while other read failures remain visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-missing-unit-'));
  const packaged = process.env.YIZHI_PACKAGED_APP;
  const app = await electron.launch({ ...(packaged ? { executablePath: join(resolve(packaged), 'Contents/MacOS/YiZhi') } : {}),
    args: [...(packaged ? [] : [resolve('.')]), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    // Wrap the actual IPC handler so the assertions wait for completed reads, not a timer.
    await app.evaluate(({ ipcMain }) => {
      const handler = (ipcMain as any)._invokeHandlers.get('course:read-unit');
      const state = (globalThis as any).__missingUnitTest = { calls: [] as Array<{ unitId: string; message: string }>, override: false };
      ipcMain.removeHandler('course:read-unit');
      ipcMain.handle('course:read-unit', async (event, sessionId, unitId) => {
        try {
          if (state.override && unitId === 'KU-007') throw new Error('读取暂时失败，请重试');
          return await handler(event, sessionId, unitId);
        } catch (error) {
          state.calls.push({ unitId, message: (error as Error).message });
          throw error;
        }
      });
    });
    const directory = page.getByRole('navigation', { name: '课程目录' });
    await openFirstUnit(page);
    await expect(page.locator('article[data-unit-id="KU-001"]')).toHaveAttribute('data-reading-active', 'true');
    await waitForReadingLayout(page);

    // Bring an unimplemented sample node into the read-ahead range.
    const board = page.locator('main.board');
    const target = await page.evaluate(async () => {
      const course = await window.yizhi.open(), graph = await window.yizhi.graph(course.sessionId);
      return graph.layout.nodes.find(node => node.unitId === 'KU-007')!;
    });
    await board.evaluate((board, target) => {
      const boardRect = board.getBoundingClientRect();
      const transform = new DOMMatrixReadOnly(getComputedStyle(board.querySelector('.react-flow__viewport')!).transform);
      board.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
        clientX: boardRect.left + 30, clientY: boardRect.top + 100,
        deltaX: transform.e + target.x * transform.a - 80, deltaY: transform.f + target.y * transform.d - 100 }));
    }, target);
    await waitForReadingLayout(page);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__missingUnitTest.calls.some((call: any) => call.message === '该单元不存在或正文尚未加入课程副本'))).toBe(true);
    await expect(page.locator('.read-error')).toHaveCount(0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    // Returning to a valid unit and clicking the missing one keeps the student's place.
    await openFirstUnit(page);
    await waitForReadingLayout(page);
    await directory.getByRole('button', { name: '有符号数与补码运算', exact: true }).click();
    const missing = directory.getByRole('button', { name: '原码、反码、补码表示与转换', exact: true });
    const before = await app.evaluate(() => (globalThis as any).__missingUnitTest.calls.length);
    const camera = await page.locator('.react-flow__viewport').getAttribute('style');
    await missing.click();
    await expect.poll(() => app.evaluate(count => (globalThis as any).__missingUnitTest.calls.slice(count).some((call: any) => call.unitId === 'KU-007'), before)).toBe(true);
    await expect(page.locator('article[data-unit-id="KU-001"]')).toHaveAttribute('data-reading-active', 'true');
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(camera);
    await expect(page.locator('.read-error')).toHaveCount(0);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    await app.evaluate(() => { (globalThis as any).__missingUnitTest.override = true; });
    await missing.click();
    await expect(page.locator('.read-error')).toHaveText('读取暂时失败，请重试');
    await expect(board).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
