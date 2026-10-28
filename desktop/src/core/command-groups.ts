import { changedCouplings } from './consistency-links';
import type { ConsistencyPort } from './command-consistency';
import { applyContentPatch, validatePatch } from './editor-store';
import { patchTargets } from '../editor-api';
import { syncAnnotations } from './annotations';
import { readDrafts, draftScopes, draftReadVersions, draftVersion, transaction, appendEvent, eventCursor, inputKey } from './save-store';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { CourseGraph } from '../shared';
import { recordSemanticImpact } from './review-state';
import { integrateValue } from '../content-integration';
import { equal } from '../editor-api';
import type { EditorProtection, CandidateCheck } from '../command-api';
import type { Attempt, AttemptRequest, CommandObject, CommandRead, GroupCommand, GroupHistory, GroupResult } from '../command-api';

const json = (value: unknown) => JSON.stringify(value);
const parse = (value: unknown) => JSON.parse(String(value));
const digest = ({ sessionId: _transportSession, ...command }: GroupCommand) => createHash('sha256').update(json(command)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** All methods run synchronously in the host-owned Worker on its course connection. */
export class CommandGroups {
  private protections = new Map<string, EditorProtection>();
  constructor(private db: DatabaseSync, private graph: CourseGraph, private fenceOperation: (operationId: string) => void = () => {}, private loadUnit?: (id: string) => CourseUnit | undefined, private consistency?: ConsistencyPort) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cg_objects(id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_bases(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES cg_attempts(id), generation INTEGER NOT NULL, versions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_candidates(id TEXT PRIMARY KEY, digest TEXT NOT NULL, command TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_history(operation_id TEXT PRIMARY KEY REFERENCES cg_candidates(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_resolved(candidate_id TEXT PRIMARY KEY REFERENCES cg_candidates(id), operation_id TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('generation', '1');
      UPDATE cg_attempts SET status='interrupted' WHERE status='running';
    `);
    if (!db.prepare('PRAGMA table_info(cg_bases)').all().some(row => row.name === 'draft_versions'))
      db.exec("ALTER TABLE cg_bases ADD COLUMN draft_versions TEXT NOT NULL DEFAULT '{}'");
    if (!db.prepare('PRAGMA table_info(cg_bases)').all().some(row => row.name === 'read_values'))
      db.exec("ALTER TABLE cg_bases ADD COLUMN read_values TEXT NOT NULL DEFAULT '[]'");
    db.exec("UPDATE cg_bases SET read_values='[]' WHERE attempt_id IN (SELECT id FROM cg_attempts WHERE status<>'running')");
    if (!db.prepare('PRAGMA table_info(cg_bases)').all().some(r => r.name === 'unit_id')) db.exec("ALTER TABLE cg_bases ADD COLUMN unit_id TEXT NOT NULL DEFAULT 'KU-001'");
    if (!db.prepare('PRAGMA table_info(cg_bases)').all().some(r => r.name === 'domain_basis')) db.exec('ALTER TABLE cg_bases ADD COLUMN domain_basis TEXT');
    this.observe();
  }
  protect(input: EditorProtection) {
    if (!validId(input.editorId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
      !Number.isSafeInteger(input.inputSeq) || input.inputSeq < 0 || !['editing', 'selection'].includes(input.mode) ||
      !Array.isArray(input.blockIds) || input.blockIds.length > 1000 || input.blockIds.some(id => !validId(id))) throw new Error('无效的编辑保护范围');
    const old = this.protections.get(input.editorId);
    if (old && input.sequence <= old.sequence) return;
    // Moving the caret must not release the only copy of an unacknowledged input tail.
    if (old?.blockIds.some(id => !input.blockIds.includes(id))) {
      const durable = this.db.prepare('SELECT seq FROM input_progress WHERE session_id=?').get(inputKey(input.sessionId, input.unitId));
      if (input.inputSeq > Number(durable?.seq ?? 0)) throw new Error('最新输入尚未持久保留，不能解除现场保护');
    }
    this.protections.set(input.editorId, structuredClone(input));
  }
  private protectedWrites(ids: string[]) {
    for (const row of this.db.prepare('SELECT payload FROM units').all()) {
    const unit: CourseUnit = parse(row.payload);
    for (const protection of this.protections.values()) {
      if (protection.mode !== 'editing') continue;
      const { direct, ancestors } = draftScopes(unit, { changes: protection.blockIds.map(blockId => ({ blockId, text: '' })) } as any);
      if (ids.some(id => direct.has(id) || ancestors.has(id))) return true;
    }
    }
    return false;
  }
  private transaction<T>(run: () => T): T { return transaction(this.db, run); }
  private generation() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value); }
  private unit(unitId = 'KU-001'): { unit: CourseUnit; revision: number } {
    let row = this.db.prepare('SELECT payload, revision FROM units WHERE id=?').get(unitId);
    if (!row) {
      const unit = this.loadUnit?.(unitId);
      if (!unit || unit.id !== unitId || !this.graph.nodes.some(n => n.id === unitId)) throw new Error('该知识单元正文尚未加入课程副本');
      this.db.prepare('INSERT INTO units VALUES(?,?,1)').run(unitId,json(unit));
      row = this.db.prepare('SELECT payload,revision FROM units WHERE id=?').get(unitId);
    }
    row = row!;
    return { unit: parse(row.payload), revision: Number(row.revision) };
  }
  private put(id: string, kind: string, value: unknown) {
    this.db.prepare(`INSERT INTO cg_objects VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET
      value=excluded.value, version=version+1 WHERE value<>excluded.value`).run(id, kind, json(value));
  }
  /** Called inside every formal unit write transaction, including the student save path. */
  observe(explicitDependencies = new Set<string>()): GroupHistory['changes'] {
    syncAnnotations(this.db);
    const changed = new Set<string>();
    const memberships = new Map<string, string[]>();
    const walk = (blocks: ReadingBlock[], parentId: string) => {
      this.put(`structure:${parentId}`, 'structure', { blockIds: blocks.map(block => block.id) });
      for (const block of blocks) {
        const { children, ...self } = block;
        memberships.set(block.id, []);
        const old = this.db.prepare('SELECT value FROM cg_objects WHERE id=?').get(block.id);
        if (old && String(old.value) !== json(self)) changed.add(block.id);
        this.put(block.id, 'block', self);
        walk(children ?? [], block.id);
      }
    };
    for (const row of this.db.prepare('SELECT payload FROM units').all()) { const unit: CourseUnit = parse(row.payload); walk(unit.reading.blocks, unit.id); }
    for (const row of this.db.prepare("SELECT id,value FROM cg_objects WHERE kind='block'").all()) if (!memberships.has(String(row.id))) {
      this.put(String(row.id), 'block', { id: String(row.id), retired: true });
      if (!parse(row.value).retired) changed.add(String(row.id));
    }
    for (const row of this.db.prepare("SELECT id, value FROM cg_objects WHERE kind IN ('reference', 'dependency')").all()) {
      const relation = parse(row.value);
      for (const id of new Set([relation.sourceBlockId, relation.dependentBlockId, relation.fromBlockId, relation.toBlockId])) {
        if (id) memberships.get(id)?.push(String(row.id));
      }
    }
    for (const [id, relationIds] of memberships) this.put(`relations:${id}`, 'structure', { relationIds: relationIds.sort() });
    const invalidated: GroupHistory['changes'] = [];
    for (const row of this.db.prepare("SELECT * FROM cg_objects WHERE kind='dependency'").all()) {
      const before = parse(row.value);
      if (!explicitDependencies.has(String(row.id)) && changed.has(before.sourceBlockId) && before.status !== 'needs-review') {
        const after = { ...before, status: 'needs-review' };
        this.put(String(row.id), 'dependency', after);
        invalidated.push({ objectId: String(row.id), before, after, beforeVersion: Number(row.version), afterVersion: Number(row.version) + 1 });
      }
    }
    return invalidated;
  }
  private object(id: string): CommandObject {
    const row = this.db.prepare('SELECT * FROM cg_objects WHERE id=?').get(id);
    if (!row) {
      const kind = id.split(':')[0];
      if (kind === 'reference' || kind === 'dependency') return { id, kind, version: 0, value: {} };
      throw new Error(`读取对象不存在：${id}`);
    }
    return { id, kind: String(row.kind) as CommandObject['kind'], version: Number(row.version), value: parse(row.value) };
  }
  startAttempt(request: AttemptRequest): Attempt {
    if (!validId(request.taskId) || (request.resume !== undefined && typeof request.resume !== 'boolean')) throw new Error('无效的任务身份');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT id FROM cg_attempts WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(request.taskId);
      if (previous) {
        const old = this.attempt(String(previous.id));
        if (old.status === 'running' && old.generation === this.generation()) return old;
        if (!request.resume) throw new Error('任务已停止或中断，需要明确继续才能建立新的尝试');
      }
      const attempt: Attempt = { taskId: request.taskId, attemptId: randomUUID(), generation: this.generation(), status: 'running' };
      this.db.prepare('INSERT INTO cg_attempts VALUES (?, ?, ?, ?)').run(attempt.attemptId, attempt.taskId, attempt.generation, attempt.status);
      return attempt;
    });
  }
  read(request: CommandRead) {
    if (!validId(request.attemptId) || !Array.isArray(request.objectIds) || request.objectIds.length < 1 ||
      request.objectIds.length > 100 || request.objectIds.some(id => !validId(id))) throw new Error('无效的读取范围');
    return this.transaction(() => {
      const attempt = this.attempt(request.attemptId);
      if (attempt.status !== 'running' || attempt.generation !== this.generation()) throw new Error('任务尝试已停止或失效，请明确继续并重新读取');
      const { unit } = this.unit(request.unitId);
      this.observe();
      const parents = new Map<string, string>();
      const walk = (blocks: ReadingBlock[], parentId: string) => {
        for (const block of blocks) { parents.set(block.id, parentId); walk(block.children ?? [], block.id); }
      };
      const roots = new Set<string>();
      for (const row of this.db.prepare('SELECT payload FROM units').all()) { const current = parse(row.payload); roots.add(current.id); walk(current.reading.blocks,current.id); }
      const ids = new Set(request.objectIds);
      const relations = this.db.prepare("SELECT id, value FROM cg_objects WHERE kind IN ('reference', 'dependency')").all();
      // A fixed point includes transitive prerequisites and their structure without reading unrelated siblings.
      for (const id of ids) {
        let ancestor = id.startsWith('structure:') ? id.slice('structure:'.length) : id;
        while (parents.has(ancestor)) {
          ids.add(ancestor);
          ids.add(`structure:${ancestor}`);
          ids.add(`relations:${ancestor}`);
          ancestor = parents.get(ancestor)!;
        }
        if (roots.has(ancestor)) ids.add(`structure:${ancestor}`);
        for (const row of relations) {
          const relation = parse(row.value);
          const endpoints = [relation.sourceBlockId, relation.dependentBlockId, relation.fromBlockId, relation.toBlockId].filter(Boolean);
          if (row.id === id || endpoints.includes(id)) {
            ids.add(String(row.id));
            for (const endpoint of endpoints) ids.add(endpoint);
          }
        }
      }
      const objects = [...ids].map(id => this.object(id));
      const basisId = randomUUID(), generation = this.generation();
      this.db.prepare('INSERT INTO cg_bases(id, attempt_id, generation, versions, draft_versions, read_values, unit_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(basisId, request.attemptId, generation, json(objects.map(object => [object.id, object.version])),
          json(draftReadVersions(this.db, ids)), json(objects), unit.id);
      const context = request.context ? this.consistency?.read(request) : undefined;
      if (context) this.db.prepare('UPDATE cg_bases SET domain_basis=? WHERE id=?').run(json({ layout:context.layout, relations: {basisId:context.relations.basisId,generation:context.relations.generation,revision:context.relations.revision}, experiments:context.experiments.map(e=>({blockId:e.blockId,signature:e.signature})) }),basisId);
      return { basisId, generation, objects, ...(context ? { context } : {}) };
    });
  }
  mutationBasis(attemptId: string, basisId: string) {
    const row = this.db.prepare('SELECT * FROM cg_bases WHERE id=? AND attempt_id=?').get(basisId,attemptId);
    if (!row || Number(row.generation) !== this.generation() || !parse(row.read_values).length) throw new Error('修改依据已释放或无效，请重新读取');
    return { unitId: String(row.unit_id), objects: parse(row.read_values) as CommandObject[] };
  }
  commit(command: GroupCommand): GroupResult {
    if (!validId(command.operationId) || !validId(command.attemptId) || !validId(command.basisId) ||
      !Array.isArray(command.changes) || (command.changes.length < 1 && !command.patch && !command.bundle) || command.changes.length > 100 ||
      command.changes.some(change => !record(change) || !validId(change.objectId) || !record(change.value)) ||
      new Set(command.changes.map(change => change.objectId)).size !== command.changes.length || json(command).length > 1_000_000)
      throw new Error('无效或重复的一致修改组写入范围');
    if (command.patch) validatePatch(command.patch);
    const nested = this.db.isTransaction;
    // Legacy SQL-only recheck/resolve composes internally. Aggregate commits own their final COMMIT;
    // they are never an in-transaction hook and must not publish heap before an external commit.
    if(nested && (command.patch || command.bundle || this.db.prepare('SELECT domain_basis FROM cg_bases WHERE id=?').get(command.basisId)?.domain_basis))throw new Error('结构／领域一致组必须作为最外层命令提交，不能嵌套发布实验现场');
    this.fenceOperation(command.operationId);
    let requiresConsistency = false; let publish: (() => void) | undefined; let committed!: GroupResult;
    try { committed = this.transaction(() => {
      this.observe();
      if (this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(command.operationId)) throw new Error('操作身份已用于正文修改');
      const previous = this.db.prepare('SELECT * FROM cg_candidates WHERE id=?').get(command.operationId);
      if (previous) {
        if (previous.digest !== digest(command)) throw new Error('同一操作不能换用不同内容');
        return parse(previous.result);
      }
      const retain = (reason: string): GroupResult => {
        const result: GroupResult = { operationId: command.operationId, attemptId: command.attemptId,
          status: 'retained', changedObjectIds: [], reason };
        this.db.prepare('INSERT INTO cg_candidates VALUES (?, ?, ?, ?)')
          .run(command.operationId, digest(command), json(command), json(result));
        return result;
      };
      const attempt = this.attempt(command.attemptId);
      if (attempt.status !== 'running' || attempt.generation !== this.generation())
        return retain('任务尝试已停止、中断或代际失效；候选已保留，旧回调不能重新取得资格');
      const basis = this.db.prepare('SELECT * FROM cg_bases WHERE id=?').get(command.basisId);
      if (!basis || basis.unit_id !== (command.unitId ?? 'KU-001') || basis.attempt_id !== command.attemptId || Number(basis.generation) !== this.generation())
        return retain('读取凭据或课程代际已失效，请重新读取并整合；旧候选已保留');
      if (this.protectedWrites([...command.changes.map(c => c.objectId), ...patchTargets(command.patch)]))
        return retain('等待当前编辑结束；同处或共同祖先候选已保留');
      const versions = new Map<string, number>(parse(basis.versions));
      for (const [id, version] of versions) {
        if (this.object(id).version !== version) return retain(`读取依据已变化：${id}。请重新读取并整合；旧候选已保留`);
      }
      const draftBasis = parse(basis.draft_versions) as Record<string, number>;
      const draftKeys = new Set([...versions.keys(), ...command.changes.map(change =>
        `draft-under:${change.objectId.startsWith('structure:') ? change.objectId.slice('structure:'.length) : change.objectId}`)]);
      for (const id of draftKeys) if ((draftBasis[id] ?? 0) !== draftVersion(this.db, id))
        return retain(`学生输入依据已变化：${id}。请重新读取并整合；候选已保留`);
      const scope = new Set([...versions.keys(), ...command.changes.map(change => change.objectId)]);
      const writes = new Set([...command.changes.map(change => change.objectId), ...patchTargets(command.patch)]);
      if (command.resolves !== undefined && (!Array.isArray(command.resolves) || command.resolves.length > 30 ||
        new Set(command.resolves).size !== command.resolves.length || command.resolves.some(id => !validId(id)))) throw new Error('待整合候选身份无效');
      for (const candidateId of command.resolves ?? []) {
        const candidate = this.candidates(command.attemptId, 100).find(c => c.command.operationId === candidateId)?.command;
        if (!candidate || candidate.unitId !== command.unitId || candidate.basisId === command.basisId) throw new Error('整合必须使用本任务候选与新的实际读取依据');
        const inserted = new Set(candidate.patch?.structure?.inserted.map(b => b.id) ?? []);
        const needed = [...candidate.changes.map(c => c.objectId), ...patchTargets(candidate.patch)].filter(id => !inserted.has(id));
        if (needed.some(id => !writes.has(id)) ||
          candidate.bundle?.layout?.some(old => !command.bundle?.layout?.some(next => next.unitId === old.unitId)) ||
          candidate.bundle?.relations?.changes.some(old => !command.bundle?.relations?.changes.some(next => next.id === old.id)) ||
          candidate.bundle?.experiments?.some(old => !command.bundle?.experiments?.some(next => next.blockId === old.blockId)))
          throw new Error('必须重新整合完整必要组，不能逐块消耗候选');
      }
      if (readDrafts(this.db).some(draft => {
        const { direct, ancestors } = draftScopes(this.unit(command.unitId).unit, draft.input);
        return [...direct].some(id => scope.has(id)) || [...ancestors].some(id => writes.has(id));
      }))
        return retain('读取或写入范围存在学生草稿，请先整合最新输入；候选已保留');
      if (command.changes.some(change => !versions.has(change.objectId)))
        return retain('写入范围尚未读取，请重新读取后整合；旧候选已保留');
      for (const change of command.changes) {
        const before = this.object(change.objectId);
        if (before.kind === 'block' && (change.value.id !== before.id || change.value.kind !== before.value.kind ||
          !record(change.value.payload) || 'children' in change.value))
          return retain('块身份、类型与子结构必须保留；结构变化需要独立描述，候选已保留');
        if (before.kind === 'structure' && !change.objectId.startsWith('structure:'))
          return retain('关系索引由核心维护，不能直接修改；候选已保留');
        if (before.kind === 'reference' || before.kind === 'dependency') {
          const endpoints = before.kind === 'reference' ? [change.value.fromBlockId, change.value.toBlockId]
            : [change.value.sourceBlockId, change.value.dependentBlockId];
          if (endpoints.some(id => !validId(id) || !versions.has(id) || this.object(id).kind !== 'block'))
            return retain('引用与依赖的必要端点尚未读取，候选已保留');
          if (before.kind === 'dependency' && !['current', 'needs-review'].includes(change.value.status))
            return retain('依赖状态无效，候选已保留');
          if (before.kind === 'dependency' && change.value.status === 'current' &&
            command.changes.some(item => item.objectId === change.value.sourceBlockId) &&
            !command.changes.some(item => item.objectId === change.value.dependentBlockId))
            return retain('来源已改写，需共同更新依赖内容或标为需要核对；候选已保留');
        }
      }
      const { unit, revision } = this.unit(command.unitId);
      const beforeUnit = structuredClone(unit);
      const changes: GroupHistory['changes'] = [];
      for (const change of command.changes) {
        const before = this.object(change.objectId);
        if (json(before.value) === json(change.value)) continue;
        if (before.kind === 'block') {
          const replace = (blocks: ReadingBlock[]) => {
            for (let index = 0; index < blocks.length; index++) {
              const block = blocks[index];
              if (block.id === change.objectId) {
                const next = { ...change.value } as ReadingBlock;
                if (block.children) next.children = block.children;
                blocks[index] = next;
              }
              if (block.children) replace(block.children);
            }
          };
          replace(unit.reading.blocks);
        } else if (before.kind === 'structure') {
          const parentId = change.objectId.slice('structure:'.length);
          const reorder = (blocks: ReadingBlock[]): ReadingBlock[] => {
            const ids: unknown = change.value.blockIds;
            if (!Array.isArray(ids) || ids.length !== blocks.length || new Set(ids).size !== blocks.length ||
              ids.some(id => !blocks.some(block => block.id === id))) throw new Error('结构必须保留现有块身份，不能遗漏或重复');
            return ids.map(id => blocks.find(block => block.id === id)!);
          };
          if (parentId === unit.id) unit.reading.blocks = reorder(unit.reading.blocks);
          else {
            const walk = (blocks: ReadingBlock[]) => {
              for (const block of blocks) {
                if (block.id === parentId) block.children = reorder(block.children ?? []);
                else if (block.children) walk(block.children);
              }
            };
            walk(unit.reading.blocks);
          }
        } else {
          this.put(change.objectId, before.kind, change.value);
        }
        changes.push({ objectId: change.objectId, before: before.version ? before.value : null, after: change.value,
          beforeVersion: before.version, afterVersion: before.version + 1 });
      }
      if (command.patch) {
        const needed = patchTargets(command.patch).filter(id => !command.patch!.structure?.inserted.some(b => b.id === id));
        if (needed.some(id => !versions.has(id))) throw new Error('结构修改的必要对象尚未读取');
        const applied = applyContentPatch(this.db, unit, command.patch);
        const before = new Map(applied.before.map(b => [b.id, b])), after = new Map(applied.after.map(b => [b.id, b]));
        for (const id of new Set([...before.keys(), ...after.keys()])) changes.push({ objectId: id,
          before: before.get(id) ?? null, after: after.get(id) ?? null,
          beforeVersion: versions.get(id) ?? 0, afterVersion: (versions.get(id) ?? 0) + 1 });
        if (applied.structure) changes.push({ objectId: `structure:${unit.id}`, before: { blockIds: applied.structure.before }, after: { blockIds: applied.structure.after },
          beforeVersion: versions.get(`structure:${unit.id}`)!, afterVersion: versions.get(`structure:${unit.id}`)! + 1 });
      }
      let related: GroupResult['related'];
      requiresConsistency = changedCouplings(beforeUnit,unit).size > 0 || !!basis.domain_basis;
      if (command.bundle || requiresConsistency) {
        if (!basis.domain_basis || !this.consistency) throw new Error('必要领域的读取依据缺失');
        const applied = this.consistency.apply(command,beforeUnit,unit,parse(basis.domain_basis));
        changes.push(...applied.changes); related=applied.receipt; publish=applied.publish;
      }
      const nextRevision = revision + (changes.length ? 1 : 0);
      this.db.prepare('UPDATE units SET payload=?, revision=? WHERE id=?').run(json(unit), nextRevision, unit.id);
      if (command.patch) syncAnnotations(this.db, command.patch);
      changes.push(...this.observe(new Set(command.changes.filter(change => change.objectId.startsWith('dependency:')).map(change => change.objectId))));
      const result: GroupResult = { operationId: command.operationId, attemptId: command.attemptId, basisId: command.basisId,
        ...(command.resolves?.length ? { resolvedCandidateIds: command.resolves } : {}),
        status: 'committed', unitId: unit.id, ...(related ? {related} : {}), revision: nextRevision, changedObjectIds: changes.map(change => change.objectId) };
      if (changes.length && command.semanticImpact)
        { const prompt = recordSemanticImpact(this.db, this.graph, command.semanticImpact, unit.id, nextRevision); if (prompt) result.reviewPrompt = prompt; }
      result.cursor = changes.length ? appendEvent(this.db, { type: 'group.committed', operationId: result.operationId,
        revision: nextRevision, changedObjectIds: result.changedObjectIds }) : eventCursor(this.db);
      // Successful request bodies are already represented by changed-object history; keep only dedupe facts here.
      this.db.prepare('INSERT INTO cg_candidates VALUES (?, ?, ?, ?)').run(command.operationId, digest(command), '{}', json(result));
      for (const candidateId of command.resolves ?? []) this.db.prepare('INSERT INTO cg_resolved VALUES (?,?)').run(candidateId, command.operationId);
      if (changes.length) {
        const attempt = this.db.prepare('SELECT task_id FROM cg_attempts WHERE id=?').get(command.attemptId)!;
        const history: GroupHistory = { operationId: command.operationId, attemptId: command.attemptId,
          taskId: String(attempt.task_id), generation: this.generation(), revision: nextRevision,
          committedAt: new Date().toISOString(), changes };
        this.db.prepare('INSERT INTO cg_history VALUES (?, ?)').run(command.operationId, json(history));
      }
      this.consistency?.committed?.(result);
      this.releaseReadValues(command.basisId);
      return result;
    }); } catch (error) {
      if ((!command.patch && !command.bundle && !requiresConsistency) || nested) throw error;
      return this.transaction(() => {
        const old = this.db.prepare('SELECT digest,result FROM cg_candidates WHERE id=?').get(command.operationId);
        if (old) { if (old.digest !== digest(command)) throw error; return parse(old.result); }
        const result: GroupResult = { operationId: command.operationId, attemptId: command.attemptId, status: 'retained', changedObjectIds: [], reason: (error as Error).message };
        this.db.prepare('INSERT INTO cg_candidates VALUES(?,?,?,?)').run(command.operationId, digest(command), json(command), json(result));
        return result;
      });
    }
    if (committed.status === 'committed') publish?.();
    return committed;
  }
  query(operationId: string): GroupResult | null {
    const row = this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(operationId);
    if (!row) return null;
    const result = parse(row.result);
    return result.domain === 'formal-relation' ? null : result;
  }
  private attempt(attemptId: string): Attempt {
    const row = this.db.prepare('SELECT * FROM cg_attempts WHERE id=?').get(attemptId);
    if (!row) throw new Error('任务尝试不存在');
    return { attemptId, taskId: String(row.task_id), generation: Number(row.generation), status: String(row.status) as Attempt['status'] };
  }
  stop(attemptId: string): Attempt {
    return this.transaction(() => {
      const attempt = this.attempt(attemptId);
      this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=?").run(attemptId);
      this.db.prepare("UPDATE cg_bases SET read_values='[]' WHERE attempt_id=?").run(attemptId);
      return { ...attempt, status: 'stopped' };
    });
  }
  history(limit = 50): GroupHistory[] {
    return this.db.prepare('SELECT payload FROM cg_history ORDER BY rowid DESC LIMIT ?').all(Math.min(100, Math.max(1, limit)))
      .map(row => parse(row.payload));
  }
  candidates(attemptId?: string, limit = 50): import('../command-api').RetainedCandidate[] {
    return this.db.prepare(`SELECT command, result FROM cg_candidates
      WHERE json_extract(result, '$.status')='retained' AND COALESCE(json_extract(command,'$.domain'),'')<>'generation'
        AND NOT EXISTS (SELECT 1 FROM cg_resolved WHERE candidate_id=cg_candidates.id)
        AND (? IS NULL OR json_extract(command, '$.attemptId')=?)
      ORDER BY rowid DESC LIMIT ?`).all(attemptId ?? null, attemptId ?? null, Math.min(100, Math.max(1, limit)))
      .map(row => ({ command: parse(row.command), result: parse(row.result) }));
  }
  recheck(sessionId: string, attemptId?: string): CandidateCheck[] {
    return this.candidates(attemptId).reverse().map(({ command }) => this.transaction((): CandidateCheck => {
      const objectIds = [...new Set([...command.changes.map(c => c.objectId), ...patchTargets(command.patch)])], candidateId = command.operationId;
      const result = (status: CandidateCheck['status'], reason: string): CandidateCheck => ({ candidateId, status, reason, objectIds,
        ...(status === 'conflict' ? { parts: command.changes.map(c => ({ objectId: c.objectId, current: this.object(c.objectId).value, incoming: c.value })) } : {}) });
      const attempt = this.attempt(command.attemptId);
      if (attempt.status !== 'running' || attempt.generation !== this.generation()) return result('ineligible', '任务已停止或失效；保留候选供查阅');
      if (this.protectedWrites(objectIds)) return result('waiting', '等待当前编辑结束');
      const row = this.db.prepare('SELECT * FROM cg_bases WHERE id=?').get(command.basisId);
      if (!row || Number(row.generation) !== this.generation()) return result('ineligible', '课程或原读取依据已失效');
      const original: CommandObject[] = parse(row.read_values);
      if (!original.length) return result('needs-reread', '原读取内容不可用，需要生产者重新读取');
      // Every read prerequisite participates, including ancestor, relation membership and ABA versions.
      for (const old of original) if (!objectIds.includes(old.id) && this.object(old.id).version !== old.version)
        return result('needs-reread', `读取依据已变化：${old.id}，需要重新推导该一致组`);
      const scope = new Set(original.map(o => o.id));
      const writes = new Set(objectIds);
      if (readDrafts(this.db).some(d => {
        const s = draftScopes(this.unit(command.unitId).unit, d.input);
        return [...s.direct].some(id => scope.has(id)) || [...s.ancestors].some(id => writes.has(id));
      })) return result('waiting', '最新学生草稿尚待整合');
      if (command.patch || command.bundle) {
        for (const update of command.patch?.updates ?? []) {
          const current = this.object(update.blockId);
          if (!integrateValue(update.before, current.value.payload, update.after).compatible) return {
            candidateId, status: 'conflict', objectIds, reason: '同处内容不兼容；学生输入与整组候选均已保留',
            parts: [{ objectId: update.blockId, current: current.value.payload, incoming: update.after }],
          };
        }
        return result('needs-reread', '结构一致组需要生产者重读后完整整合');
      }
      const changes = [];
      for (const change of command.changes) {
        const before = original.find(o => o.id === change.objectId);
        if (!before) return result('conflict', '候选包含未读取对象');
        const current = this.object(change.objectId);
        // Structural/dependency changes must retain their original exact basis; only text/own fields have a bounded merge.
        const merged = current.kind === 'block' ? integrateValue(before.value, current.value, change.value)
          : { compatible: equal(before.value, current.value), value: change.value };
        if (!merged.compatible) return result('conflict', `同处内容不兼容：${change.objectId}，双方内容均已保留`);
        changes.push({ objectId: change.objectId, value: merged.value });
      }
      const basis = this.read({ sessionId, attemptId: command.attemptId, objectIds: original.map(o => o.id) });
      const operationId = `integrate-${createHash('sha256').update(candidateId).digest('hex')}`;
      const receipt = this.commit({ ...command, sessionId, basisId: basis.basisId, operationId, changes });
      if (receipt.status !== 'committed') return result('waiting', receipt.reason!);
      this.db.prepare('INSERT OR IGNORE INTO cg_resolved VALUES (?, ?)').run(candidateId, operationId);
      this.releaseReadValues(command.basisId);
      return { candidateId, status: 'committed', objectIds, receipt };
    }));
  }
  private releaseReadValues(basisId: string) {
    if (!this.db.prepare(`SELECT 1 FROM cg_candidates c WHERE json_extract(c.command, '$.basisId')=?
      AND json_extract(c.result, '$.status')='retained' AND NOT EXISTS (SELECT 1 FROM cg_resolved r WHERE r.candidate_id=c.id) LIMIT 1`).get(basisId))
      this.db.prepare("UPDATE cg_bases SET read_values='[]' WHERE id=?").run(basisId);
  }
  resolveCandidate(request: { sessionId: string; candidateId: string; basisRevision: number; choice: 'current' | 'incoming' }) {
    if (!['current', 'incoming'].includes(request.choice)) throw new Error('无效的候选冲突选择');
    return this.transaction(() => {
      const resolved = this.db.prepare('SELECT operation_id FROM cg_resolved WHERE candidate_id=?').get(request.candidateId);
      if (resolved) return this.query(String(resolved.operation_id));
      if (this.unit().revision !== request.basisRevision) throw new Error('正文版本已变化，请重新查看冲突部分');
      const candidate = this.candidates(undefined, 100).find(c => c.command.operationId === request.candidateId);
      if (!candidate) throw new Error('待处理候选不存在');
      const { command } = candidate;
      if (request.choice === 'current') {
        this.db.prepare('INSERT INTO cg_resolved VALUES (?, ?)').run(request.candidateId, 'kept-current');
        this.releaseReadValues(command.basisId);
        return null;
      }
      const attempt = this.attempt(command.attemptId);
      if (attempt.status !== 'running' || attempt.generation !== this.generation()) throw new Error('任务已停止或失效，不能采用其候选');
      if (this.protectedWrites([...command.changes.map(c => c.objectId), ...patchTargets(command.patch)])) throw new Error('请先结束该处编辑');
      const row = this.db.prepare('SELECT read_values FROM cg_bases WHERE id=?').get(command.basisId);
      const original: CommandObject[] = row ? parse(row.read_values) : [];
      if (!original.length) throw new Error('读取依据已失效，需要生产者重新读取');
      const writes = new Set(command.changes.map(c => c.objectId));
      for (const old of original) if (!writes.has(old.id) && this.object(old.id).version !== old.version)
        throw new Error('读取前提已变化，不能用冲突选择跳过重新推导');
      const basis = this.read({ sessionId: request.sessionId, attemptId: command.attemptId, objectIds: original.map(o => o.id) });
      const receipt = this.commit({ ...command, sessionId: request.sessionId, basisId: basis.basisId,
        operationId: `resolve-${createHash('sha256').update(request.candidateId).digest('hex')}` });
      if (receipt.status !== 'committed') throw new Error(receipt.reason);
      this.db.prepare('INSERT INTO cg_resolved VALUES (?, ?)').run(request.candidateId, receipt.operationId);
      this.releaseReadValues(command.basisId);
      return receipt;
    });
  }
  dispatch(action: string, payload: any): unknown {
    if (action === 'commands:protect') return this.protect(payload);
    if (action === 'commands:releaseView') { this.protections.clear(); return; }
    if (action === 'commands:recheck') return this.recheck(payload.sessionId, payload.attemptId);
    if (action === 'commands:resolveCandidate') return this.resolveCandidate(payload);
    if (action === 'commands:startAttempt') return this.startAttempt(payload);
    if (action === 'commands:read') return this.read(payload);
    if (action === 'commands:commit') return this.commit(payload);
    if (action === 'commands:stop') return this.stop(payload.attemptId);
    if (action === 'commands:query') return this.query(payload.operationId);
    if (action === 'commands:history') return this.history(payload.limit);
    if (action === 'commands:candidates') return this.candidates(payload.attemptId, payload.limit);
    throw new Error('未知一致修改组命令');
  }
}
