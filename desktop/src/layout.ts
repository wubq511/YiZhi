import type { CourseGraph } from './shared';

/** Explicit placement is durable; measurements and collision-chain positions are a disposable read projection. */
export interface LayoutPlacement { unitId: string; x: number; y: number; width: number }
export interface LayoutNode extends LayoutPlacement { height: number }
export type LayoutSizes = Record<string, { width: number; height: number }>;
export const LAYOUT_GAP = 24;
// Keep the existing collision band for saved layouts. New arrangements reserve
// additional room for a two-line title without moving earlier baselines.
export const THEME_PADDING = 64, THEME_HEADER = 112, THEME_TITLE_SPACE = 200, THEME_TITLE_MAX = 1100;
/** Historical narrow cards are rendered with a readable body width. */
export const readingWidth = (width: number) => width >= 360 ? width : 650;

/** Give legacy short thumbnails usable height without moving saved positions or
 * expanding into the next unit or another theme's reserved heading. */
export function overviewThumbnailPlacements(graph:CourseGraph,placements:LayoutNode[]):LayoutNode[] {
  const theme=new Map(graph.nodes.map(node=>[node.id,node.themeId]));
  return placements.map(node=>{
    let height=Math.max(node.height,320);
    for(const other of placements) {
      if(other===node||other.y<=node.y||node.x>=other.x+other.width||node.x+node.width<=other.x)continue;
      const gap=theme.get(node.unitId)===theme.get(other.unitId)?LAYOUT_GAP:THEME_PADDING+THEME_HEADER+THEME_TITLE_MAX;
      height=Math.min(height,Math.max(node.height,other.y-node.y-gap));
    }
    return height===node.height?node:{...node,height};
  });
}

/** Apply compatibility widths only to the disposable reading projection. */
export function projectReadingLayout(baseline: LayoutNode[], sizes: LayoutSizes, fixed?: LayoutPlacement): LayoutNode[] {
  const compatible = Object.fromEntries(baseline.filter(node => node.width < 360)
    .map(node => [node.unitId, { width: readingWidth(node.width), height: node.height }]));
  return projectLayout(baseline, { ...compatible, ...sizes }, fixed);
}

/** Project each theme locally, then move whole themes only when their displayed bounds intersect. */
export function projectCourseReadingLayout(graph: CourseGraph, sizes: LayoutSizes, fixed?: LayoutPlacement, anchorId?: string): LayoutNode[] {
  type ThemeBounds = { id: string; nodes: LayoutNode[]; x: number; y: number; width: number; height: number };
  const groups = new Map<string, ThemeBounds>();
  const themes = new Map<string, string>();
  for (const group of graph.groups) {
    if (!group.id || groups.has(group.id)) throw new Error('主题身份无效或重复');
    groups.set(group.id, { id: group.id, nodes: [], x: 0, y: 0, width: 0, height: 0 });
  }
  for (const node of graph.nodes) {
    if (!node.id || themes.has(node.id) || !groups.has(node.themeId)) throw new Error('单元身份或主题归属无效');
    themes.set(node.id, node.themeId);
  }
  const baseline = new Map<string, LayoutNode>();
  const validPosition = (node: { x: number; y: number }) => [node.x, node.y].every(Number.isFinite) && Math.abs(node.x) <= 1e9 && Math.abs(node.y) <= 1e9;
  for (const node of graph.layout.nodes) {
    if (!themes.has(node.unitId) || baseline.has(node.unitId) ||
        !validPosition(node) || ![node.width, node.height].every(Number.isFinite) ||
        node.width < 1 || node.width > 2400 || node.height < 1 || node.height > 1e7) throw new Error('已有布局无效');
    baseline.set(node.unitId, node);
    groups.get(themes.get(node.unitId)!)!.nodes.push(node);
  }
  if (baseline.size !== themes.size) throw new Error('单元布局不完整');
  if (!sizes || typeof sizes !== 'object' || Array.isArray(sizes)) throw new Error('阅读尺寸无效');
  const byTheme = new Map<string, LayoutSizes>();
  for (const [id, size] of Object.entries(sizes)) {
    const themeId = themes.get(id);
    if (!themeId || !size || ![size.width, size.height].every(Number.isFinite) || size.width < 1 || size.width > 2400 || size.height < 1 || size.height > 1e7) throw new Error('阅读尺寸无效');
    const local = byTheme.get(themeId) ?? Object.create(null) as LayoutSizes;
    local[id] = size; byTheme.set(themeId, local);
  }
  if (fixed && (!themes.has(fixed.unitId) || !validPosition(fixed) || !Number.isFinite(fixed.width) || fixed.width < 1 || fixed.width > 2400)) throw new Error('手势位置无效');
  if (anchorId !== undefined && !themes.has(anchorId)) throw new Error('阅读锚点无效');
  const fixedTheme = fixed && themes.get(fixed.unitId), anchorTheme = anchorId && themes.get(anchorId);
  // These are the same bounds used by board-layout: 64 horizontal/bottom and 112 above each B.
  const pad = THEME_PADDING, header = THEME_HEADER;
  const savedGroups = new Map(graph.layout.groups.map(group => [group.themeId, group]));
  const empty: ThemeBounds[] = [];
  const occupied: ThemeBounds[] = [];
  for (const group of groups.values()) {
    if (!group.nodes.length) {
      const saved = savedGroups.get(group.id);
      if (saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width > 0 && saved.height > 0) {
        group.x = saved.x; group.y = saved.y - THEME_TITLE_SPACE; group.width = saved.width; group.height = saved.height + THEME_TITLE_SPACE; empty.push(group);
      }
      continue;
    }
    const gesture = fixedTheme === group.id && fixed ? { ...fixed, width: readingWidth(fixed.width) } : undefined;
    group.nodes = projectReadingLayout(group.nodes, byTheme.get(group.id) ?? {}, gesture);
    if (group.nodes.some(node => !validPosition(node))) throw new Error('阅读投影超出支持的坐标范围');
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of group.nodes) {
      left = Math.min(left, node.x); top = Math.min(top, node.y);
      right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
    }
    group.x = left - pad; group.y = top - header - THEME_TITLE_SPACE;
    group.width = right - left + pad * 2; group.height = bottom - top + header + pad + THEME_TITLE_SPACE;
  }
  const intersects = (a: ThemeBounds, b: ThemeBounds) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  // Empty saved themes have no B through which this API could move their anchor.
  for (const group of empty) occupied.push(group);
  const priority = (id: string) => id === fixedTheme ? 0 : id === anchorTheme ? 1 : 2;
  const ordered = [...groups.values()].filter(group => group.nodes.length).sort((a, b) =>
    priority(a.id) - priority(b.id) || a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const group of ordered) {
    // Each displacement passes at least one already settled bottom edge, so the chain is finite.
    while (true) {
      let bottom = -Infinity;
      for (const other of occupied) if (intersects(group, other)) bottom = Math.max(bottom, other.y + other.height);
      if (bottom === -Infinity) break;
      // A fixed gesture and an empty saved theme can be immovable at the same
      // time. Keep both intact; the scene can report any unrouteable relation.
      if (group.id === fixedTheme) break;
      const delta = bottom + LAYOUT_GAP - group.y;
      group.y += delta;
      for (const node of group.nodes) {
        node.y += delta;
        if (!validPosition(node)) throw new Error('阅读投影超出支持的坐标范围');
      }
    }
    occupied.push(group);
  }
  const projected = new Map(ordered.flatMap(group => group.nodes.map(node => [node.unitId, node] as const)));
  return graph.layout.nodes.map(node => projected.get(node.unitId)!);
}

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
