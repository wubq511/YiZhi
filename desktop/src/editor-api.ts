import type { ReadingBlock } from './shared';

/** A projection delta, never a second permanent editor document. Payloads include unknown fields. */
export interface ContentPatch {
  /** Actual editor Undo/Redo targets, scoped to the final payload of this patch. */
  restorations?: ReadingBlock[];
  textEdits?: import('./annotation-api').TextEditProof[];
  formulaEdits?: import('./annotation-api').FormulaEditProof[];
  updates: Array<{ blockId: string; before: Record<string, any>; after: Record<string, any> }>;
  /** The active B's sibling identity list. Unchanged objects have no body in this patch. */
  structure?: { parentId: string; before: string[]; after: string[]; inserted: ReadingBlock[] };
  /** Proven editor actions, scoped to this patch's basis. Offsets are Unicode code points. */
  correspondence: Array<{ kind: 'split' | 'merge' | 'move' | 'restore' | 'copy' | 'delete';
    sourceId: string; targetId: string; offset?: number }>;
}
export interface FormulaDraft { blockId: string; latex: string }

export function equal(a: unknown, b: unknown): boolean {
  const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
  return canonical(a) === canonical(b);
}
export function patchTargets(patch?: ContentPatch): string[] {
  return patch ? [...patch.updates.map(u => u.blockId), ...(patch.structure ? [
    ...patch.structure.before.filter(id => !patch.structure!.after.includes(id)),
    ...patch.structure.after.filter(id => !patch.structure!.before.includes(id)),
    `structure:${patch.structure.parentId}`,
  ] : []), ...patch.correspondence.flatMap(c => [c.sourceId, c.targetId])] : [];
}

/** Compose consecutive actual deltas; original before-values remain the optimistic basis. */
export function composePatch(first: ContentPatch | undefined, next: ContentPatch): ContentPatch {
  if (!first) return structuredClone(next);
  const updates = new Map(first.updates.map(u => [u.blockId, structuredClone(u)]));
  for (const u of next.updates) {
    const old = updates.get(u.blockId);
    updates.set(u.blockId, { ...u, before: old?.before ?? u.before });
  }
  const structure = next.structure ? { ...structuredClone(next.structure), before: first.structure?.before ?? next.structure.before,
    inserted: [...(first.structure?.inserted ?? []), ...next.structure.inserted] } : structuredClone(first.structure);
  if (structure) {
    const inserted = new Map(structure.inserted.map(b => [b.id, b]));
    for (const [id, u] of updates) if (inserted.has(id)) { inserted.get(id)!.payload = u.after; updates.delete(id); }
    structure.inserted = [...inserted.values()].filter(b => structure.after.includes(b.id) && !structure.before.includes(b.id));
    for (const id of updates.keys()) if (!structure.after.includes(id)) updates.delete(id);
  }
  return { updates: [...updates.values()].filter(u => !equal(u.before, u.after)),
    ...(structure && !equal(structure.before, structure.after) ? { structure } : {}),
    restorations: [...(first.restorations ?? []).filter(b => !next.updates.some(u => u.blockId === b.id) && (!next.structure || next.structure.after.includes(b.id))), ...(next.restorations ?? [])],
    textEdits: [...(first.textEdits ?? []), ...(next.textEdits ?? [])],
    formulaEdits: [...(first.formulaEdits ?? []), ...(next.formulaEdits ?? [])],
    correspondence: [...first.correspondence, ...next.correspondence] };
}
