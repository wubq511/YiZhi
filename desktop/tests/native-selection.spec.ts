import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCameraTransform, resizeBoardWindow, revealBoardControl, waitForReadingLayout } from './board-test-helpers';
import { nativeTextPoints, nativeSelection, nativeDragText } from './native-selection-helpers';

for (const zoom of [.85, 1.2]) test(`native caret click and precise drag selection survive the transformed editor at zoom ${zoom}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-native-selection-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  let page: Page | undefined;
  const nativeEnvironment=()=>app.evaluate(({BrowserWindow,screen})=>({time:Date.now(),cursor:screen.getCursorScreenPoint(),
    windows:BrowserWindow.getAllWindows().map(window=>({id:window.id,focused:window.isFocused(),visible:window.isVisible(),bounds:window.getBounds(),content:window.getContentBounds()}))}));
  let initialEnvironment:Awaited<ReturnType<typeof nativeEnvironment>>|undefined;
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
    await waitForReadingLayout(page);
    initialEnvironment=await nativeEnvironment();
    await writeFile(test.info().outputPath('native-environment-before.json'),JSON.stringify(initialEnvironment,null,2));
    expect(initialEnvironment.windows).toHaveLength(1);
    expect(initialEnvironment.windows[0]).toMatchObject({focused:true,visible:true});
    expect(await page.evaluate(()=>document.hasFocus())).toBe(true);
    // Bounded provenance for trusted native pointer delivery; no selection setter.
    await paragraph.evaluate(p=>{
      const events:any[]=[];(window as any).__nativeSelectionEvents=events;
      for(const kind of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','selectionchange'])document.addEventListener(kind,event=>{
        if(events.length>=160)return;const e=event as MouseEvent,s=getSelection(),editor=(p.closest('.tiptap') as any).editor;
        events.push({kind,time:performance.now(),x:e.clientX,y:e.clientY,buttons:e.buttons,detail:e.detail,trusted:e.isTrusted,defaultPrevented:e.defaultPrevented,
          anchor:s?.anchorOffset,focus:s?.focusOffset,anchorInText:s?.anchorNode===p.firstChild,focusInText:s?.focusNode===p.firstChild,collapsed:s?.isCollapsed,
          pm:{from:editor.state.selection.from,to:editor.state.selection.to},focused:document.hasFocus(),camera:(document.querySelector('.react-flow__viewport') as HTMLElement)?.style.transform});
      });
    });
    const points = await nativeTextPoints(paragraph);
    // These are native mouse actions on real text coordinates, not editor commands.
    await page.mouse.click(points.first.x, points.first.y, { clickCount: 1 });
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchorInText: true, anchor: points.first.offset,
      focusInText: true, focus: points.first.offset, collapsed: true, sameEditor: true,
      pm: { from: points.first.offset + 1, to: points.first.offset + 1 } });
    await page.mouse.click(points.last.x, points.last.y, { clickCount: 1 });
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.last.offset, focus: points.last.offset, collapsed: true,
      pm:{from:points.last.offset+1,to:points.last.offset+1} });
    await nativeDragText(page, points.first, points.last, 8);
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.first.offset, focus: points.last.offset, text: points.expected });
    await page.mouse.up();
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchorInText: true, anchor: points.first.offset,
      focusInText: true, focus: points.last.offset, collapsed: false, text: points.expected, sameEditor: true });
    if (!points.wrapped) throw new Error('Need a native range across a soft wrap');
    // This is a separate drag, not another click in a native multi-click sequence at the first glyph.
    await page.mouse.click(points.last.x, points.last.y, { clickCount: 1 });
    await expect.poll(() => nativeSelection(page!, paragraph)).toMatchObject({ anchor: points.last.offset, focus: points.last.offset, collapsed: true,
      pm:{from:points.last.offset+1,to:points.last.offset+1} });
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
    const nativeEvents=await page.evaluate(()=>(window as any).__nativeSelectionEvents);
    expect(nativeEvents.filter((event:any)=>event.kind==='pointerdown'||event.kind==='pointermove'||event.kind==='pointerup').every((event:any)=>event.trusted)).toBe(true);
    await writeFile(test.info().outputPath('native-selection.json'), JSON.stringify({ zoom, points, actual: await nativeSelection(page, paragraph), physical: false,nativeEvents,initialEnvironment,finalEnvironment:await nativeEnvironment() }, null, 2));
  } catch (error) {
    if (page) {
      const p = page.locator('article[data-unit-id="KU-001"] .tiptap p[data-block-id]').first();
      await writeFile(test.info().outputPath('native-selection-failure.json'), JSON.stringify({ error: String(error), zoom,initialEnvironment,environment:await nativeEnvironment().catch(String),
        points: await nativeTextPoints(p).catch(String), actual: await nativeSelection(page, p).catch(String), nativeEvents:await page.evaluate(()=>(window as any).__nativeSelectionEvents) }, null, 2));
      await page.screenshot({ path: test.info().outputPath('native-selection-failure.png') });
    }
    throw error;
  } finally { if (page && !page.isClosed()) await page.mouse.up().catch(() => {}); await app.close(); await rm(root, { recursive: true, force: true }); }
});
