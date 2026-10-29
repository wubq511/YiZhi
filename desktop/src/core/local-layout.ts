import type { DatabaseSync } from 'node:sqlite';
import type { CourseGraph } from '../shared';
import type { LayoutPlacement } from '../layout';
import { transaction } from './save-store';
export function initializeLayout(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS layout_baseline(unit_id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL); CREATE TABLE IF NOT EXISTS layout_versions(unit_id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
}
export function layoutGraph(db: DatabaseSync, graph: CourseGraph): CourseGraph {
  const saved = new Map(db.prepare('SELECT * FROM layout_baseline').all().map(row => [String(row.unit_id), row]));
  return { ...graph, layout: { ...graph.layout, nodes: graph.layout.nodes.map(node => {
    const row = saved.get(node.unitId);
    return row ? { ...node, x: Number(row.x), y: Number(row.y), width: Number(row.width) } : node;
  }) } };
}
export function saveLayout(db: DatabaseSync, graph: CourseGraph, updates: LayoutPlacement[]) {
  if (!Array.isArray(updates) || updates.length > graph.nodes.length || new Set(updates.map(n => n.unitId)).size !== updates.length)
    throw new Error('布局对象无效');
  for (const node of updates) {
    if (!graph.nodes.some(n => n.id === node.unitId) || ![node.x, node.y, node.width].every(Number.isFinite) ||
        Math.abs(node.x) > 1e7 || Math.abs(node.y) > 1e7 || node.width < 160 || node.width > 2400) throw new Error('布局位置或宽度无效');
  }
  transaction(db, () => {
    const statement = db.prepare('INSERT INTO layout_baseline VALUES(?,?,?,?) ON CONFLICT(unit_id) DO UPDATE SET x=excluded.x,y=excluded.y,width=excluded.width');
    const before = layoutGraph(db, graph).layout.nodes;
    for (const node of updates) {
      const old = before.find(n => n.unitId === node.unitId)!;
      if (old.x === node.x && old.y === node.y && old.width === node.width) continue;
      statement.run(node.unitId, node.x, node.y, node.width);
      db.prepare('INSERT INTO layout_versions VALUES(?,1) ON CONFLICT(unit_id) DO UPDATE SET version=version+1').run(node.unitId);
    }
  });
}
