import { test, expect, _electron as electron } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CourseService } from '../src/core/course-service';
import { unitBlocks } from '../src/reading-model';
import { closeFailedBoard, expectBoundedReading, readCameraTransform, resizeBoardWindow } from './board-test-helpers';

test('all visible short bodies load beyond eight and a static native selection survives leaving the range', async () => {
  const input = process.env.YIZHI_READING_RANGE_INPUT ? JSON.parse(await readFile(process.env.YIZHI_READING_RANGE_INPUT, 'utf8')) : undefined;
  const root = await mkdtemp(join(input?.evidenceDirectory ?? tmpdir(), 'yizhi-reading-coverage-'));
  const course = join(root, 'course');
  if (input) {
    const manifest = JSON.parse(await readFile(join(input.app, 'Contents/Resources/app/package-manifest.json'), 'utf8'));
    expect(manifest.source).toEqual({ commit: input.sourceSHA, dirty: false });
    for (const file of manifest.runtimeFiles) expect(createHash('sha256').update(await readFile(join(input.app, 'Contents/Resources/app', file.path))).digest('hex')).toBe(file.sha256);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', input.app]);
    await cp(input.courseDirectory, course, { recursive: true });
  }
  const worker = input ? join(input.app, 'Contents/Resources/app/dist/worker.cjs') : resolve('dist/worker.cjs');
  const core = new CourseService(worker);
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined, failure: unknown;
  try {
    const c = await core.open(course), graph = await core.graph(c.sessionId);
    if (input) expect(graph.nodes).toHaveLength(500);
    const ids: string[] = input ? graph.nodes.filter(n => n.id.startsWith('KU-LOAD-')).slice(0, 10).map(n => n.id)
      : ['KU-001', 'KU-002', 'KU-003', 'KU-004', 'KU-005', 'KU-006', 'KU-035', 'KU-055', 'KU-057', 'KU-062'];
    const heldId=ids[5];let unrelatedBoundaryId='';
    const originals = input ? await Promise.all(graph.nodes.filter(n => !n.id.startsWith('KU-LOAD-')).map(async n => ({ id: n.id, unit: await core.readUnit(c.sessionId, n.id) }))) : [];
    for (const id of ids) {
      const snapshot = await core.read(c.sessionId, id), blocks = snapshot.unit.reading.blocks;
      const paragraph = blocks.find(b => b.kind === 'paragraph' && !b.children?.length)!;
      const unrelated=id===heldId?blocks.find(b=>b.kind==='exercise')!:undefined;
      if(unrelated)unrelatedBoundaryId=unrelated.id;
      // Change only this disposable scene. Keep existing experiment definitions and identities intact.
      const retained = blocks.filter(b => b.id === paragraph.id || b.id===unrelated?.id || unitBlocks({ reading: { blocks: [b] } }).some(child => child.kind === 'interactive'));
      await core.commitEdit({ sessionId: c.sessionId, unitId: id, operationId: `reading-coverage-${id}`, inputSeq: 1,
        baseRevision: snapshot.revision, complete: true, changes: [], patch: {
          updates: [{ blockId: paragraph.id, before: paragraph.payload, after: { ...paragraph.payload, text: `Reading range body ${id}` } }],
          structure: { parentId: id, before: blocks.map(b => b.id), after: retained.map(b => b.id), inserted: [] }, correspondence: [],
        } });
    }
    await core.setLayout(c.sessionId, ids.map((unitId, index) => ({ unitId, x: 20_000 + index % 5 * 400, y: 20_000 + Math.floor(index / 5) * 650, width: 360 })));
    await core.setReadingState(c.sessionId, { unitId: 'KU-001', pinnedUnitId: 'KU-001', expanded: {}, returnStack: [], scrollTop: 0,
      camera: { x: 10 - 20_000 * .55, y: 10 - 20_000 * .55, zoom: .55 } });
    for (const original of originals) expect(await core.readUnit(c.sessionId, original.id)).toEqual(original.unit);
    await core.close();
    await mkdir(join(root, 'empty'));
    app = await electron.launch({ ...(input ? { executablePath: join(input.app, 'Contents/MacOS/YiZhi'), cwd: join(root, 'empty') } : {}),
      args: [...(input ? [] : [resolve('.')]), `--course=${course}`],
      env: { ...process.env, YIZHI_OBSERVE: '1', YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'no-cli') } });
    const page = await app.firstWindow(); await page.context().setOffline(true); await resizeBoardWindow(app, page, 1440, 842);
    const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath }));
    if (input) expect(runtime.executable).toBe(join(input.app, 'Contents/MacOS/YiZhi'));
    for (const id of ids) await expect(page.locator(`article[data-unit-id="${id}"]`)).toContainText(`Reading range body ${id}`);
    const visible = await page.evaluate(() => {
      const board = document.querySelector('main.board')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('article[data-unit-id]')].filter(article => {
        const rect = article.getBoundingClientRect(); return rect.left < board.right && rect.right > board.left && rect.top < board.bottom && rect.bottom > board.top;
      }).map(article => article.dataset.unitId);
    });
    expect(visible.length).toBeGreaterThan(8);
    await expectBoundedReading(page);
    expect(visible).toContain(heldId);expect(unrelatedBoundaryId).not.toBe('');
    const unrelated=page.locator(`article[data-unit-id="${heldId}"] [data-reading-block][data-block-id="${unrelatedBoundaryId}"]`);
    await expect(unrelated.locator('details.material > summary').first()).toHaveCount(1);
    const paragraph = page.locator(`article[data-unit-id="${heldId}"]`).getByText(`Reading range body ${heldId}`, { exact: true });
    expect(await page.locator(`article[data-unit-id="${heldId}"] .tiptap`).count()).toBe(0);
    const held = await paragraph.evaluate(element => {
      const text = element.firstChild!, range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 12);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      (window as any).__heldStaticBody = element.closest('article'); return range.toString();
    });
    const board = (await page.locator('main.board').boundingBox())!;
    await page.locator('.react-flow__pane').dispatchEvent('wheel', { deltaX: 100_000, deltaY: 100_000,
      clientX: board.x + 8, clientY: board.y + 150, bubbles: true, cancelable: true });
    await expect.poll(() => page.evaluate(() => (window as any).__yizhiObservation()['reading.cachedUnits'].current)).toBeLessThanOrEqual(4);
    const selectionState = await paragraph.evaluate(element => {
      const ancestors = []; for (let node: Element | null = element; node; node = node.parentElement)
        ancestors.push({ tag: node.tagName, blockId: node.getAttribute('data-block-id'), inert: node.hasAttribute('inert') });
      return { ancestors, connected: element.isConnected, selection: getSelection()?.toString(), focused: document.activeElement?.tagName };
    });
    const selectionPath=test.info().outputPath('retained-static-selection.json');
    await writeFile(selectionPath,JSON.stringify(selectionState,null,2));
    await test.info().attach('retained-static-selection.json', { path: selectionPath, contentType: 'application/json' });
    expect(await page.evaluate(() => (window as any).__heldStaticBody.isConnected)).toBe(true);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(held);
    expect(selectionState.ancestors.some(node=>node.inert)).toBe(false);
    await expect(unrelated).toHaveAttribute('inert','');
    await expectBoundedReading(page);
    const retained = await page.evaluate(() => (window as any).__yizhiObservation());
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await expect(page.locator(`article[data-unit-id="${heldId}"]`)).toHaveCount(0);
    const cameraAfterPan=await readCameraTransform(page.locator('.react-flow__viewport'));
    let reopened: unknown;
    if(input){
      await app.close();
      app=await electron.launch({executablePath:join(input.app,'Contents/MacOS/YiZhi'),cwd:join(root,'empty'),args:[`--course=${course}`],
        env:{...process.env,YIZHI_OBSERVE:'1',YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'no-cli')}});
      const next=await app.firstWindow();await next.context().setOffline(true);await resizeBoardWindow(app,next,1440,842);
      const camera=await readCameraTransform(next.locator('.react-flow__viewport'));
      for(const key of ['x','y','zoom'] as const)expect(camera[key]).toBeCloseTo(cameraAfterPan[key],5);
      const state=await next.evaluate(async(id)=>{const c=await window.yizhi.open();return {graph:await window.yizhi.graph(c.sessionId),body:await window.yizhi.readUnit(c.sessionId,id)};},ids[0]);
      expect(state.graph.nodes).toHaveLength(500);expect(JSON.stringify(state.body)).toContain(`Reading range body ${ids[0]}`);
      for(const original of originals)expect(await next.evaluate(async id=>{const c=await window.yizhi.open();return window.yizhi.readUnit(c.sessionId,id);},original.id)).toEqual(original.unit);
      await expectBoundedReading(next);reopened={camera,nodeCount:state.graph.nodes.length,originalUnitsUnchanged:originals.length};
    }
    const evidence = { sourceSHA: input?.sourceSHA ?? null, runtime, originalUnitsUnchanged: originals.length, visible, heldId, held, retained,
      cameraAfterPan,reopened, unrelatedOffscreenMaterialInert:unrelatedBoundaryId, physical: false, scope: 'targeted scene; existing corpus; no growth workload or model run' };
    await writeFile(join(root, 'reading-range.json'), JSON.stringify(evidence, null, 2));
    await writeFile(test.info().outputPath('reading-range.json'), JSON.stringify(evidence, null, 2));
  } catch (error) { failure = error; throw error; }
  finally { await core.close(); if (app) { if (failure) await closeFailedBoard(app, failure); else await app.close(); } if (!input) await rm(root, { recursive: true, force: true }); }
});
