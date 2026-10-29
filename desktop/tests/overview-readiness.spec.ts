import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow, closeFailedBoard, captureBoardState } from './board-test-helpers';

test('initial overview fits declared graph geometry while actual graph node measurements are delayed', async () => {
  const input=process.env.YIZHI_OVERVIEW_INPUT?JSON.parse(await readFile(process.env.YIZHI_OVERVIEW_INPUT,'utf8')):undefined;
  const root = await mkdtemp(join(input?.evidenceDirectory??tmpdir(), 'yizhi-overview-ready-'));
  if(input)expect(JSON.parse(await readFile(join(input.app,'Contents/Resources/app/package-manifest.json'),'utf8')).source).toEqual({commit:input.sourceSHA,dirty:false});
  await mkdir(join(root,'empty'));
  const app = await electron.launch({ ...(input?{executablePath:join(input.app,'Contents/MacOS/YiZhi'),cwd:join(root,'empty')} : {}),args: [...(input?[]:[resolve('.')]), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'no-cli') } });
  let failure: unknown;
  try {
    const page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.addInitScript(() => {
      const NativeObserver = ResizeObserver;
      const held = new Map<ResizeObserver, () => void>();
      let delaying = true, deliveries = 0;
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            if (delaying && entries.some(entry => (entry.target as Element).matches('.react-flow__node'))) {
              deliveries++; held.set(observer, () => callback(entries, observer));
            } else callback(entries, observer);
          });
        }
      };
      (window as any).__overviewMeasurements = {
        read: () => ({ deliveries, held: held.size }),
        release() { delaying = false; for (const deliver of held.values()) deliver(); held.clear(); },
      };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.evaluate(() => (window as any).__overviewMeasurements.read().held)).toBeGreaterThan(0);
    try { await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false'); }
    finally {
      const proof = { state: await captureBoardState(app, page), delayed: await page.evaluate(() => (window as any).__overviewMeasurements.read()) };
      await writeFile(test.info().outputPath('overview-measurements.json'), JSON.stringify(proof, null, 2));
    }
    const viewport = await page.locator('.react-flow__viewport').evaluate((element: HTMLElement) => element.style.transform);
    expect(viewport).not.toBe('translate(0px, 0px) scale(1)');
    const geometry=await page.evaluate(async()=>{
      const b=window.yizhi,c=await b.open(),graph=await b.graph(c.sessionId),board=document.querySelector('main.board')!.getBoundingClientRect().toJSON();
      const nodes=[...document.querySelectorAll('.react-flow__node')].map(node=>node.getBoundingClientRect().toJSON());
      return {board,expected:graph.nodes.length+graph.groups.length,count:nodes.length,extent:{left:Math.min(...nodes.map(n=>n.left)),top:Math.min(...nodes.map(n=>n.top)),right:Math.max(...nodes.map(n=>n.right)),bottom:Math.max(...nodes.map(n=>n.bottom))}};
    });
    const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,executable:process.execPath}));
    await writeFile(test.info().outputPath('overview-geometry.json'),JSON.stringify({sourceSHA:input?.sourceSHA??null,runtime,geometry},null,2));
    if(input){expect(runtime).toEqual({packaged:true,executable:join(input.app,'Contents/MacOS/YiZhi')});}
    expect(geometry.count).toBe(geometry.expected);
    expect(geometry.extent.left).toBeGreaterThan(geometry.board.left+1);
    expect(geometry.extent.top).toBeGreaterThan(geometry.board.top+1);
    expect(geometry.extent.right).toBeLessThan(geometry.board.right-1);
    expect(geometry.extent.bottom).toBeLessThan(geometry.board.bottom-1);
    await page.evaluate(() => (window as any).__overviewMeasurements.release());
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(page.locator('article[data-unit-id="KU-001"] .tiptap')).toBeVisible();
  } catch (error) { failure = error; throw error; }
  finally { if (failure) await closeFailedBoard(app, failure); else await app.close(); if(!input)await rm(root, { recursive: true, force: true }); }
});
