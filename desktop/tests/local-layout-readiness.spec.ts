import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('a detached reading surface cannot poison reopening measurements before board readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-measurement-readiness-'));
  const guard = 'if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return;';
  const source = await readFile('src/renderer/local-layout.tsx', 'utf8');
  expect(source.split(guard)).toHaveLength(2); // Refuse a stale or ambiguous mutation.
  const outcomes: Record<string, any> = {};
  try {
    for (const guarded of [false, true]) {
      const variant = guarded ? 'guarded' : 'unguarded';
      const script = join(root, `${variant}.js`);
      await build({ stdin: { contents: `
        import {useEffect,useRef,useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {useLocalLayout,ReadingSurface} from './src/renderer/local-layout';
        const graph={layout:{nodes:[
          {unitId:'KU-001',x:0,y:0,width:650,height:100},
          {unitId:'KU-087',x:800,y:0,width:650,height:100}
        ]}};
        const camera={compensate(){}};
        function App(){
          const [ready,setReady]=useState(false),articleRef=useRef(null);
          const local=useLocalLayout(graph,undefined,camera,true,ready);
          useEffect(()=>{void local.waitForMeasurements(['KU-001','KU-087']).then(()=>setReady(true));},[]);
          window.__placements=local.placements;
          return <div className="workspace" aria-busy={!ready}>
            {local.placements.map(position=><ReadingSurface key={position.unitId}
              id={position.unitId} name={position.unitId} position={position} baseline={position}
              active={false} articleRef={articleRef} measure={local.measure}
              gesture={local.gesture} commit={()=>{}} takeover={()=>{}}>
              <p style={{height:240}}>Existing reading body</p>
            </ReadingSurface>)}
          </div>;
        }
        createRoot(document.getElementById('root')).render(<App/>);
      `, resolveDir: resolve('.'), loader: 'tsx' }, outfile: script, bundle: true,
        platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [{ name: 'measurement-control', setup(b) {
          b.onLoad({ filter: /renderer\/local-layout\.tsx$/ }, () => ({ contents: guarded ? source : source.replace(guard, ''), loader: 'tsx' }));
          b.onLoad({ filter: /src\/layout\.ts$/ }, async args => ({ loader: 'ts', contents: (await readFile(args.path, 'utf8')).replace(
            '  if (!sizes', '  (window as any).__projections.push({ids:baseline.map(n=>n.unitId),sizes:structuredClone(sizes)});\n  if (!sizes') }));
        } }],
      });
      const html = join(root, `${variant}.html`);
      await writeFile(html, `<!doctype html><div id="root"></div><script>
        window.__projections=[];window.__measurements=[];
        const NativeResizeObserver=ResizeObserver;
        window.ResizeObserver=class extends NativeResizeObserver {
          constructor(callback){super((entries,observer)=>{
            const node=entries.find(e=>e.target.dataset.unitId==='KU-087')?.target;
            if(node&&!window.__warm){
              window.__warm=true;callback(entries,observer);
              requestAnimationFrame(()=>{node.style.height='480px';});return;
            }
            if(node&&!window.__detached){
              window.__detached=true;
              const parent=node.parentElement;
              window.__measurements.push({connected:node.isConnected,width:node.offsetWidth,height:node.offsetHeight});
              // Hold the real callback across DOM removal, before passive observer cleanup.
              // Dimensions come from the browser; no fake rectangle or measure() call.
              node.remove();
              window.__measurements.push({connected:node.isConnected,width:node.offsetWidth,height:node.offsetHeight});
              callback(entries,observer);
              requestAnimationFrame(()=>{if(parent.isConnected){parent.append(node);node.style.height='500px';}});
            }else callback(entries,observer);
          });}
        };
      </script><script src="${variant}.js"></script>`);
      const host = join(root, `${variant}.cjs`);
      await writeFile(host, `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{
        const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
        w.loadFile(${JSON.stringify(html)});
      });`);
      const app = await electron.launch({ args: [host] });
      try {
        const page = await app.firstWindow();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        // The listener precedes the actual renderer mount, including the red crash.
        await page.reload();
        if (guarded) {
          await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
          await expect(page.locator('article')).toHaveCount(2);
          await expect.poll(() => page.evaluate(() => (window as any).__placements.find((n: any) => n.unitId === 'KU-087')?.height)).toBeGreaterThan(100);
          expect(errors).toEqual([]);
        } else {
          await expect.poll(() => errors).toContain('阅读尺寸无效');
          await expect(page.locator('.workspace')).toHaveCount(0);
          await expect(page.locator('article')).toHaveCount(0);
        }
        const state = await page.evaluate(() => ({ measurements: (window as any).__measurements,
          projections: (window as any).__projections, articles: document.querySelectorAll('article').length,
          busy: document.querySelector('.workspace')?.getAttribute('aria-busy') }));
        expect(state.measurements).toEqual([{ connected: true, width: 650, height: expect.any(Number) }, { connected: false, width: 0, height: 0 }]);
        expect(state.projections.every((p: any) => Object.keys(p.sizes).every(id => p.ids.includes(id)))).toBe(true);
        expect(state.projections.some((p: any) => p.sizes['KU-087']?.width === 0)).toBe(!guarded);
        outcomes[variant] = { errors, ...state };
      } finally { await app.close(); }
    }
    const evidence = test.info().outputPath('measurement-readiness-red-green.json');
    await writeFile(evidence, JSON.stringify(outcomes, null, 2));
    await test.info().attach('measurement-readiness-red-green.json', { path: evidence, contentType: 'application/json' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
