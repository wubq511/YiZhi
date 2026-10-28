import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCameraTransform, resizeBoardWindow, revealBoardControl } from './board-test-helpers';
import { nativeTextPoints, nativeSelection, nativeDragText } from './native-selection-helpers';

for (const zoom of [.85, 1.2]) test(`native caret click and precise drag selection survive the transformed editor at zoom ${zoom}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-native-selection-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  let page: Page | undefined;
  try {
    page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const board = (await page.locator('main.board').boundingBox())!;
    if (zoom !== .85) await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaY: -Math.log(zoom / .85) * 1000,
      metaKey: true, clientX: Math.round(board.x + 120), clientY: Math.round(board.y + 170), bubbles: true, cancelable: true });
    await expect.poll(async () => (await readCameraTransform(page!.locator('.react-flow__viewport'))).zoom).toBeCloseTo(zoom, 8);
    await page.evaluate(() => document.fonts.ready);
    const paragraph = page.locator('article[data-unit-id="KU-001"] .tiptap p[data-block-id]').first();
    await revealBoardControl(page, paragraph);
    await paragraph.evaluate(p => { (window as any).__nativeSelectionEditor = p.closest('.tiptap'); });
    const points = await nativeTextPoints(paragraph);
    // These are native mouse actions on real text coordinates, not editor commands.
    await page.mouse.click(points.first.x, points.first.y, { clickCount: 1 });
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchorInText: true, anchor: points.first.offset,
      focusInText: true, focus: points.first.offset, collapsed: true, sameEditor: true,
      pm: { from: points.first.offset + 1, to: points.first.offset + 1 } });
    await page.mouse.click(points.last.x, points.last.y, { clickCount: 1 });
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.last.offset, focus: points.last.offset, collapsed: true });
    await nativeDragText(page, points.first, points.last, 8);
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.last.offset, text: points.expected });
    await page.mouse.up();
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchorInText: true, anchor: points.first.offset,
      focusInText: true, focus: points.last.offset, collapsed: false, text: points.expected, sameEditor: true });
    if (!points.wrapped) throw new Error('Need a native range across a soft wrap');
    await nativeDragText(page, points.first, points.wrapped, 12);
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.wrapped!.offset, text: points.wrappedExpected });
    await page.mouse.up();
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset,
      focus: points.wrapped!.offset, text: points.wrappedExpected, sameEditor: true });
    await page.mouse.click(points.last.x, points.last.y, { clickCount: 1 });
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ collapsed: true, anchor: points.last.offset,
      pm: { from: points.last.offset + 1, to: points.last.offset + 1 } });
    const marker = '[native pointer test]'; await page.keyboard.insertText(marker);
    const expected = points.paragraphText.slice(0, points.last.offset) + marker + points.paragraphText.slice(points.last.offset);
    const storedText = () => page!.evaluate(async () => (await (window as any).yizhi.open()).unit.reading.blocks[0].payload.text);
    await expect.poll(storedText).toBe(expected);
    await page.keyboard.press('Meta+z'); await expect.poll(storedText).toBe(points.paragraphText);
    await writeFile(test.info().outputPath('native-selection.json'), JSON.stringify({ zoom, points, actual: await nativeSelection(page, paragraph), physical: false }, null, 2));
  } catch (error) {
    if (page) {
      const p = page.locator('article[data-unit-id="KU-001"] .tiptap p[data-block-id]').first();
      await writeFile(test.info().outputPath('native-selection-failure.json'), JSON.stringify({ error: String(error), zoom,
        points: await nativeTextPoints(p).catch(String), actual: await nativeSelection(page, p).catch(String) }, null, 2));
      await page.screenshot({ path: test.info().outputPath('native-selection-failure.png') });
    }
    throw error;
  } finally { if (page && !page.isClosed()) await page.mouse.up().catch(() => {}); await app.close(); await rm(root, { recursive: true, force: true }); }
});
