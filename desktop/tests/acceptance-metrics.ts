import type { CDPSession, ElectronApplication, Page, Worker as BrowserWorker } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { arch, cpus, totalmem, release } from 'node:os';
import type { CoreObservation, ObservationSnapshot } from '../src/acceptance-observation';

function command(path: string, args: string[]) { try { return execFileSync(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } }
export const deviceFacts = () => ({ platform: process.platform, arch: arch(), model: command('/usr/sbin/sysctl', ['-n', 'hw.model']),
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), kernel: release(),
  macOS: command('/usr/bin/sw_vers', ['-productVersion']), macOSBuild: command('/usr/bin/sw_vers', ['-buildVersion']) });

interface RendererSample { label: string; viewport: number[]; dpr: number; internal: ObservationSnapshot; [key: string]: unknown }
export class AcceptanceMetrics {
  private pages = new Map<Page, string>();
  private heaps = new Map<Page, CDPSession>();
  private workers = new Map<Page, { active: Set<BrowserWorker>; peak: number; total: number }>();
  private started = new Date().toISOString();
  private checkpoints: Array<{ label: string; at: string; core: CoreObservation; renderers: RendererSample[]; processes: unknown }> = [];
  private timings: Array<{ label: string; start: number; end: number; durationMs: number; outcome: string }> = [];
  constructor(private app: ElectronApplication, private directory: string, private context: Record<string, unknown>) {}
  async attach(page: Page, label: string) {
    this.pages.set(page, label);
    this.heaps.set(page, await page.context().newCDPSession(page));
    const workers = { active: new Set<BrowserWorker>(), peak: 0, total: 0 }; this.workers.set(page, workers);
    const trackWorker = (worker: BrowserWorker) => { if (workers.active.has(worker)) return;
      workers.active.add(worker); workers.total++; workers.peak = Math.max(workers.peak, workers.active.size); worker.once('close', () => workers.active.delete(worker)); };
    page.workers().forEach(trackWorker); page.on('worker', trackWorker);
    await page.evaluate(() => {
      if (!(window as any).__yizhiObservation) throw new Error('App was not launched with YIZHI_OBSERVE=1');
      const state = { raf: { count: 0, sum: 0, min: Infinity, max: 0, bins: Array(2002).fill(0) },
        longtask: { supported: PerformanceObserver.supportedEntryTypes.includes('longtask'), count: 0, sum: 0, max: 0 },
        peaks: {} as Record<string, number>, current: {} as Record<string, number>, frame: 0, last: 0, stopped: false,
        composition: { active: false, starts: 0, ends: 0, blockId: '' }, input: { events: 0, lastAt: 0, pendingSeen: false, acknowledged: 0, totalMs: 0, maxMs: 0 } };
      const compositionStart = (event: Event) => { state.composition.active = true; state.composition.starts++;
        state.composition.blockId = (event.target as Element).closest('[data-block-id]')?.getAttribute('data-block-id') ?? ''; };
      const compositionEnd = () => { state.composition.active = false; state.composition.ends++; };
      const input = () => { state.input.events++; state.input.lastAt = performance.now(); state.input.pendingSeen = false; };
      document.addEventListener('compositionstart', compositionStart, true); document.addEventListener('compositionend', compositionEnd, true); document.addEventListener('input', input, true);
      const dom = () => {
        const count = (selector: string) => document.querySelectorAll(selector).length;
        state.current = { readingLayers: count('.reading-layer'), editors: count('.tiptap.ProseMirror'), mathlive: count('math-field'),
          experiments: count('.builtin-experiment'), extensionFrames: count('.extension-frame iframe'), pdfCanvas: count('.source-pdf canvas'),
          pdfPixels: [...document.querySelectorAll<HTMLCanvasElement>('.source-pdf canvas')].reduce((sum, canvas) => sum + canvas.width * canvas.height, 0),
          textLayers: count('.source-pdf .textLayer') };
        for (const [name, value] of Object.entries(state.current)) state.peaks[name] = Math.max(state.peaks[name] ?? 0, value);
        const active = document.querySelector('article[data-reading-active=true]');
        const status = active?.querySelector('[aria-label="当前单元保存状态"]')?.textContent ?? document.querySelector('[aria-label="保存状态"]')?.textContent;
        if (state.input.lastAt && /待保存|正在保存/.test(status ?? '')) state.input.pendingSeen = true;
        if (state.input.lastAt && state.input.pendingSeen && !state.composition.active && /已保存|草稿已保留/.test(status ?? '')) {
          const duration = performance.now() - state.input.lastAt; state.input.acknowledged++; state.input.totalMs += duration; state.input.maxMs = Math.max(state.input.maxMs, duration); state.input.lastAt = 0;
        }
      };
      const frame = (now: number) => {
        if (state.stopped) return;
        if (state.last) { const value = now - state.last, r = state.raf; r.count++; r.sum += value; r.min = Math.min(r.min, value); r.max = Math.max(r.max, value); r.bins[Math.min(2001, Math.floor(value))]++; }
        state.last = now; state.frame = requestAnimationFrame(frame);
      };
      const observer = new MutationObserver(dom); observer.observe(document.body, { childList: true, subtree: true }); dom();
      const timer = setInterval(dom, 100);
      let longtask: PerformanceObserver | undefined;
      if (state.longtask.supported) { longtask = new PerformanceObserver(list => { for (const entry of list.getEntries()) {
        state.longtask.count++; state.longtask.sum += entry.duration; state.longtask.max = Math.max(state.longtask.max, entry.duration);
      } }); longtask.observe({ type: 'longtask' }); }
      state.frame = requestAnimationFrame(frame);
      (window as any).__t28Metrics = { snapshot: () => { dom(); return { viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
        screen: [screen.width, screen.height, screen.availWidth, screen.availHeight], visibility: document.visibilityState,
        focus: { documentFocused: document.hasFocus(), tag: document.activeElement?.tagName,
          label: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0, 120),
          headerInert: !!document.querySelector('header')?.hasAttribute('inert'), bodyInert: document.body.inert,
          rootInert: !!document.getElementById('root')?.hasAttribute('inert'), modalDialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.getAttribute('aria-label')) },
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        heap: (performance as any).memory ? { usedJSHeapSize: (performance as any).memory.usedJSHeapSize, totalJSHeapSize: (performance as any).memory.totalJSHeapSize } : null,
        raf: state.raf, longtask: state.longtask, composition: state.composition, input: state.input,
        dom: { current: state.current, peak: state.peaks }, internal: (window as any).__yizhiObservation() }; },
        stop: () => { state.stopped = true; cancelAnimationFrame(state.frame); clearInterval(timer); observer.disconnect(); longtask?.disconnect();
          document.removeEventListener('compositionstart', compositionStart, true); document.removeEventListener('compositionend', compositionEnd, true); document.removeEventListener('input', input, true); } };
    });
  }
  async time<T>(label: string, operation: () => Promise<T>) {
    const start = performance.now(); let outcome = 'completed';
    try { return await operation(); } catch (error) { outcome = 'failed'; throw error; }
    finally { const end = performance.now(); this.timings.push({ label, start, end, durationMs: end - start, outcome }); }
  }
  async sample(label: string) {
    const core = await this.app.evaluate(async () => (globalThis as any).__yizhiAcceptance.core()) as CoreObservation;
    const processes = await this.app.evaluate(async ({ app, BrowserWindow, screen }) => ({ runtime: process.versions, metrics: app.getAppMetrics(),
      hostMemory: await process.getProcessMemoryInfo(), windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), content: window.getContentSize(),
        display: screen.getDisplayMatching(window.getBounds()), rendererPid: window.webContents.getOSProcessId() })) }));
    const renderers: RendererSample[] = [];
    for (const [page, name] of this.pages) if (!page.isClosed()) renderers.push({ label: name, ...await page.evaluate(() => (window as any).__t28Metrics.snapshot()),
      v8Heap: await this.heaps.get(page)!.send('Runtime.getHeapUsage'), browserWorkers: { current: this.workers.get(page)!.active.size,
        peak: this.workers.get(page)!.peak, total: this.workers.get(page)!.total, urls: [...this.workers.get(page)!.active].map(worker => worker.url()) } });
    this.checkpoints.push({ label, at: new Date().toISOString(), core, processes, renderers });
  }
  async write(filename: string, extra: Record<string, unknown> = {}) {
    const workspaceStatus = command('git', ['status', '--porcelain']);
    const value = { schema: 'yizhi-t28-observation-1', startedAt: this.started, endedAt: new Date().toISOString(), device: deviceFacts(),
      context: { sourceSHA: command('git', ['rev-parse', 'HEAD']), dirty: workspaceStatus === null ? null : !!workspaceStatus, ...this.context }, limitations: ['Programmatic input, rAF and longtask are not physical input/feel.',
        'DOM peaks are sampled at mutations/100ms; lifecycle counters cover instrumented resources.',
        'Core RSS includes the host process; do not add it to host RSS.', 'rAF histogram uses 1ms bins; bin 2001 includes all larger gaps.'],
      checkpoints: this.checkpoints, timings: this.timings, ...extra };
    await writeFile(join(this.directory, filename), JSON.stringify(value, null, 2) + '\n'); return value;
  }
  async stop() { for (const page of this.pages.keys()) if (!page.isClosed()) await page.evaluate(() => (window as any).__t28Metrics?.stop()).catch(() => {}); }
}
