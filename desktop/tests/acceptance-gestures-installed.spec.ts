import { test, expect, _electron as electron } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validateFinalInput } from './acceptance-input';
import { navigateUnit } from './acceptance-study';
import { readCameraTransform, resizeBoardWindow } from './board-test-helpers';

test('T28 corrected installed gestures retain the existing 500 course and reopen at a midrange reading camera', async () => {
  test.skip(!process.env.YIZHI_GESTURE_INPUT, 'Opt-in affected installed check; never rebuilds or renavigates the 500 fixture.');
  test.setTimeout(90000);
  const path = process.env.YIZHI_GESTURE_INPUT!;
  const input = JSON.parse(await readFile(path, 'utf8')); validateFinalInput(input);
  const manifestBytes = await readFile(join(input.app, 'Contents/Resources/app/package-manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString()), digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  expect(manifest.source).toEqual({ commit: input.sourceSHA, dirty: false });
  expect(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(input.sourceSHA);
  expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  for (const entry of manifest.runtimeFiles) expect(digest(await readFile(join(input.app, 'Contents/Resources/app', entry.path)))).toBe(entry.sha256);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', input.app]);
  const launch = () => electron.launch({ executablePath: join(input.app, 'Contents/MacOS/YiZhi'), cwd: join(dirname(input.automatedEvidence), 'empty'), args: [`--course=${input.courseDirectory}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_PATH: '', NODE_OPTIONS: '', YIZHI_OBSERVE: '1',
      YIZHI_DATA_HOME: input.profileDirectory, YIZHI_CODEX_PATH: join(input.evidenceDirectory, 'missing-executor') } });
  let app = await launch();
  try {
    const page = await app.firstWindow(); await page.context().setOffline(true); await resizeBoardWindow(app, page);
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, path: app.getAppPath(), executable: process.execPath, versions: process.versions }));
    expect(runtime.packaged).toBe(true); expect(runtime.path).toBe(join(input.app, 'Contents/Resources/app'));
    const opened = await page.evaluate(() => (window as any).yizhi.open());
    const graph = await page.evaluate(sessionId => (window as any).yizhi.graph(sessionId), opened.sessionId); expect(graph.nodes).toHaveLength(500);
    const ids = [input.editableUnitId, graph.nodes.find((node: any) => node.id.startsWith('KU-LOAD-') && node.id !== input.editableUnitId).id];
    await navigateUnit(page, graph, ids[1]); await navigateUnit(page, graph, ids[0]);
    const original = await page.evaluate(async ({ sessionId, unitId }) => (window as any).yizhi.read(sessionId, unitId), { sessionId: opened.sessionId, unitId: ids[0] });
    expect(original.drafts.some((draft: any) => draft.input.formulaDrafts?.length)).toBe(true);
    const viewport = page.locator('.react-flow__viewport'), before = await readCameraTransform(viewport); expect(before.zoom).toBe(.85);
    const board = (await page.locator('main.board').boundingBox())!, pointer = { x: 100, y: 150 };
    const send = (deltaX: number, deltaY: number, keys: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) => page.locator('.react-flow__pane').dispatchEvent('wheel', {
      deltaX, deltaY, deltaMode: 0, ...keys, clientX: board.x + pointer.x, clientY: board.y + pointer.y, bubbles: true, cancelable: true });
    await send(40, 0, { shiftKey: true });
    await expect.poll(async () => (await readCameraTransform(viewport)).x).toBeCloseTo(before.x - 40, 8);
    expect((await readCameraTransform(viewport)).y).toBe(before.y);
    const panned = await readCameraTransform(viewport);
    await send(0, -0.49772170186042786, { ctrlKey: true }); await send(0, -2.052461624145508, { ctrlKey: true });
    await expect.poll(async () => (await readCameraTransform(viewport)).zoom).toBeCloseTo(.8805875869820007, 10);
    const pinched = await readCameraTransform(viewport);
    expect((pointer.x - pinched.x) / pinched.zoom).toBeCloseTo((pointer.x - panned.x) / panned.zoom, 8);
    expect((pointer.y - pinched.y) / pinched.zoom).toBeCloseTo((pointer.y - panned.y) / panned.zoom, 8);
    await send(0, 100, { metaKey: true });
    const commandWheel = await readCameraTransform(viewport); expect(commandWheel.zoom).toBeCloseTo(.7967885985593094, 10);
    // End at normal reading zoom, not the old physical session's upper clamp.
    await navigateUnit(page, graph, ids[1]); await navigateUnit(page, graph, ids[0]);
    await expect(page.getByRole('status', { name: '阅读状态', exact: true })).toHaveText('阅读位置已保存');
    await expect.poll(() => page.evaluate(async sessionId => (await (window as any).yizhi.readingState(sessionId)).camera.zoom, opened.sessionId)).toBe(.85);
    const ready = await readCameraTransform(viewport); expect(ready.zoom).toBe(.85);
    await app.close(); app = await launch(); const reopened = await app.firstWindow(); await expect(reopened.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const saved = await reopened.evaluate(async unitId => { const api = (window as any).yizhi, course = await api.open(); return api.read(course.sessionId, unitId); }, ids[0]);
    expect(saved.unit).toEqual(original.unit); expect(saved.drafts).toEqual(original.drafts);
    const reopenedCamera = await readCameraTransform(reopened.locator('.react-flow__viewport')); expect(reopenedCamera.zoom).toBe(.85);
    await writeFile(join(input.evidenceDirectory, 'affected-installed.json'), JSON.stringify({ status: 'passed', scope: 'affected installed gesture reacceptance; no repeated 500 load',
      input, appManifestSha256: digest(manifestBytes), runtime, graphUnits: graph.nodes.length, before, panned, pinched, commandWheel, ready, reopenedCamera,
      unitAndDraftPreserved: true, programmaticEventReplay: true, physicalStatus: 'failed gestures still require Robert recheck' }, null, 2) + '\n');
  } finally { await app.close(); }
});
