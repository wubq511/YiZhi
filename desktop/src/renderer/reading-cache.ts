import type { CourseUnit } from '../shared';

/** Every demanded body and input owner survives; only the extra cache has a fixed budget. */
export function retainReadingCache(units: CourseUnit[], demand: readonly string[], protectedUnits: readonly string[]) {
  const protectedIds = new Set([...protectedUnits, ...demand]);
  const extra = new Set(units.filter(unit => !protectedIds.has(unit.id)).slice(-2).map(unit => unit.id));
  const next = units.filter(unit => protectedIds.has(unit.id) || extra.has(unit.id));
  return next.length === units.length ? units : next;
}

/** Native selection/focus can belong to a static body, independently of the active editor. */
export function nativeReadingUnits(root: HTMLElement | null): string[] {
  if (!root) return [];
  const ids = new Set<string>(), focused = document.activeElement?.closest<HTMLElement>('article[data-unit-id]');
  if (focused && root.contains(focused)) ids.add(focused.dataset.unitId!);
  for (const article of root.querySelectorAll<HTMLElement>('article[data-unit-id]')) if (nativeRangeIntersects(article)) ids.add(article.dataset.unitId!);
  return [...ids].sort();
}

export function nativeRangeIntersects(element: HTMLElement | null): boolean {
  const selection = getSelection();
  if (element && selection && !selection.isCollapsed) for (let index=0;index<selection.rangeCount;index++)
    if(selection.getRangeAt(index).intersectsNode(element))return true;
  return false;
}
