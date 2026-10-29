import type { Page, Locator } from '@playwright/test';

/** Measure native glyphs/hit testing without installing a DOM or editor selection. */
export async function nativeTextPoints(paragraph: Locator) {
  return paragraph.evaluate(p => {
    const text = p.firstChild!;
    if (text.nodeType !== Node.TEXT_NODE) throw new Error('Need an ordinary text paragraph');
    const board = p.closest('main.board')!.getBoundingClientRect(), points = [];
    for (let index = 3; index < text.textContent!.length - 3; index++) {
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect(), x = rect.left + rect.width * .25, y = rect.top + rect.height / 2;
      if (y < board.top + 120 || y > board.bottom - 30 || x < board.left + 30 || x > board.right - 180) continue;
      if (document.elementFromPoint(x, y)?.closest('p') !== p) continue;
      const hit = document.caretRangeFromPoint(x, y);
      if (hit?.startContainer === text) points.push({ x, y, offset: hit.startOffset });
    }
    const first = points[0], last = points.find(point => point.y === first?.y && point.offset >= first.offset + 5);
    if (!first || !last) throw new Error('No visible native text range');
    const wrapped = points.find(point => point.y > first.y + 3 && point.offset > last.offset);
    return { first, last, wrapped, paragraphText: text.textContent!, expected: text.textContent!.slice(first.offset, last.offset),
      wrappedExpected: wrapped ? text.textContent!.slice(first.offset, wrapped.offset) : undefined };
  });
}

export async function nativeSelection(page: Page, paragraph: Locator) {
  return paragraph.evaluate(p => {
    const selection = getSelection()!, editor = p.closest('.tiptap') as any;
    return { anchorInText: selection.anchorNode === p.firstChild, anchor: selection.anchorOffset,
      focusInText: selection.focusNode === p.firstChild, focus: selection.focusOffset, collapsed: selection.isCollapsed,
      text: selection.toString(), active: document.activeElement?.tagName,
      pm: { from: editor.editor.state.selection.from, to: editor.editor.state.selection.to, kind: editor.editor.state.selection.constructor.name },
      sameEditor: editor === (window as any).__nativeSelectionEditor };
  });
}


/** Consume native pointer segments on successive paints; keep the button down for the caller's native-range assertion. */
export async function nativeDragText(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps: number) {
  await page.mouse.move(from.x, from.y); await page.mouse.down({ clickCount: 1 });
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done())));
  }
}
