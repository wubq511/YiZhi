import type { Locator, Page } from '@playwright/test';
/** Follow the actual screen position after caret navigation or viewport resizing. */
export async function revealControl(page: Page, control: Locator) {
  await page.locator('.workspace').getAttribute('aria-busy').then(async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await page.locator('.workspace').getAttribute('aria-busy') !== 'true') return;
      await page.waitForTimeout(50);
    }
    throw new Error('画板尚未完成定位');
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    const board = await page.getByRole('region', { name: '知识画板', exact: true }).boundingBox();
    const target = await control.boundingBox();
    if (!board || !target) throw new Error('阅读控件尚未显示');
    const top = board.y + 55, bottom = board.y + board.height - 55;
    const left = board.x + 30, right = board.x + board.width - 30;
    const dx = target.x < left ? target.x - left : target.x + target.width > right ? target.x + target.width - right : 0;
    const dy = target.y < top ? target.y - top : target.y + target.height > bottom ? target.y + target.height - bottom : 0;
    if (!dx && !dy) return;
    await page.mouse.move(board.x + 12, board.y + board.height / 2);
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(180);
  }
  throw new Error('无法通过画板平移定位阅读控件');
}
