import { controlledElectron } from './controlled-launch';
import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { readCameraTransform, resizeBoardWindow, waitForReadingLayout } from './board-test-helpers';

// Browser scheduling boundary only: the app, wheel listeners and ReactFlow setter stay real.
async function holdFrames(page: Page) {
  await page.evaluate(() => {
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
    const callbacks = new Map<number, FrameRequestCallback>(); let next = 1000000;
    window.requestAnimationFrame = callback => { const id = next++; callbacks.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { if (!callbacks.delete(id)) cancel.call(window, id); };
    (window as any).__pinchFrames = {
      step() { const batch = [...callbacks.values()]; callbacks.clear(); for (const callback of batch) callback(performance.now()); },
      restore() { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; callbacks.clear(); },
    };
  });
}
async function stepFrame(page: Page) { await page.evaluate(() => (window as any).__pinchFrames.step()); }
async function restoreFrames(page: Page) { await page.evaluate(() => (window as any).__pinchFrames?.restore()); }
async function sendPinch(page: Page, deltaY: number, x = 100, y = 150, metaKey = false) {
  return page.evaluate(({ deltaY, x, y, metaKey }) => {
    const board = document.querySelector('main.board')!, rect = board.getBoundingClientRect();
    const event = new WheelEvent('wheel', {
      deltaY, deltaMode: 0, ctrlKey: !metaKey, metaKey, clientX: rect.left + x, clientY: rect.top + y,
      bubbles: true, cancelable: true,
    });
    board.querySelector('.react-flow__pane')!.dispatchEvent(event);
    // MouseEvent coordinates can quantize a fractional board origin. Assertions
    // must use the delivered pointer, exactly as the product handler does.
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, { deltaY, x, y, metaKey });
}
async function openCourse(run: (page: Page, app: ElectronApplication) => Promise<void>, isolatedNavigation?: string) {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-pinch-response-'));
  if (isolatedNavigation) {
    const core = new CourseService(resolve('dist/worker.cjs'));
    try {
      const course = await core.open(join(root, 'course'));
      await core.setLayout(course.sessionId, [{ unitId: isolatedNavigation, x: 20_000, y: 20_000, width: 650 }]);
    } finally { await core.close(); }
  }
  const app = await controlledElectron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE:'1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  const page = await app.firstWindow();
  try {
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect.poll(async () => (await readCameraTransform(page.locator('.react-flow__viewport'))).zoom).toBe(.85);
    await waitForReadingLayout(page);
    await run(page, app);
  } finally {
    if (!page.isClosed()) await restoreFrames(page);
    await app.close(); await rm(root, { recursive: true, force: true });
  }
}

test('recorded pinch increments publish together at the next frame without losing the pointer anchor', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS ctrl/pixel pinch normalization');
  await openCourse(async page => {
    const viewport = page.locator('.react-flow__viewport'), before = await readCameraTransform(viewport);
    await holdFrames(page);
    const between = [], anchors = [];
    // Actual first three deltas from wheel-trace-1793202030526.json. Timing is controlled,
    // compressed into one frame: scheduling evidence, not physical latency/FPS/feel.
    for (const delta of [-0.49772170186042786, -2.052461624145508, -4.818196773529053]) {
      anchors.push(await sendPinch(page, delta)); between.push(await readCameraTransform(viewport));
    }
    await stepFrame(page);
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(.9414147408795596, 10);
    const after = await readCameraTransform(viewport);
    await writeFile(test.info().outputPath('pinch-frame.json'), JSON.stringify({ physical: false, before, between, after, anchors,
      distinctPreFrameViews: new Set(between.map(view => JSON.stringify(view))).size,
      source: 'installed-1793199811129/physical/session-1793201734534/wheel-trace-1793202030526.json' }, null, 2));
    expect(between).toEqual([before, before, before]);
    expect(anchors).toEqual([anchors[0], anchors[0], anchors[0]]);
    expect((anchors[0].x - after.x) / after.zoom).toBeCloseTo((anchors[0].x - before.x) / before.zoom, 8);
    expect((anchors[0].y - after.y) / after.zoom).toBeCloseTo((anchors[0].y - before.y) / before.zoom, 8);
  });
});

// Retained ctrl/pixel events from the sensitivity-accepted second recording (615 earlier
// events were dropped by its bounded trace). Keep event order and moving pointer centers.
const acceptedPinch = [
  [1.9179956912994385, 776, 379], [27.553173065185547, 776, 379],
  [17.582340240478516, 776, 379], [7.860495090484619, 776, 379],
  [0.2000901848077774, 776, 379], [-2.077871322631836, 710, 348],
  [-17.54566764831543, 710, 348], [-16.27923011779785, 710, 348],
  [-14.385475158691406, 710, 348], [-17.626184463500977, 710, 348],
];

test('coalescing preserves the accepted trace, moving anchors and per-event clamp reversal across frames', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS ctrl/pixel pinch normalization');
  await openCourse(async page => {
    const viewport = page.locator('.react-flow__viewport'), initial = await readCameraTransform(viewport);
    const board = (await page.locator('main.board').boundingBox())!;
    const replay = async (perEventFrame: boolean) => {
      for (const [delta, x, y] of acceptedPinch) {
        await sendPinch(page, delta, x - board.x, y - board.y);
        if (perEventFrame) await stepFrame(page);
      }
      await stepFrame(page); return readCameraTransform(viewport);
    };
    await holdFrames(page);
    const sequential = await replay(true);
    // Public navigation reset; DOM click avoids driver actionability RAF while held.
    await page.locator('nav .directory-theme').first().evaluate((el: HTMLButtonElement) => el.click());
    await expect.poll(() => readCameraTransform(viewport)).toEqual(initial);
    const batched = await replay(false);
    expect(batched.zoom).toBeCloseTo(sequential.zoom, 12);
    expect(batched.x).toBeCloseTo(sequential.x, 8); expect(batched.y).toBeCloseTo(sequential.y, 8);
    // Clamp and reversal in the SAME frame must not be reduced to a summed delta.
    await sendPinch(page, 100000); await sendPinch(page, -1); await stepFrame(page);
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(.04055837919160117, 12);
    await sendPinch(page, -100000); await sendPinch(page, 1); await stepFrame(page);
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(1.9724654089867184, 12);
    await sendPinch(page, 100, 100, 150, true); await stepFrame(page);
    const commandWheel = await readCameraTransform(viewport);
    expect(commandWheel.zoom).toBeCloseTo(1.7847605078327853, 12);
    await writeFile(test.info().outputPath('accepted-trace-batching.json'), JSON.stringify({ physical: false,
      source: 'corrected-gestures-0ad21ff/physical/session-1793203452630/wheel-trace-1793203955536.json',
      retainedPinchEvents: acceptedPinch.length, sequential, batched, commandWheel }, null, 2));
  });
});

