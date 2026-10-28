import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCameraTransform, resizeBoardWindow } from './board-test-helpers';

test('continuous camera gestures keep unchanged graph projection and the active reading input stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-viewport-response-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    if (await page.getByRole('button', { name: '收起目录', exact: true }).count()) await page.getByRole('button', { name: '收起目录', exact: true }).click();
    const pane = page.locator('.react-flow__pane'), viewport = page.locator('.react-flow__viewport');
    const board = (await page.locator('main.board').boundingBox())!, clientX = Math.round(board.x + 8), clientY = Math.round(board.y + 180);
    const reading = await page.evaluate(async () => { const c = await (window as any).yizhi.open(); return (window as any).yizhi.readingState(c.sessionId); });
    await page.evaluate(() => { (window as any).__responseEditor = document.querySelector('article[data-reading-active=true] .tiptap'); });
    const camera = await readCameraTransform(viewport), count = () => page.evaluate(() => (window as any).__yizhiObservation()['scene.graphProjections'].count);
    const before = await count();
    for (let step = 0; step < 10; step++) {
      await pane.dispatchEvent('wheel', { deltaX: 2, deltaY: 1, clientX, clientY, bubbles: true, cancelable: true });
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    }
    const panned = await readCameraTransform(viewport);
    expect(panned.x).toBeCloseTo(camera.x - 20, 8); expect(panned.y).toBeCloseTo(camera.y - 10, 8);
    for (let step = 0; step < 5; step++) {
      await pane.dispatchEvent('wheel', { deltaY: -.5, deltaMode: 0, ctrlKey: true, clientX, clientY, bubbles: true, cancelable: true });
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
    }
    const pinched = await readCameraTransform(viewport), pointer = { x: clientX - board.x, y: clientY - board.y };
    expect(pinched.zoom).toBeGreaterThan(panned.zoom);
    expect((pointer.x - pinched.x) / pinched.zoom).toBeCloseTo((pointer.x - panned.x) / panned.zoom, 8);
    expect((pointer.y - pinched.y) / pinched.zoom).toBeCloseTo((pointer.y - panned.y) / panned.zoom, 8);
    // Translation / zoom inside one semantic level does not change any graph content or placement.
    expect(await count(), 'Camera-only input must not rebuild the unchanged graph projection').toBe(before);
    expect(await page.evaluate(() => document.querySelector('article[data-reading-active=true] .tiptap') === (window as any).__responseEditor)).toBe(true);
    const after = await page.evaluate(async () => { const c = await (window as any).yizhi.open(); return (window as any).yizhi.readingState(c.sessionId); });
    expect({ ...after, camera: undefined }).toEqual({ ...reading, camera: undefined });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const reopened = await readCameraTransform(page.locator('.react-flow__viewport')); expect(reopened).toEqual(pinched);
    await writeFile(test.info().outputPath('viewport-response.json'), JSON.stringify({ camera, panned, pinched, reopened, graphProjectionCount: before, physical: false }, null, 2));
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
