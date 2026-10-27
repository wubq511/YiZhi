import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseUnit, ReadingBlock } from '../shared';
import { equal, type ContentPatch } from '../editor-api';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function initializeEditorStore(db: DatabaseSync) {
  // Retired identity proofs only; formal body remains exclusively in units.payload.
  db.exec('CREATE TABLE IF NOT EXISTS editor_retired(id TEXT PRIMARY KEY, digest TEXT NOT NULL)');
}
export function validatePatch(patch: ContentPatch) {
  if (!patch || !Array.isArray(patch.updates) || !Array.isArray(patch.correspondence) ||
    patch.updates.some(u => !u || typeof u.blockId !== 'string' || !u.before || !u.after || Array.isArray(u.after)) ||
    (patch.structure && (typeof patch.structure.parentId !== 'string' || !Array.isArray(patch.structure.before) ||
      !Array.isArray(patch.structure.after) || !Array.isArray(patch.structure.inserted))) ||
    patch.correspondence.some(c => !c || !['split', 'merge', 'move', 'restore', 'copy', 'delete'].includes(c.kind) ||
      typeof c.sourceId !== 'string' || typeof c.targetId !== 'string' ||
      (c.offset !== undefined && (!Number.isSafeInteger(c.offset) || c.offset < 0)))) throw new Error('无效的编辑结构补丁');
}
export function applyContentPatch(db: DatabaseSync, unit: CourseUnit, patch: ContentPatch) {
  validatePatch(patch);
  const blocks = unit.reading.blocks;
  const before: ReadingBlock[] = [], after: ReadingBlock[] = [];
  const seen = new Set<string>();
  for (const u of patch.updates) {
    if (seen.has(u.blockId)) throw new Error('同一修改不能重复块身份');
    seen.add(u.blockId);
    const block = blocks.find(b => b.id === u.blockId);
    if (!block || !['paragraph', 'formula'].includes(block.kind) || block.children?.length || !equal(block.payload, u.before))
      throw new Error('编辑块依据已变化或暂不支持编辑，草稿仍保留');
    const field = block.kind === 'paragraph' ? 'text' : 'latex';
    if (typeof u.after[field] !== 'string' || u.after[field].length > 100_000 ||
      !equal({ ...u.before, [field]: u.after[field] }, u.after)) throw new Error('正文编辑必须保留未知载荷');
    if (!equal(u.before, u.after)) {
      before.push(structuredClone(block)); block.payload = structuredClone(u.after); after.push(structuredClone(block));
    }
  }
  if (patch.structure) {
    const s = patch.structure;
    if (s.parentId !== unit.id || !equal(s.before, blocks.map(b => b.id)) || new Set(s.after).size !== s.after.length ||
      s.after.some(id => typeof id !== 'string' || !id.length)) throw new Error('正文共同结构依据已变化或身份重复');
    const allIds = new Set<string>();
    const collect = (items: ReadingBlock[]) => { for (const b of items) { if (allIds.has(b.id)) throw new Error('内容身份重复'); allIds.add(b.id); collect(b.children ?? []); } };
    collect(blocks);
    const inserted = new Map<string, ReadingBlock>();
    for (const block of s.inserted) {
      if (!block || typeof block.id !== 'string' || typeof block.kind !== 'string' || !block.payload || inserted.has(block.id) || s.before.includes(block.id) || !s.after.includes(block.id))
        throw new Error('无效的新内容身份');
      collect([block]);
      const retired = db.prepare('SELECT digest FROM editor_retired WHERE id=?').get(block.id);
      if (retired && retired.digest !== hash(block)) throw new Error('恢复身份必须对应先前退出的原对象');
      inserted.set(block.id, structuredClone(block)); after.push(structuredClone(block));
    }
    for (const block of blocks) if (!s.after.includes(block.id)) {
      before.push(structuredClone(block));
      db.prepare('INSERT OR REPLACE INTO editor_retired VALUES (?, ?)').run(block.id, hash(block));
    }
    const byId = new Map(blocks.map(b => [b.id, b]));
    unit.reading.blocks = s.after.map(id => {
      const block = byId.get(id) ?? inserted.get(id);
      if (!block) throw new Error('结构引用不存在的内容');
      return block;
    });
  }
  return { before, after, structure: patch.structure ? { parentId: patch.structure.parentId,
    before: patch.structure.before, after: patch.structure.after } : undefined, correspondence: patch.correspondence };
}