test('pan consumes pending pinch once and newer navigation or pointer takeover cannot be overwritten', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS ctrl/pixel pinch normalization');
  await openCourse(async page => {
    const viewport = page.locator('.react-flow__viewport'), before = await readCameraTransform(viewport);
    await holdFrames(page);
    const anchor=await sendPinch(page, -0.49772170186042786);
    expect(await sendPinch(page, -2.052461624145508)).toEqual(anchor);
    await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaX: 25, deltaY: 40, bubbles: true, cancelable: true });
    const pan = await readCameraTransform(viewport);
    expect(pan.zoom).toBeCloseTo(.8805875869820007, 10);
    expect((anchor.x - (pan.x + 25)) / pan.zoom).toBeCloseTo((anchor.x - before.x) / before.zoom, 8);
    expect((anchor.y - (pan.y + 40)) / pan.zoom).toBeCloseTo((anchor.y - before.y) / before.zoom, 8);
    await stepFrame(page); expect(await readCameraTransform(viewport)).toEqual(pan);
    await sendPinch(page, -20);
    await page.locator('nav .directory-theme').nth(1).evaluate((el: HTMLButtonElement) => el.click());
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBe(.85);
    const navigation = await readCameraTransform(viewport);
    await stepFrame(page); expect(await readCameraTransform(viewport)).toEqual(navigation);
    // Pointer ownership supersedes the wheel frame before the new gesture starts.
    await sendPinch(page, -20);
    await page.locator('.react-flow__pane').dispatchEvent('pointerdown', { pointerId: 1, button: 1, bubbles: true });
    await stepFrame(page); expect(await readCameraTransform(viewport)).toEqual(navigation);
    await page.locator('.react-flow__pane').dispatchEvent('pointerup', { pointerId: 1, button: 1, bubbles: true });
    // Cancellation must allow a fresh batch from the latest live camera.
    await sendPinch(page, -0.49772170186042786); await stepFrame(page);
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(.8558851849132709, 10);
    await writeFile(test.info().outputPath('pinch-interruption.json'), JSON.stringify({ physical: false, before, pan, navigation,
      fresh: await readCameraTransform(viewport) }, null, 2));
    // Pending wheel frames must not overwrite navigation. Keep the destination
    // clear of unrelated measured-neighbor growth, which legitimately compensates it.
  }, 'KU-006');
});

