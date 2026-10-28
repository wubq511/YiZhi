import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCameraTransform, resizeBoardWindow } from './board-test-helpers';

test('Shift wheel uses the browser horizontal delta when the platform already remaps the axis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-shift-axis-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    const viewport = page.locator('.react-flow__viewport'), before = await readCameraTransform(viewport);
    // Public WheelEvent regression for the already-horizontal platform input.
    // This controlled event is never labelled physical input or evidence of macOS's actual deltas.
    await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaX: 120, deltaY: 0, deltaMode: 0,
      shiftKey: true, clientX: 650, clientY: 350, bubbles: true, cancelable: true });
    const after = await readCameraTransform(viewport);
    await writeFile(test.info().outputPath('shift-axis.json'), JSON.stringify({ input: { deltaX: 120, deltaY: 0, shiftKey: true }, before, after, physical: false }, null, 2));
    await expect.poll(async () => (await readCameraTransform(viewport)).x).toBeCloseTo(before.x - 120, 6);
    expect((await readCameraTransform(viewport)).y).toBe(before.y);
    expect((await readCameraTransform(viewport)).zoom).toBe(before.zoom);
    const horizontal = await readCameraTransform(viewport);
    // Platforms which leave the raw wheel on Y still get horizontal movement.
    await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaX: 0, deltaY: 80, deltaMode: 0,
      shiftKey: true, clientX: 650, clientY: 350, bubbles: true, cancelable: true });
    await expect.poll(async () => (await readCameraTransform(viewport)).x).toBeCloseTo(horizontal.x - 80, 6);
    expect((await readCameraTransform(viewport)).y).toBe(horizontal.y);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('native macOS pinch deltas use normalized pinch gain with a fixed pointer and hard zoom bounds', async () => {
  test.skip(process.platform !== 'darwin', 'Recorded native macOS pixel-mode pinch');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-native-pinch-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const viewport = page.locator('.react-flow__viewport'), before = await readCameraTransform(viewport);
    expect(before.zoom).toBe(.85); // Public normal navigation supplies a midrange camera.
    const board = (await page.locator('main.board').boundingBox())!;
    const pointer = { x: 100, y: 150 };
    const send = (deltaY: number, metaKey = false) => page.locator('.react-flow__pane').dispatchEvent('wheel', {
      deltaX: 0, deltaY, deltaMode: 0, ctrlKey: !metaKey, metaKey,
      clientX: board.x + pointer.x, clientY: board.y + pointer.y, bubbles: true, cancelable: true });
    // First two deltas from Robert's real trace, replayed as explicitly controlled events.
    await send(-0.49772170186042786); await send(-2.052461624145508);
    // Worked value for React Flow's existing macOS pinch normalization, not a feel/latency threshold.
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(.8805875869820007, 10);
    const after = await readCameraTransform(viewport);
    const world = (camera: typeof before) => ({ x: (pointer.x - camera.x) / camera.zoom, y: (pointer.y - camera.y) / camera.zoom });
    expect(world(after).x).toBeCloseTo(world(before).x, 8); expect(world(after).y).toBeCloseTo(world(before).y, 8);
    await send(100000); await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBe(.04);
    const minimum = await readCameraTransform(viewport); expect(world(minimum).x).toBeCloseTo(world(before).x, 8); expect(world(minimum).y).toBeCloseTo(world(before).y, 8);
    await send(-100000); await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBe(2);
    const maximum = await readCameraTransform(viewport); expect(world(maximum).x).toBeCloseTo(world(before).x, 8); expect(world(maximum).y).toBeCloseTo(world(before).y, 8);
    await send(100, true); await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(1.809674836071919, 10);
    await writeFile(test.info().outputPath('native-pinch-replay.json'), JSON.stringify({ physical: false,
      realTrace: 'session-1793201734534/wheel-trace-1793202030526.json', before, after, minimum, maximum, commandWheel: await readCameraTransform(viewport) }, null, 2));
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
