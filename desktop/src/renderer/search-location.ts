import type { SearchHit } from '../search-api';
/** Select only an exact displayed text projection. Math is highlighted as a whole expression. */
export function highlightSearch(element: HTMLElement, hit: SearchHit) {
  document.querySelectorAll('[data-search-current]').forEach(el => el.removeAttribute('data-search-current'));
  element.dataset.searchCurrent = 'true';
  if (element.textContent !== hit.text) return;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null, at = 0, from: { node: Node; offset: number } | undefined, to: { node: Node; offset: number } | undefined;
  while ((node = walker.nextNode())) {
    const points = Array.from(node.textContent ?? '');
    if (!from && hit.start >= at && hit.start <= at + points.length) from = { node, offset: points.slice(0, hit.start - at).join('').length };
    if (hit.end >= at && hit.end <= at + points.length) { to = { node, offset: points.slice(0, hit.end - at).join('').length }; break; }
    at += points.length;
  }
  if (from && to) { const range = document.createRange(); range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range); }
}
export const paintFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
/** React may commit after the next animation callback; wait for the actual target, never guess a delay. */
export async function waitForSearchElement(find: () => HTMLElement | null | undefined): Promise<HTMLElement> {
  for (let frame = 0; frame < 60; frame++) { const element = find(); if (element?.isConnected) return element; await paintFrame(); }
  throw new Error('实际阅读位置暂不可用，请重新搜索');
}