test('pinch pauses automatic follow immediately while panel controls retain wheel ownership', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS ctrl/pixel pinch normalization');
  await openCourse(async page => {
    await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
    await page.getByRole('button', { name: '读取当前依据', exact: true }).click();
    await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('正在跟随修改');
    const viewport = page.locator('.react-flow__viewport');
    await holdFrames(page);
    await sendPinch(page, -0.49772170186042786);
    await sendPinch(page, -2.052461624145508);
    await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('已由你控制视野');
    await stepFrame(page);
    const taken = await readCameraTransform(viewport);
    await stepFrame(page); await stepFrame(page);
    expect(await readCameraTransform(viewport)).toEqual(taken);
    for (const target of [page.locator('.board-tools select'), page.getByRole('textbox', { name: '可控候选内容' })]) {
      await target.dispatchEvent('wheel', { deltaY: -100, ctrlKey: true, deltaMode: 0, bubbles: true, cancelable: true });
    }
    await stepFrame(page); expect(await readCameraTransform(viewport)).toEqual(taken);
    await restoreFrames(page);
    await page.screenshot({ path: test.info().outputPath('pinch-follow.png') });
  });
});

test('closing before the pending pinch frame preserves the cumulative camera on normal reopen', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS ctrl/pixel pinch normalization');
  await openCourse(async (page, app) => {
    const before = await readCameraTransform(page.locator('.react-flow__viewport'));
    await holdFrames(page);
    await sendPinch(page, -0.49772170186042786); await sendPinch(page, -2.052461624145508);
    expect(await readCameraTransform(page.locator('.react-flow__viewport'))).toEqual(before);
    const nextWindow = app.waitForEvent('window');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.windows().length).toBe(0);
    await app.evaluate(({ app }) => app.emit('activate'));
    const reopened = await nextWindow; await resizeBoardWindow(app, reopened);
    const after = await readCameraTransform(reopened.locator('.react-flow__viewport'));
    expect(after.zoom).toBeCloseTo(.8805875869820007, 10);
    expect((100 - after.x) / after.zoom).toBeCloseTo((100 - before.x) / before.zoom, 8);
    expect((150 - after.y) / after.zoom).toBeCloseTo((150 - before.y) / before.zoom, 8);
    await writeFile(test.info().outputPath('pinch-close-reopen.json'), JSON.stringify({ physical: false, before, after }, null, 2));
  });
});
