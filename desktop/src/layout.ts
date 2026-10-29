/** Explicit placement is durable; measurements and collision-chain positions are a disposable read projection. */
export interface LayoutPlacement { unitId: string; x: number; y: number; width: number }
export interface LayoutNode extends LayoutPlacement { height: number }
export type LayoutSizes = Record<string, { width: number; height: number }>;
export const LAYOUT_GAP = 24;
export function projectLayout(baseline: LayoutNode[], sizes: LayoutSizes, fixed?: LayoutPlacement): LayoutNode[] {
  if (!sizes || typeof sizes !== 'object' || Object.keys(sizes).length > baseline.length || Object.entries(sizes).some(([id, size]) =>
    !baseline.some(n => n.unitId === id) || !size || ![size.width, size.height].every(Number.isFinite) || size.width < 1 || size.height < 1 || size.width > 2400 || size.height > 1e7)) throw new Error('阅读尺寸无效');
  if (fixed && (!baseline.some(n => n.unitId === fixed.unitId) || ![fixed.x, fixed.y, fixed.width].every(Number.isFinite) || fixed.width < 1 || fixed.width > 2400)) throw new Error('手势位置无效');
  const nodes = baseline.map(node => ({ ...node, ...sizes[node.unitId], ...(fixed?.unitId === node.unitId ? fixed : {}) }));
  const affected = new Set(Object.keys(sizes));
  if (fixed) affected.add(fixed.unitId);
  // Stable reading order, with the active gesture as the immovable first constraint.
  const order = [...baseline].sort((a, b) => a.y - b.y || a.x - b.x || a.unitId.localeCompare(b.unitId)).map(n => n.unitId);
  if (fixed) { order.splice(order.indexOf(fixed.unitId), 1); order.unshift(fixed.unitId); }
  const rank = new Map(order.map((id, i) => [id, i]));
  const queue = nodes.filter(node => affected.has(node.unitId));
  while (queue.length) {
    const current = queue.shift()!;
    for (const other of nodes) {
      if (current === other) continue;
      const a = rank.get(current.unitId)! < rank.get(other.unitId)! ? current : other;
      const b = a === current ? other : current;
      if (a.x + a.width + LAYOUT_GAP <= b.x || b.x + b.width + LAYOUT_GAP <= a.x ||
          a.y + a.height + LAYOUT_GAP <= b.y || b.y + b.height + LAYOUT_GAP <= a.y) continue;
      b.y = a.y + a.height + LAYOUT_GAP;
      if (!queue.includes(b)) queue.push(b);
    }
  }
  return nodes;
}
