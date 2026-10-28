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

/** Read the actual inline transform components without CSSOM string serialization.
 * style.transform rounds to six significant digits; even DOMMatrix's typed conversion
 * uses float32. The translate/scale CSS numeric values retain the original doubles.
 */
export async function readCameraTransform(target: Locator): Promise<{x:number;y:number;zoom:number}> {
  return target.evaluate(el => {
    const transforms = Array.from((el as any).attributeStyleMap.get('transform')) as any[];
    if (transforms.length !== 2 || transforms[0].constructor.name !== 'CSSTranslate' || transforms[1].constructor.name !== 'CSSScale'
      || transforms[0].x.unit !== 'px' || transforms[0].y.unit !== 'px' || transforms[1].x.value !== transforms[1].y.value) {
      throw new Error('Camera observation requires the actual 2D translate(px)/uniform scale transform');
    }
    const view={x:transforms[0].x.value,y:transforms[0].y.value,zoom:transforms[1].x.value};
    if (!Object.values(view).every(Number.isFinite)) throw new Error('Camera transform is not finite');
    return view;
  });
}
