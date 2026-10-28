import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateFinalInput } from './acceptance-input';
import { navigateUnit } from './acceptance-study';
import { readCameraTransform, resizeBoardWindow, revealBoardControl } from './board-test-helpers';
import { nativeTextPoints, nativeSelection, nativeDragText } from './native-selection-helpers';

test('T28 combined installed selection and pinch preserve the same course input through reopen', async () => {
  test.skip(!process.env.YIZHI_SELECTION_INPUT, 'Parent-bound combined package affected check; no repeated 500 workload.');
  test.setTimeout(90000);
  const input = JSON.parse(await readFile(process.env.YIZHI_SELECTION_INPUT!, 'utf8')); validateFinalInput(input);
  const bytes = await readFile(join(input.app, 'Contents/Resources/app/package-manifest.json')), manifest = JSON.parse(bytes.toString());
  const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  expect(manifest.source).toEqual({ commit: input.sourceSHA, dirty: false });
  expect(hash(bytes)).toBe(input.appManifestSha256);
  const verificationSHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Test-only followups can verify the same signed runtime without inventing a new package source identity.
  execFileSync('git', ['merge-base', '--is-ancestor', input.sourceSHA, verificationSHA]);
  const verificationOnlyPaths = execFileSync('git', ['diff', '--name-only', input.sourceSHA, verificationSHA], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  expect(verificationOnlyPaths.filter(path => !/^desktop\/tests\//.test(path))).toEqual([]);
  expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  for (const entry of manifest.runtimeFiles) expect(hash(await readFile(join(input.app, 'Contents/Resources/app', entry.path)))).toBe(entry.sha256);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', input.app]);
  const launch = () => electron.launch({ executablePath: join(input.app, 'Contents/MacOS/YiZhi'), cwd: join(dirname(input.automatedEvidence), 'empty'),
    args: [`--course=${input.courseDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: '', NODE_OPTIONS: '', YIZHI_OBSERVE: '1',
      YIZHI_DATA_HOME: input.profileDirectory, YIZHI_CODEX_PATH: join(input.evidenceDirectory, 'missing-executor') } });
  let app = await launch(), page: Page | undefined;
  try {
    page = await app.firstWindow(); await page.context().setOffline(true); await resizeBoardWindow(app, page);
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath, versions: process.versions }));
    expect(runtime.packaged).toBe(true); expect(runtime.appPath).toBe(join(input.app, 'Contents/Resources/app'));
    expect(runtime.executable).toBe(join(input.app, 'Contents/MacOS/YiZhi'));
    const course = await page.evaluate(() => (window as any).yizhi.open());
    const graph = await page.evaluate(id => (window as any).yizhi.graph(id), course.sessionId); expect(graph.nodes).toHaveLength(500);
    const otherId = graph.nodes.find((node: any) => node.id.startsWith('KU-LOAD-') && node.id !== input.editableUnitId).id;
    await navigateUnit(page, graph, otherId); await navigateUnit(page, graph, input.editableUnitId);
    const before = await page.evaluate(async ({ id, unit }) => (window as any).yizhi.read(id, unit), { id: course.sessionId, unit: input.editableUnitId });
    const observations = [];
    for (const zoom of [.85, 1.2]) {
      if (zoom !== .85) {
        const board = (await page.locator('main.board').boundingBox())!, current = await readCameraTransform(page.locator('.react-flow__viewport'));
        await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaY: -Math.log(zoom / current.zoom) * 1000, metaKey: true,
          clientX: Math.round(board.x + 100), clientY: Math.round(board.y + 150), bubbles: true, cancelable: true });
      }
      await expect.poll(async () => (await readCameraTransform(page!.locator('.react-flow__viewport'))).zoom).toBeCloseTo(zoom, 8);
      await page.evaluate(() => document.fonts.ready);
      const paragraph = page.locator(`article[data-unit-id="${input.editableUnitId}"] .tiptap p[data-block-id]`).first();
      await revealBoardControl(page, paragraph); await paragraph.evaluate(p => { (window as any).__nativeSelectionEditor = p.closest('.tiptap'); });
      expect(await paragraph.getAttribute('tabindex')).toBeNull();
      const points = await nativeTextPoints(paragraph);
      await page.mouse.click(points.first.x, points.first.y, { clickCount: 1 });
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchorInText: true, anchor: points.first.offset, focus: points.first.offset,
        collapsed: true, sameEditor: true, pm: { from: points.first.offset + 1, to: points.first.offset + 1 } });
      // Separate independent native gestures spatially: rapid same-origin downs legitimately form a triple click.
      await page.mouse.click(points.last.x, points.last.y, { clickCount: 1 });
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.last.offset, focus: points.last.offset, collapsed: true });
      await nativeDragText(page, points.first, points.last, 8);
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.last.offset, text: points.expected });
      await page.mouse.up();
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.last.offset, text: points.expected, sameEditor: true });
      if (!points.wrapped) throw new Error('Installed source needs a soft-wrapped native range');
      await page.mouse.click(points.last.x, points.last.y, { clickCount: 1 });
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.last.offset, focus: points.last.offset, collapsed: true });
      await nativeDragText(page, points.first, points.wrapped, 12);
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.wrapped!.offset, text: points.wrappedExpected });
      await page.mouse.up();
      await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.wrapped!.offset, text: points.wrappedExpected, sameEditor: true });
      observations.push({ zoom, points, actual: await nativeSelection(page, paragraph) });
    }
    await navigateUnit(page, graph, otherId); await navigateUnit(page, graph, input.editableUnitId);
    const viewport = page.locator('.react-flow__viewport'), camera = await readCameraTransform(viewport); expect(camera.zoom).toBe(.85);
    // Controlled browser scheduling boundary; the actual installed app/listeners/setter stay real.
    await page.evaluate(() => {
      const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame, pending = new Map<number, FrameRequestCallback>(); let id = 1000000;
      window.requestAnimationFrame = callback => { pending.set(++id, callback); return id; };
      window.cancelAnimationFrame = key => { if (!pending.delete(key)) cancel.call(window, key); };
      (window as any).__installedPinchFrames = { step: () => { const batch = [...pending.values()]; pending.clear(); batch.forEach(callback => callback(performance.now())); },
        restore: () => { window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel; pending.clear(); } };
    });
    const board = (await page.locator('main.board').boundingBox())!, client = { x: Math.round(board.x + 100), y: Math.round(board.y + 150) };
    const between = [];
    for (const deltaY of [-.49772170186042786, -2.052461624145508, -4.818196773529053]) {
      await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaY, deltaMode: 0, ctrlKey: true, clientX: client.x, clientY: client.y, bubbles: true, cancelable: true });
      between.push(await readCameraTransform(viewport));
    }
    expect(between).toEqual([camera, camera, camera]);
    await page.evaluate(() => (window as any).__installedPinchFrames.step());
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(.9414147408795596, 10);
    const pinched = await readCameraTransform(viewport), pointer = { x: client.x - board.x, y: client.y - board.y };
    expect((pointer.x - pinched.x) / pinched.zoom).toBeCloseTo((pointer.x - camera.x) / camera.zoom, 8);
    expect((pointer.y - pinched.y) / pinched.zoom).toBeCloseTo((pointer.y - camera.y) / camera.zoom, 8);
    await page.evaluate(() => (window as any).__installedPinchFrames.restore());
    await navigateUnit(page, graph, otherId); await navigateUnit(page, graph, input.editableUnitId);
    await expect.poll(() => page!.evaluate(async id => (await (window as any).yizhi.readingState(id)).camera.zoom, course.sessionId)).toBe(.85);
    await app.close(); app = await launch(); page = await app.firstWindow(); await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const after = await page.evaluate(async unit => { const api = (window as any).yizhi, course = await api.open(); return api.read(course.sessionId, unit); }, input.editableUnitId);
    expect(after.unit).toEqual(before.unit); expect(after.drafts).toEqual(before.drafts);
    const reopened = await readCameraTransform(page.locator('.react-flow__viewport')); expect(reopened.zoom).toBe(.85);
    await writeFile(join(input.evidenceDirectory, 'affected-installed.json'), JSON.stringify({ status: 'passed', scope: 'native-coordinate selection plus pinch frame publication/reopen only',
      input, verificationSHA, verificationOnlyPaths, manifestSha256: hash(bytes), runtime, graphUnits: graph.nodes.length, observations, pinch: { camera, between, pinched, pointer }, reopened,
      bodyAndDraftUnchanged: true, physicalStatus: 'pending Robert selection/pinch directness and remaining IME/panels' }, null, 2) + '\n');
  } finally {
    if (page && !page.isClosed()) { await page.mouse.up().catch(() => {}); await page.evaluate(() => (window as any).__installedPinchFrames?.restore()).catch(() => {}); }
    await app.close();
  }
});
