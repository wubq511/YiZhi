import { historyTimestamp } from './history-clock';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ReadingBlock, CourseUnit } from '../shared';
import type { ContentPatch } from '../editor-api';
import { equal } from '../editor-api';
import type { AnnotationSelection, AnchorLocation, PersonalNote, TextEditProof, FormulaEditProof } from '../annotation-api';
import { transaction, appendEvent, readDrafts } from './save-store';
const json = JSON.stringify;
const parse = (v: unknown) => JSON.parse(String(v));
const hash = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');
const version = (b: ReadingBlock) => hash(b);
interface Head { block: ReadingBlock; version: string }
interface Step { before: Head[]; after: Head[]; proof?: ContentPatch }
interface Stored { note: PersonalNote; lineage: AnchorLocation[][] }
function heads(unit: CourseUnit): Head[] {
  const result: Head[] = [];
  const walk = (bs: ReadingBlock[]) => { for (const b of bs) { if (['paragraph', 'formula'].includes(b.kind)) result.push({ block: b, version: version(b) }); walk(b.children ?? []); } };
  walk(unit.reading.blocks); return result;
}
export function initializeAnnotations(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS annotation_heads(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS annotation_versions(block_id TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL, block TEXT NOT NULL, PRIMARY KEY(block_id,version));
    CREATE TABLE IF NOT EXISTS annotation_steps(seq INTEGER PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_notes(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS annotation_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);`);
  if (!db.prepare("PRAGMA table_info(annotation_versions)").all().some(r => r.name === "unit_id")) db.exec("ALTER TABLE annotation_versions ADD COLUMN unit_id TEXT NOT NULL DEFAULT 'KU-001'");
  syncAnnotations(db);
}
function replaceRange(location: AnchorLocation, from: number, to: number, size: number): AnchorLocation {
  if (location.to <= from) return location;
  if (location.from >= to) return { ...location, from: location.from + size - (to - from), to: location.to + size - (to - from) };
  return { ...location, status: 'orphan', reason: '选段已改写，待重新关联' };
}
function textProof(p: TextEditProof) {
  const points = Array.from(p.before);
  return Number.isSafeInteger(p.from) && Number.isSafeInteger(p.to) && p.from >= 0 && p.to >= p.from && p.to <= points.length &&
    points.slice(0, p.from).join('') + p.inserted + points.slice(p.to).join('') === p.after;
}
function formulaProof(p: FormulaEditProof) {
  return p.before.encoding === 'mathlive-model' && p.after.encoding === 'mathlive-model' && Number.isSafeInteger(p.from) &&
    Number.isSafeInteger(p.to) && Number.isSafeInteger(p.inserted) && p.from >= 0 && p.to >= p.from && p.to <= p.before.cells.length && p.inserted >= 0 &&
    p.before.cells.length - (p.to - p.from) + p.inserted === p.after.cells.length &&
    equal(p.before.cells.slice(0, p.from), p.after.cells.slice(0, p.from)) &&
    equal(p.before.cells.slice(p.to), p.after.cells.slice(p.from + p.inserted));
}
function relocate(location: AnchorLocation, step: Step): AnchorLocation[] {
  const old = step.before.find(h => h.block.id === location.blockId && h.version === location.version);
  if (!old) return [location];
  const next = step.after.find(h => h.block.id === location.blockId);
  if (next?.version === location.version) return [location];
  if (location.status === 'orphan') return [location];
  const put = (l: AnchorLocation, h: Head) => ({ ...l, blockId: h.block.id, version: h.version });
  const cps = (h: Head) => Array.from(String(h.block.payload.text));
  for (const c of step.proof?.correspondence ?? []) {
    if (location.field !== 'text' || c.offset === undefined) continue;
    const source = step.before.find(h => h.block.id === c.sourceId), target = step.after.find(h => h.block.id === c.targetId);
    if (c.kind === 'split' && source?.block.id === location.blockId && next && target &&
      cps(source).join('') === cps(next).join('') + cps(target).join('') && c.offset === cps(next).length) {
      const result: AnchorLocation[] = [];
      if (location.from < c.offset) result.push(put({ ...location, to: Math.min(location.to, c.offset), quote: cps(source).slice(location.from, Math.min(location.to, c.offset)).join('') }, next));
      if (location.to > c.offset) result.push(put({ ...location, from: Math.max(0, location.from - c.offset), to: location.to - c.offset,
        quote: cps(source).slice(Math.max(location.from, c.offset), location.to).join('') }, target));
      return result;
    }
    if (c.kind === 'merge' && target) {
      const left = step.before.find(h => h.block.id === c.targetId);
      if (source && left && c.offset === cps(left).length && cps(target).join('') === cps(left).join('') + cps(source).join('')) {
        if (location.blockId === c.sourceId) return [put({ ...location, from: location.from + c.offset, to: location.to + c.offset }, target)];
        if (location.blockId === c.targetId) return [put(location, target)];
      }
    }
  }
  if (next && location.field === 'text') {
    let l = location, text = String(old.block.payload.text);
    for (const p of step.proof?.textEdits ?? []) if (p.blockId === location.blockId && p.before === text && textProof(p)) {
      l = replaceRange(l, p.from, p.to, Array.from(p.inserted).length); text = p.after;
    }
    if (text === next.block.payload.text && l.status === 'attached') return [put(l, next)];
  }
  if (next && location.field === 'latex') {
    let l = location, latex = String(old.block.payload.latex);
    for (const p of step.proof?.formulaEdits ?? []) if (p.blockId === location.blockId && p.before.latex === latex && formulaProof(p) && (!l.model || equal(l.model, p.before))) {
      l = { ...replaceRange(l, p.from, p.to, p.inserted), model: p.after }; latex = p.after.latex;
    }
    if (latex === next.block.payload.latex && l.status === 'attached') return [put(l, next)];
  }
  return [{ ...location, status: 'orphan', reason: next ? '没有可证明的编辑对应，待重新关联' : '原内容已删除，待重新关联' }];
}
/** Coalesced autosave still contains each actual edit proof. Retain intermediate
 * correspondences so inner Undo can return to a proven, not-yet-formalized model. */
function intermediateSteps(step: Step): Step[] {
  const result: Step[] = [];
  for (const old of step.before) {
    const next = step.after.find(h => h.block.id === old.block.id);
    if (!next) continue;
    const field = old.block.kind === 'formula' ? 'latex' : 'text';
    const proofs = field === 'latex' ? step.proof?.formulaEdits ?? [] : step.proof?.textEdits ?? [];
    let head = old; const chain: Step[] = [];
    for (const p of proofs) {
      if (p.blockId !== old.block.id) continue;
      const before = 'inserted' in p && typeof p.inserted === 'number' ? (p as FormulaEditProof).before.latex : (p as TextEditProof).before;
      const after = typeof p.inserted === 'number' ? (p as FormulaEditProof).after.latex : (p as TextEditProof).after;
      if (head.block.payload[field] !== before || !(typeof p.inserted === 'number' ? formulaProof(p as FormulaEditProof) : textProof(p as TextEditProof))) { chain.length = 0; break; }
      const block = { ...head.block, payload: { ...head.block.payload, [field]: after } }, target = { block, version: version(block) };
      chain.push({ before: [head], after: [target], proof: { updates: [], correspondence: [],
        ...(field === 'latex' ? { formulaEdits: [p as FormulaEditProof] } : { textEdits: [p as TextEditProof] }) } });
      head = target;
    }
    if (head.version === next.version) result.push(...chain);
  }
  return result;
}
function advance(stored: Stored, step: Step, all: Head[], intermediate = false) {
  if (!intermediate) for (const phase of intermediateSteps(step)) advance(stored, phase, all, true);
  const previous = stored.note.current.fragments;
  let fragments = previous.flatMap(l => relocate(l, step));
  if (!equal(fragments, previous)) stored.lineage.push(structuredClone(previous));
  if (!intermediate && fragments.some(l => l.status === 'orphan')) {
    const recovered = [...stored.lineage].reverse().find(ls => ls.every(l => l.status === 'attached' && all.some(h => h.block.id === l.blockId && h.version === l.version) &&
      (fragments.some(current => current.status === 'attached' && equal(current, l)) || step.proof?.restorations?.some(b => b.id === l.blockId && version(b) === l.version))));
    if (recovered) fragments = structuredClone(recovered);
  }
  stored.note.current = { ...stored.note.current, status: fragments.every(l => l.status === 'attached') ? 'attached' : 'orphan', fragments };
}
/** Invoked on the SAME SQLite transaction as every formal write, including producer groups. */
export function syncAnnotations(db: DatabaseSync, proof?: ContentPatch) {
  const rows = db.prepare('SELECT id,payload,revision FROM units').all();
  const ownership = new Map<string, { unitId: string; revision: number }>();
  const all = rows.flatMap(row => heads(parse(row.payload)).map(head => {
    ownership.set(head.block.id, { unitId: String(row.id), revision: Number(row.revision) }); return head;
  }));
  const old: Head[] = db.prepare('SELECT value FROM annotation_heads').all().map(r => parse(r.value));
  if (equal(old.map(h => [h.block.id, h.version]).sort(), all.map(h => [h.block.id, h.version]).sort())) return;
  const step: Step = { before: old.filter(h => !all.some(n => n.block.id === h.block.id && n.version === h.version)),
    after: all.filter(h => !old.some(n => n.block.id === h.block.id && n.version === h.version)), proof };
  // Structural proofs need unchanged merge/split partners too, but unchanged bodies aren't duplicated in storage.
  if (proof?.correspondence.length) {
    const ids = new Set(proof.correspondence.flatMap(c => [c.sourceId, c.targetId]));
    step.before = old.filter(h => ids.has(h.block.id) || step.before.includes(h));
    step.after = all.filter(h => ids.has(h.block.id) || step.after.includes(h));
  }
  const insert = db.prepare('INSERT OR IGNORE INTO annotation_versions(block_id,version,revision,block,unit_id) VALUES(?,?,?,?,?)');
  for (const h of all) { const owner = ownership.get(h.block.id)!; insert.run(h.block.id, h.version, owner.revision, json(h.block), owner.unitId); }
  db.prepare('INSERT INTO annotation_steps(value) VALUES(?)').run(json(step));
  for (const r of db.prepare('SELECT * FROM personal_notes').all()) {
    const stored: Stored = parse(r.value); advance(stored, step, all);
    db.prepare('UPDATE personal_notes SET value=? WHERE id=?').run(json(stored), String(r.id));
  }
  db.exec('DELETE FROM annotation_heads');
  for (const h of all) db.prepare('INSERT INTO annotation_heads VALUES(?,?)').run(h.block.id, json(h));
}
export class Annotations {
  constructor(private db: DatabaseSync) { initializeAnnotations(db); }
  fence(action: string, id: string) {
    if (!action.startsWith('annotations:') && this.db.prepare('SELECT 1 FROM annotation_operations WHERE id=?').get(id)) throw new Error('操作身份已用于个人笔记');
    if (action.startsWith('annotations:') && (this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(id) || this.db.prepare('SELECT 1 FROM cg_candidates WHERE id=?').get(id))) throw new Error('操作身份已用于正文');
  }
  private capture(selection: AnnotationSelection): { original: AnnotationSelection; locations: AnchorLocation[] } {
    if (!selection || typeof selection.unitId !== 'string' || !this.db.prepare('SELECT 1 FROM units WHERE id=?').get(selection.unitId) || !Array.isArray(selection.fragments) || !selection.fragments.length || selection.fragments.length > 1000) throw new Error('请先选择文字或公式片段');
    const locations = selection.fragments.map(f => {
      const b = f.block, v = b && version(b);
      if (!b || f.blockId !== b.id || !['text', 'latex'].includes(f.field) || !Number.isSafeInteger(f.formalRevision) ||
        !Number.isSafeInteger(f.from) || !Number.isSafeInteger(f.to) || f.from < 0 || f.to <= f.from || typeof f.quote !== 'string' || !f.quote) throw new Error('无效的批注选区');
      const basis = this.db.prepare('SELECT revision,unit_id FROM annotation_versions WHERE block_id=? AND version=?').get(b.id, v);
      const sameShell = (base: ReadingBlock, field: string) => equal({ ...base, payload: { ...base.payload, [field]: b.payload[field] } }, b);
      const draft = f.source === 'student-draft' && readDrafts(this.db).filter(d => (d.input.unitId ?? 'KU-001') === selection.unitId).some(d =>
        d.input.patch?.structure?.inserted.some(i => equal(i, b)) ||
        d.input.patch?.updates.some(u => u.blockId === b.id && equal(u.after, b.payload) && this.db.prepare('SELECT block FROM annotation_versions WHERE block_id=?').all(b.id).some(r => sameShell(parse(r.block), f.field))) ||
        d.input.changes.some(c => c.blockId === b.id && c.text === b.payload.text && this.db.prepare('SELECT block FROM annotation_versions WHERE block_id=?').all(b.id).some(r => sameShell(parse(r.block), 'text'))) ||
        d.input.formulaDrafts?.some(c => c.blockId === b.id && c.latex === b.payload.latex && this.db.prepare('SELECT block FROM annotation_versions WHERE block_id=?').all(b.id).some(r => sameShell(parse(r.block), 'latex'))));
      if (basis && basis.unit_id !== selection.unitId) throw new Error('选区不属于指定单元');
      if ((!basis || (f.source === 'formal' && Number(basis.revision) > f.formalRevision) || !['formal', 'student-draft'].includes(f.source)) && !draft) throw new Error('选区版本无法核对，请保留选择并重试');
      if (f.field === 'text') {
        if (b.kind !== 'paragraph' || f.projection.encoding !== 'unicode-code-points' || f.projection.version !== 1 ||
          f.projection.text !== b.payload.text || f.to > Array.from(f.projection.text).length || Array.from(f.projection.text).slice(f.from, f.to).join('') !== f.quote) throw new Error('文字选区与显示版本不一致');
      } else if (b.kind !== 'formula' || f.projection.encoding !== 'mathlive-model' || f.projection.version !== 1 ||
        f.projection.latex !== b.payload.latex || !Array.isArray(f.projection.cells) || f.to > f.projection.cells.length ||
        f.projection.cells.some(c => typeof c.latex !== 'string' || !Number.isSafeInteger(c.depth))) throw new Error('公式选区与模型版本不一致');
      return { blockId: b.id, version: v, field: f.field, from: f.from, to: f.to, quote: f.quote,
        ...(f.projection.encoding === 'mathlive-model' ? { model: f.projection } : {}), status: 'attached' as const };
    });
    return { original: structuredClone(selection), locations };
  }
  private createStored(selection: AnnotationSelection): Stored {
        const { original, locations } = this.capture(selection);
        const now = historyTimestamp();
        const stored: Stored = { note: { id: randomUUID(), text: '', version: 1, original, originalVersions: locations.map(l => l.version), current: { unitId: selection.unitId, status: 'attached', fragments: locations }, createdAt: now, updatedAt: now }, lineage: [structuredClone(locations)] };
        const all: Head[] = this.db.prepare('SELECT value FROM annotation_heads').all().map(r => parse(r.value));
        for (const step of this.db.prepare('SELECT value FROM annotation_steps ORDER BY seq').all()) advance(stored, parse(step.value), all);
        // A durable student projection that has not been formalized keeps its own original basis.
        for (const l of stored.note.current.fragments) if (!all.some(h => h.block.id === l.blockId && h.version === l.version)) {
          l.status = 'orphan'; l.reason = '选区来自旧版本或保留草稿，待重新关联';
        }
        stored.note.current.status = stored.note.current.fragments.every(l => l.status === 'attached') ? 'attached' : 'orphan';
        return stored;
  }
  /** Internal composition: caller owns the encompassing formal transaction and receipt. */
  createDrawingRange(selection: AnnotationSelection): PersonalNote {
        const stored = this.createStored(selection);
        stored.note.text = '荧光笔标注';
        this.db.prepare('INSERT INTO personal_notes VALUES(?,?)').run(stored.note.id, json(stored));
        appendEvent(this.db, { type: 'annotation.changed', noteId: stored.note.id });
        return stored.note;
  }
  dispatch(action: string, request: any): any {
    if (action === 'annotations:list') return this.db.prepare('SELECT value FROM personal_notes ORDER BY rowid').all().map(r => parse(r.value).note);
    if (action === 'annotations:query') { const r = this.db.prepare('SELECT result FROM annotation_operations WHERE id=?').get(request.operationId); return r ? parse(r.result) : null; }
    if (!['annotations:create', 'annotations:update', 'annotations:reassociate'].includes(action) || typeof request.operationId !== 'string' || !request.operationId.length || request.operationId.length > 160) throw new Error('无效的笔记操作');
    const { sessionId: _, ...body } = request, digest = hash({ action, ...body });
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT * FROM annotation_operations WHERE id=?').get(request.operationId);
      if (prior) { if (prior.digest !== digest) throw new Error('同一操作不能换用不同笔记内容'); return parse(prior.result); }
      let stored: Stored;
      if (action === 'annotations:create') {
        stored = this.createStored(request.selection);
      } else {
        const row = this.db.prepare('SELECT value FROM personal_notes WHERE id=?').get(request.id);
        if (!row) throw new Error('笔记不存在');
        stored = parse(row.value);
        if (request.expectedVersion !== stored.note.version) throw new Error('笔记已变化，请重新读取后继续');
        stored.note.version++; stored.note.updatedAt = historyTimestamp();
        if (action === 'annotations:reassociate') {
          const captured = this.capture(request.selection);
          const currentHeads: Head[] = this.db.prepare('SELECT value FROM annotation_heads').all().map(r => parse(r.value));
          if (!captured.locations.every(l => currentHeads.some(h => h.block.id === l.blockId && h.version === l.version))) throw new Error('重新关联的内容已变化，请重新选择');
          stored.note.current = { unitId: request.selection.unitId, status: 'attached', fragments: captured.locations }; stored.lineage = [];
        }
      }
      if (action !== 'annotations:reassociate') {
        if (typeof request.text !== 'string' || request.text.length > 100000) throw new Error('笔记内容无效');
        stored.note.text = request.text;
      }
      this.db.prepare('INSERT INTO personal_notes VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(stored.note.id, json(stored));
      appendEvent(this.db, { type: 'annotation.changed', noteId: stored.note.id });
      this.db.prepare('INSERT INTO annotation_operations VALUES(?,?,?)').run(request.operationId, digest, json(stored.note));
      return stored.note;
    });
  }
}
