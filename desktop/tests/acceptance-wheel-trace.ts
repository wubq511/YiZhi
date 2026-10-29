import type { Page } from '@playwright/test';

/** Passive, bounded raw browser events. isTrusted alone is not physical evidence:
 * the operator must identify the real device/gesture and its observed result. */
export async function startWheelTrace(page: Page, label: string) {
  await page.evaluate(label => {
    if ((window as any).__t28WheelTrace) throw new Error('Stop the current wheel trace before starting another');
    const state = { label, startedAt: new Date().toISOString(), total: 0, dropped: 0, limit: 512,
      events: [] as Array<Record<string, unknown>> };
    const listen = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = { at: performance.now(), deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ,
        deltaMode: event.deltaMode, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
        clientX: event.clientX, clientY: event.clientY, isTrusted: event.isTrusted, cancelable: event.cancelable,
        target: { tag: target?.tagName, classes: target?.getAttribute('class')?.slice(0, 180),
          inBoard: !!target?.closest('main.board'), unitId: target?.closest('[data-unit-id]')?.getAttribute('data-unit-id'),
          control: target?.closest('input, select, textarea, math-field, [role=dialog], .board-tools, .table-scroll, .react-flow__minimap')?.tagName },
        defaultPreventedAtCapture: event.defaultPrevented, defaultPreventedAfterDispatch: null as boolean | null };
      state.total++;
      if (state.events.length === state.limit) { state.events.shift(); state.dropped++; }
      state.events.push(row);
      setTimeout(() => { row.defaultPreventedAfterDispatch = event.defaultPrevented; }, 0);
    };
    window.addEventListener('wheel', listen, { capture: true, passive: true });
    (window as any).__t28WheelTrace = { stop: () => {
      window.removeEventListener('wheel', listen, true); delete (window as any).__t28WheelTrace;
      return { ...state, endedAt: new Date().toISOString(), policy: 'passive raw event trace; no input emitted; no physical pass inferred' };
    } };
  }, label);
}

export async function stopWheelTrace(page: Page) {
  return page.evaluate(() => {
    if (!(window as any).__t28WheelTrace) throw new Error('No wheel trace is active');
    return (window as any).__t28WheelTrace.stop();
  });
}
