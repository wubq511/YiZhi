import { historyTimestamp } from './history-clock';
import { objectVersions, unitChanges } from './history-objects';
import { syncAnnotations } from './annotations';
import { changedCouplings } from './consistency-links';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { patchTargets } from '../editor-api';
import { initializeEditorStore, validatePatch, applyContentPatch } from './editor-store';
import { integrateValue } from '../content-integration';
import type { DraftInput, DraftReceipt, RecoverableDraft, EditCommand, EditReceipt, EditHistory, SaveReceipt, CourseUnit, ReadingBlock, SaveEventData } from '../shared';

export function initializeSaveStore(db: DatabaseSync) {
  initializeEditorStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS input_progress(
    session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, confirmed_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS draft_versions(object_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts(session_id TEXT PRIMARY KEY, input TEXT NOT NULL, receipt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operation_times(operation_id TEXT PRIMARY KEY REFERENCES operations(id), committed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS save_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS input_resolutions(id TEXT PRIMARY KEY REFERENCES operations(id), digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retired_drafts(session_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,restore_operation_id TEXT NOT NULL)`);
}
export function eventCursor(db: DatabaseSync): number {
  return Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='save_events'").get()?.seq ?? 0);
}
export function readDrafts(db: DatabaseSync): RecoverableDraft[] {
  return db.prepare('SELECT input, receipt FROM drafts WHERE session_id NOT IN(SELECT session_id FROM retired_drafts) ORDER BY rowid').all().map(row => ({
    input: JSON.parse(String(row.input)), receipt: JSON.parse(String(row.receipt)),
  }));
}
function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export const inputKey = (sessionId: string, unitId = 'KU-001') => unitId === 'KU-001' ? sessionId : JSON.stringify([sessionId, unitId]);
const inputUnit = (input: { unitId?: string }) => input.unitId ?? 'KU-001';
export function confirmedInput(db: DatabaseSync, sessionId: string, unitId = 'KU-001'): number {
  return Number(db.prepare('SELECT confirmed_seq FROM input_progress WHERE session_id=?').get(inputKey(sessionId, unitId))?.confirmed_seq ?? 0);
}
function validate(input: DraftInput) {
  if (input?.unitId !== undefined && (typeof input.unitId !== 'string' || !input.unitId.length || input.unitId.length > 200)) throw new Error('输入单元身份无效');
  if (!input || typeof input.sessionId !== 'string' || !Number.isSafeInteger(input.inputSeq) || input.inputSeq < 1 ||
    !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1 || typeof input.complete !== 'boolean' ||
    !Array.isArray(input.changes) || input.changes.length > 1000 ||
    input.changes.some(c => !c || typeof c.blockId !== 'string' || typeof c.text !== 'string' || c.text.length > 100_000) ||
    (input.splits !== undefined && (!Array.isArray(input.splits) || input.splits.length > 1000 ||
      input.splits.some(s => !s || typeof s.blockId !== 'string' || typeof s.newBlockId !== 'string' || !Number.isSafeInteger(s.offset)))) ||
    JSON.stringify(input).length > 2_000_000) throw new Error('无效的输入草稿');
  if (input.patch) validatePatch(input.patch);
  if (input.formulaDrafts && (!Array.isArray(input.formulaDrafts) || input.formulaDrafts.some(f =>
    !f || typeof f.blockId !== 'string' || typeof f.latex !== 'string') || (input.complete && input.formulaDrafts.length)))
    throw new Error('未完成公式只能保留为草稿');
}
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  // Internal synchronous composition shares the caller's transaction; it never commits part of it.
  if (db.isTransaction) return run();
  db.exec('BEGIN IMMEDIATE');
  try { const result = run(); db.exec('COMMIT'); return result; }
  catch (error) {
    // Some SQLite I/O failures already end the transaction; retain the original failure.
    try { db.exec('ROLLBACK'); } catch { /* Already rolled back by SQLite. */ }
    throw error;
  }
}
/** Explicit conflict choice is version checked and consumes only the exact durable draft. */
export function resolveInput(db: DatabaseSync, request: import('../command-api').InputResolution, afterWrite: () => unknown): EditReceipt {
  if (!request || !['student', 'external'].includes(request.choice) || !Array.isArray(request.blockIds) ||
    !request.blockIds.length || request.blockIds.some(id => typeof id !== 'string')) throw new Error('无效的冲突选择');
  return transaction(db, () => {
    const old = db.prepare('SELECT digest FROM input_resolutions WHERE id=?').get(request.operationId);
    if (old) {
      if (old.digest !== digest(request)) throw new Error('同一冲突处理操作不能换用不同选择');
      return queryOperation(db, request.operationId) as EditReceipt;
    }
    const row = db.prepare('SELECT payload, revision FROM units WHERE id=?').get(inputUnit(request));
    if (!row) throw new Error('输入单元尚未读取');
    if (Number(row.revision) !== request.basisRevision) throw new Error('正文版本已变化，请重新查看冲突部分');
    const draft = readDrafts(db).find(d => inputUnit(d.input) === inputUnit(request) && d.input.sessionId === request.draftSessionId && d.input.inputSeq === request.inputSeq);
    if (!draft?.input.patch || draft.input.patch.structure || draft.input.formulaDrafts?.length || !draft.input.complete)
      throw new Error('该草稿需要完成输入或结构整合，不能按文本冲突处理');
    const unit: CourseUnit = JSON.parse(String(row.payload));
    const patch = structuredClone(draft.input.patch);
    for (const u of patch.updates) {
      const block = unit.reading.blocks.find(b => b.id === u.blockId);
      if (!block) throw new Error('冲突对象已移除，请重新读取');
      const merged = integrateValue(u.before, block.payload, u.after);
      if (!merged.compatible) {
        if (!request.blockIds.includes(u.blockId)) throw new Error(`仍需处理冲突：${u.blockId}`);
        const field = block.kind === 'paragraph' ? 'text' : block.kind === 'formula' ? 'latex' : undefined;
        if (!field) throw new Error('当前内容不支持文本冲突选择');
        u.after = request.choice === 'student' ? { ...block.payload, [field]: u.after[field] } : block.payload;
      } else u.after = merged.value;
      u.before = block.payload;
    }
    touchDraft(db, draft.input);
    db.prepare('DELETE FROM drafts WHERE session_id=?').run(inputKey(draft.input.sessionId, draft.input.unitId));
    const seq = Number(db.prepare('SELECT seq FROM input_progress WHERE session_id=?').get(inputKey(request.sessionId, request.unitId))?.seq ?? 0) + 1;
    const receipt = commitEdit(db, { sessionId: request.sessionId, unitId: request.unitId, operationId: request.operationId, inputSeq: seq,
      baseRevision: request.basisRevision, complete: true, changes: [], patch }, afterWrite);
    db.prepare('INSERT INTO input_resolutions VALUES (?, ?)').run(request.operationId, digest(request));
    return receipt;
  });
}
export function appendEvent(db: DatabaseSync, event: SaveEventData): number {
  if (!db.isTransaction) throw new Error('持久事件必须与正式修改或草稿同事务追加');
  const result = db.prepare('INSERT INTO save_events(event) VALUES (?)').run(JSON.stringify(event));
  const cursor = Number(result.lastInsertRowid);
  db.prepare('DELETE FROM save_events WHERE cursor <= ?').run(cursor - 256);
  return cursor;
}
export function saveDraft(db: DatabaseSync, input: DraftInput): DraftReceipt {
  validate(input);
  return transaction(db, () => {
    const hash = digest(input);
    const key = inputKey(input.sessionId, input.unitId);
    const previous = db.prepare('SELECT * FROM input_progress WHERE session_id=?').get(key);
    if (input.inputSeq <= Number(previous?.confirmed_seq ?? 0)) throw new Error('输入序号已过期');
    if (previous) {
      if (input.inputSeq < Number(previous.seq)) throw new Error('输入序号已过期');
      if (input.inputSeq === Number(previous.seq)) {
        if (hash !== previous.digest) throw new Error('同一输入序号不能换用不同内容');
        return JSON.parse(String(previous.receipt));
      }
    }
    const receipt = { sessionId: input.sessionId, ...(input.unitId ? { unitId: input.unitId } : {}), inputSeq: input.inputSeq,
      cursor: appendEvent(db, { type: 'draft.saved', sessionId: input.sessionId, inputSeq: input.inputSeq }) };
    const superseded = readDrafts(db).find(d => inputUnit(d.input) === inputUnit(input) && d.input.sessionId === input.sessionId);
    if (superseded) touchDraft(db, superseded.input);
    if (input.replacesDraft) {
      const old = readDrafts(db).find(d => inputUnit(d.input) === inputUnit(input.replacesDraft!) && d.input.sessionId === input.replacesDraft!.sessionId);
      if (!old || inputUnit(old.input) !== inputUnit(input) || old.input.inputSeq !== input.replacesDraft.inputSeq || old.input.sessionId === input.sessionId)
        throw new Error('恢复草稿已变化，请重新读取');
      touchDraft(db, old.input);
      db.prepare('DELETE FROM drafts WHERE session_id=?').run(inputKey(old.input.sessionId, old.input.unitId));
    }
    db.prepare(`INSERT INTO input_progress VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id)
      DO UPDATE SET seq=excluded.seq, digest=excluded.digest, receipt=excluded.receipt`)
      .run(key, input.inputSeq, hash, JSON.stringify(receipt), Number(previous?.confirmed_seq ?? 0));
    touchDraft(db, input);
    db.prepare('INSERT OR REPLACE INTO drafts VALUES (?, ?, ?)')
      .run(key, JSON.stringify(input), JSON.stringify(receipt));
    return receipt;
  });
}

export function queryOperation(db: DatabaseSync, operationId: string): SaveReceipt | null {
  const row = db.prepare('SELECT receipt FROM operations WHERE id=?').get(operationId);
  return row ? JSON.parse(String(row.receipt)) : null;
}
export function history(db: DatabaseSync): EditHistory[] {
  const decode = (value: unknown) => { try { return JSON.parse(String(value)); } catch { return value; } };
  return db.prepare(`SELECT o.receipt, o.before_text, o.after_text, t.committed_at FROM operations o
    LEFT JOIN operation_times t ON t.operation_id=o.id ORDER BY o.rowid`).all().map(row => ({
    receipt: JSON.parse(String(row.receipt)), before: decode(row.before_text), after: decode(row.after_text),
    committedAt: row.committed_at == null ? null : String(row.committed_at),
  }));
}
/** Text/object targets; callers must also check shared ancestors for structural operations. */
export function draftTargets(input: DraftInput): Set<string> {
  return new Set([...input.changes.map(c => c.blockId), ...(input.splits ?? []).flatMap(s => [s.blockId, s.newBlockId]),
    ...patchTargets(input.patch), ...(input.formulaDrafts ?? []).map(f => f.blockId)]);
}
/** Runs after the formal unit UPDATE and before history/receipt/progress COMMIT.
 * The observer may update block/ancestor/dependency projections on the same connection;
 * a thrown error rolls back every fact. Returned changed-object effects belong in history.
 */
export function commitEdit(db: DatabaseSync, command: EditCommand, afterWrite?: (unitId: string, revision: number, blockIds: string[]) => unknown): EditReceipt {
  validate(command);
  if (typeof command.operationId !== 'string' || !command.operationId.length || command.operationId.length > 160)
    throw new Error('无效的操作身份');
  const hash = digest(command);
  if (db.prepare('SELECT 1 FROM cg_candidates WHERE id=?').get(command.operationId)) throw new Error('操作身份已用于其他正式修改');
  const old = db.prepare('SELECT digest, receipt FROM operations WHERE id=?').get(command.operationId);
  if (old) {
    if (old.digest !== hash) throw new Error('同一操作不能换用不同内容');
    return JSON.parse(String(old.receipt));
  }
  return transaction(db, () => {
    if (!command.complete) throw new Error('输入尚未形成有效正文，草稿仍保留');
    const { operationId: _, ...input } = command;
    const key = inputKey(command.sessionId, command.unitId);
    const progress = db.prepare('SELECT * FROM input_progress WHERE session_id=?').get(key);
    if (command.inputSeq <= Number(progress?.confirmed_seq ?? 0)) throw new Error('输入序号已过期');
    if (progress && command.inputSeq === Number(progress.seq) && progress.digest !== digest(input))
      throw new Error('同一输入序号不能换用不同内容');
    const affected = draftTargets(command);
    // A cancelled editor action/finished draft may have no body diff, but still needs an exact durable input receipt.
    if (!affected.size && !command.patch) throw new Error('没有待提交的修改');
    const drafts = readDrafts(db).filter(d => inputUnit(d.input) === inputUnit(command));
    for (const draft of drafts) {
      if (draft.input.sessionId === command.sessionId && draft.input.inputSeq === command.inputSeq) continue;
      if ([...draftTargets(draft.input)].some(id => affected.has(id))) throw new Error('较新或其他会话草稿仍待整合');
      // Splits share the same block list, even if their text targets differ.
      if ((draft.input.splits?.length || command.splits?.length || draft.input.patch?.structure || command.patch?.structure)) throw new Error('共同结构上的草稿仍待整合');
    }
    const row = db.prepare('SELECT payload, revision FROM units WHERE id=?').get(inputUnit(command));
    if (!row) throw new Error('输入单元尚未读取');
    const unit: CourseUnit = JSON.parse(String(row.payload));
    const beforeUnit = structuredClone(unit), historyVersions = objectVersions(db,unit);
    if (command.baseRevision > Number(row.revision)) throw new Error('正文版本尚不存在，输入仍保留');
    const stale = Number(row.revision) !== command.baseRevision;
    if (stale && (!command.patch || command.changes.length || command.splits?.length)) throw new Error('正文版本已变化，输入仍保留，请重新核对');
    const patch = command.patch && structuredClone(command.patch);
    if (patch) for (const update of patch.updates) {
      const block = unit.reading.blocks.find(b => b.id === update.blockId);
      if (!block) throw new Error('共同结构已变化，学生草稿仍保留');
      const merged = integrateValue(update.before, block.payload, update.after);
      if (!merged.compatible) throw new Error('当前段落的同时修改不兼容，正式内容与学生草稿均已保留。请在正文处理冲突部分。');
      update.before = block.payload; update.after = merged.value;
    }
    const editorEffect = patch ? applyContentPatch(db, unit, patch) : undefined;
    const find = (blocks: ReadingBlock[], id: string, parentId = unit.id): { block: ReadingBlock; siblings: ReadingBlock[]; parentId: string } | undefined => {
      for (const block of blocks) {
        if (block.id === id) return { block, siblings: blocks, parentId };
        const nested = block.children && find(block.children, id, block.id);
        if (nested) return nested;
      }
    };
    // History stores only changed objects, never unchanged child bodies or a whole old unit.
    const valueOf = ({ children: _, ...value }: ReadingBlock) => structuredClone(value);
    const before: ReturnType<typeof valueOf>[] = [];
    const correspondence: (NonNullable<DraftInput['splits']>[number] & { parentId: string })[] = [];
    const seen = new Set<string>();
    for (const change of command.changes) {
      if (seen.has(change.blockId)) throw new Error('同一修改不能重复块身份');
      seen.add(change.blockId);
      const found = find(unit.reading.blocks, change.blockId);
      if (!found || found.block.kind !== 'paragraph') throw new Error('当前内容不能作为普通段落保存');
      before.push(valueOf(found.block));
      found.block.payload.text = change.text;
    }
    const splitSources = new Set<string>();
    for (const split of command.splits ?? []) {
      const found = find(unit.reading.blocks, split.blockId);
      if (!found || found.block.kind !== 'paragraph' || splitSources.has(split.blockId) ||
        !split.newBlockId.length || find(unit.reading.blocks, split.newBlockId)) throw new Error('无效或重复的拆分身份');
      splitSources.add(split.blockId);
      correspondence.push({ ...split, parentId: found.parentId });
      const text = Array.from(String(found.block.payload.text));
      if (split.offset < 0 || split.offset > text.length) throw new Error('拆分位置超出正文范围');
      if (!seen.has(split.blockId)) before.push(valueOf(found.block));
      const next = structuredClone(found.block);
      next.id = split.newBlockId;
      // Children and unknown payload remain on the surviving source; never duplicate hidden objects.
      delete next.children;
      next.payload = { text: text.slice(split.offset).join('') };
      found.block.payload.text = text.slice(0, split.offset).join('');
      found.siblings.splice(found.siblings.indexOf(found.block) + 1, 0, next);
    }
    // Ordinary student editing has no finite proof/source/necessary-relation bundle.
    // Inspect both sides, including newly inserted and retargeted links, before any formal publication.
    if (changedCouplings(beforeUnit, unit).size) throw new Error('关联公式与实验定义必须通过完整一致组共同核验；输入未正式提交，请通过 Agent 共同修改。');
    const receipt: EditReceipt = { operationId: command.operationId, sessionId: command.sessionId,
      basedOnRevision: command.baseRevision, unitId: unit.id,
      inputSeq: command.inputSeq, revision: Number(row.revision) + 1,
      blockId: command.changes[0]?.blockId ?? command.splits?.[0]?.blockId ?? patchTargets(command.patch)[0] ?? unit.id, blockIds: [...affected], cursor: 0 };
    db.prepare('UPDATE units SET payload=?, revision=? WHERE id=?').run(JSON.stringify(unit), receipt.revision, unit.id);
    syncAnnotations(db, patch ?? { updates: [], correspondence: correspondence.map(s => ({ kind: 'split', sourceId: s.blockId, targetId: s.newBlockId, offset: s.offset })) });
    const relatedChanges = afterWrite?.(unit.id, receipt.revision, receipt.blockIds);
    const formalChanges = unitChanges(db,beforeUnit,unit,historyVersions);
    receipt.cursor = appendEvent(db, { type: 'content.committed', receipt: { ...receipt, cursor: eventCursor(db) + 1 } });
    const legacyAffected = new Set([...command.changes.map(c => c.blockId), ...(command.splits ?? []).flatMap(s => [s.blockId, s.newBlockId])]);
    const after = [...legacyAffected].map(id => find(unit.reading.blocks, id)?.block).filter((block): block is ReadingBlock => !!block).map(valueOf);
    db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)')
      .run(command.operationId, hash, JSON.stringify(receipt), unit.id, JSON.stringify(formalChanges.filter(c=>!c.objectId.startsWith('structure:') && c.before).map(c=>c.before)), JSON.stringify({ blocks: formalChanges.filter(c=>!c.objectId.startsWith('structure:') && c.after).map(c=>c.after), splits: correspondence,
        structures:formalChanges.filter(c=>c.objectId.startsWith('structure:')), objectVersions:Object.fromEntries(formalChanges.map(c=>[c.objectId,[c.beforeVersion,c.afterVersion]])),
        ...(editorEffect ? { structure: editorEffect.structure, correspondence: editorEffect.correspondence } : {}), relatedChanges: relatedChanges ?? [] }));
    db.prepare('INSERT INTO operation_times VALUES (?, ?)').run(command.operationId, historyTimestamp());
    if (!progress || command.inputSeq > Number(progress.seq)) {
      db.prepare(`INSERT INTO input_progress VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id)
        DO UPDATE SET seq=excluded.seq, digest=excluded.digest, receipt=excluded.receipt, confirmed_seq=excluded.confirmed_seq`)
        .run(key, command.inputSeq, digest(input), JSON.stringify({ sessionId: command.sessionId, unitId: unit.id,
          inputSeq: command.inputSeq, cursor: receipt.cursor }), command.inputSeq);
    } else db.prepare('UPDATE input_progress SET confirmed_seq=? WHERE session_id=?').run(command.inputSeq, key);
    for (const draft of drafts) if (draft.input.sessionId === command.sessionId && draft.input.inputSeq <= command.inputSeq)
      touchDraft(db, draft.input);
    db.prepare('DELETE FROM drafts WHERE session_id=? AND json_extract(input, \'$.inputSeq\') <= ?')
      .run(key, command.inputSeq);
    return receipt;
  });
}

/** Polling is the bounded notification channel; a slow consumer never grows an in-memory queue. */
export function readEvents(db: DatabaseSync, after: number, limit: number) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
    throw new Error('无效的事件游标或分页');
  const head = eventCursor(db);
  const oldest = Number(db.prepare('SELECT MIN(cursor) AS oldest FROM save_events').get()!.oldest ?? head + 1);
  if (after < oldest - 1 || after > head) return null;
  const events = db.prepare('SELECT cursor, event FROM save_events WHERE cursor>? ORDER BY cursor LIMIT ?')
    .all(after, limit).map(row => ({ ...JSON.parse(String(row.event)), cursor: Number(row.cursor) }));
  const cursor = events.at(-1)?.cursor ?? after;
  return { kind: 'events', events, cursor, hasMore: cursor < head };
}

/** Ordinary sibling text stays independent; splits additionally change their actual sibling list. */
export function draftScopes(unit: CourseUnit, input: DraftInput) {
  if (input.unitId !== undefined && input.unitId !== unit.id) return { direct: new Set<string>(), ancestors: new Set<string>() };
  const parents = new Map<string, string>();
  const walk = (blocks: ReadingBlock[], parentId: string) => {
    for (const block of blocks) { parents.set(block.id, parentId); walk(block.children ?? [], block.id); }
  };
  walk(unit.reading.blocks, unit.id);
  for (const split of input.splits ?? []) parents.set(split.newBlockId, parents.get(split.blockId) ?? unit.id);
  const direct = draftTargets(input), ancestors = new Set<string>();
  for (const id of direct) {
    let parent = parents.get(id);
    while (parent) {
      ancestors.add(parent); ancestors.add(`structure:${parent}`);
      parent = parents.get(parent);
    }
  }
  for (const split of input.splits ?? []) direct.add(`structure:${parents.get(split.blockId) ?? unit.id}`);
  if (input.patch?.structure) { direct.add(`structure:${input.patch.structure.parentId}`); ancestors.add(input.patch.structure.parentId); }
  return { direct, ancestors };
}

/** Monotonic metadata only, not another draft body/history. Consuming or replacing input also advances it. */
function touchDraft(db: DatabaseSync, input: DraftInput) {
  const row = db.prepare('SELECT payload FROM units WHERE id=?').get(inputUnit(input));
  if (!row) throw new Error('输入单元尚未读取');
  const unit = JSON.parse(String(row.payload));
  const { direct, ancestors } = draftScopes(unit, input);
  const keys = new Set([...direct, ...[...ancestors].filter(id => !id.startsWith('structure:')).map(id => `draft-under:${id}`)]);
  for (const id of keys) db.prepare(`INSERT INTO draft_versions VALUES (?, 1) ON CONFLICT(object_id)
    DO UPDATE SET version=version+1`).run(id);
}
export function draftVersion(db: DatabaseSync, id: string): number {
  return Number(db.prepare('SELECT version FROM draft_versions WHERE object_id=?').get(id)?.version ?? 0);
}
export function draftReadVersions(db: DatabaseSync, objectIds: Iterable<string>): Record<string, number> {
  const keys = new Set<string>();
  for (const id of objectIds) {
    keys.add(id);
    keys.add(`draft-under:${id.startsWith('structure:') ? id.slice('structure:'.length) : id}`);
  }
  return Object.fromEntries([...keys].map(id => [id, draftVersion(db, id)]));
}
