import { expect } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

export async function resizeBoardWindow(app: ElectronApplication, page: Page, width = 1024, height = 688) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  const size = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(width, height); return window.getContentSize();
  }, { width, height });
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(size);
}

export async function revealBoardControl(page: Page, target: Locator) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  const board = (await page.locator('main.board').boundingBox())!;
  await page.mouse.move(board.x + 8, board.y + board.height / 2);
  for (let step = 0; step < 60; step++) {
    const box = (await target.boundingBox())!;
    const delta = box.y + box.height / 2 - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 6) return;
    await page.mouse.wheel(0, Math.max(-500, Math.min(500, delta)));
    await page.waitForTimeout(30);
  }
  throw new Error(`画板控件未进入视野：${JSON.stringify(await target.boundingBox())}`);
}
