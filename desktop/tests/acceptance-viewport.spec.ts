import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';
import { navigateUnit } from './acceptance-study';

test('opt-in camera observation retains the numeric viewport when CSS serializes coordinates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-camera-observer-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    const sessionId = await page.evaluate(async () => (await (window as any).yizhi.open()).sessionId);
    const graph = await page.evaluate(sessionId => (window as any).yizhi.graph(sessionId), sessionId);
    await navigateUnit(page, graph, 'KU-001');
    await expect.poll(() => page.evaluate(async sessionId => {
      const saved = (await (window as any).yizhi.readingState(sessionId)).camera, displayed = (window as any).__yizhiViewport();
      return !!saved && saved.x === displayed.x && saved.y === displayed.y && saved.zoom === displayed.zoom;
    }, sessionId)).toBe(true);
    const evidence = await page.evaluate(() => {
      const viewport = (window as any).__yizhiViewport();
      const samples = [-1007.0391288795561, -123456.123456789, -1234567.987654321].map(y => {
        const node = document.createElement('div');
        node.style.cssText = `position:fixed;visibility:hidden;transform:translate(35.35000000000002px, ${y}px) scale(.85)`;
        document.body.append(node);
        const inline = node.style.transform, computed = getComputedStyle(node).transform;
        const inlineY = new DOMMatrixReadOnly(inline).f, computedY = new DOMMatrixReadOnly(computed).f;
        node.remove(); return { y, inline, computed, inlineY, computedY };
      });
      return { viewport, samples };
    });
    await writeFile(test.info().outputPath('camera-observer.json'), JSON.stringify(evidence, null, 2) + '\n');
    // The observer returns a detached value; a consumer cannot change the camera through it.
    expect(await page.evaluate(() => {
      const before = (window as any).__yizhiViewport(), changed = (window as any).__yizhiViewport(); changed.y = 0;
      return (window as any).__yizhiViewport().y === before.y;
    })).toBe(true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
