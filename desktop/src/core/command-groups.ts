import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { Attempt, AttemptRequest, CommandObject, CommandRead, GroupCommand, GroupHistory, GroupResult } from '../command-api';

const json = (value: unknown) => JSON.stringify(value);
const parse = (value: unknown) => JSON.parse(String(value));
const digest = ({ sessionId: _transportSession, ...command }: GroupCommand) => createHash('sha256').update(json(command)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

/** All methods run synchronously in the host-owned Worker on its course connection. */
export class CommandGroups {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cg_objects(id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_attempts(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_bases(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES cg_attempts(id), generation INTEGER NOT NULL, versions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_candidates(id TEXT PRIMARY KEY, digest TEXT NOT NULL, command TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cg_history(operation_id TEXT PRIMARY KEY REFERENCES cg_candidates(id), payload TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('generation', '1');
      UPDATE cg_attempts SET status='interrupted' WHERE status='running';
    `);
    this.observe();
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = run(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private generation() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value); }
  private unit(): { unit: CourseUnit; revision: number } {
    const row = this.db.prepare("SELECT payload, revision FROM units WHERE id='KU-001'").get()!;
    return { unit: parse(row.payload), revision: Number(row.revision) };
  }
  private put(id: string, kind: string, value: unknown) {
    this.db.prepare(`INSERT INTO cg_objects VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET
      value=excluded.value, version=version+1 WHERE value<>excluded.value`).run(id, kind, json(value));
  }
  /** Called inside every formal unit write transaction, including the student save path. */
  observe(explicitDependencies = new Set<string>()): GroupHistory['changes'] {
    const { unit } = this.unit();
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
    walk(unit.reading.blocks, unit.id);
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
      this.observe();
      const { unit } = this.unit();
      const parents = new Map<string, string>();
      const walk = (blocks: ReadingBlock[], parentId: string) => {
        for (const block of blocks) { parents.set(block.id, parentId); walk(block.children ?? [], block.id); }
      };
      walk(unit.reading.blocks, unit.id);
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
        if (ancestor === unit.id) ids.add(`structure:${unit.id}`);
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
      this.db.prepare('INSERT INTO cg_bases VALUES (?, ?, ?, ?)').run(basisId, request.attemptId, generation,
        json(objects.map(object => [object.id, object.version])));
      return { basisId, generation, objects };
    });
  }
  commit(command: GroupCommand): GroupResult {
    if (!validId(command.operationId) || !validId(command.attemptId) || !validId(command.basisId) ||
      !Array.isArray(command.changes) || command.changes.length < 1 || command.changes.length > 100 ||
      command.changes.some(change => !record(change) || !validId(change.objectId) || !record(change.value)) ||
      new Set(command.changes.map(change => change.objectId)).size !== command.changes.length || json(command).length > 1_000_000)
      throw new Error('无效或重复的一致修改组写入范围');
    return this.transaction(() => {
      this.observe();
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
      if (!basis || basis.attempt_id !== command.attemptId || Number(basis.generation) !== this.generation())
        return retain('读取凭据或课程代际已失效，请重新读取并整合；旧候选已保留');
      const versions = new Map<string, number>(parse(basis.versions));
      for (const [id, version] of versions) {
        if (this.object(id).version !== version) return retain(`读取依据已变化：${id}。请重新读取并整合；旧候选已保留`);
      }
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
      const { unit, revision } = this.unit();
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
      const nextRevision = revision + (changes.length ? 1 : 0);
      this.db.prepare('UPDATE units SET payload=?, revision=? WHERE id=?').run(json(unit), nextRevision, unit.id);
      changes.push(...this.observe(new Set(command.changes.filter(change => change.objectId.startsWith('dependency:')).map(change => change.objectId))));
      const result: GroupResult = { operationId: command.operationId, attemptId: command.attemptId,
        status: 'committed', revision: nextRevision, changedObjectIds: changes.map(change => change.objectId) };
      // Successful request bodies are already represented by changed-object history; keep only dedupe facts here.
      this.db.prepare('INSERT INTO cg_candidates VALUES (?, ?, ?, ?)').run(command.operationId, digest(command), '{}', json(result));
      if (changes.length) {
        const attempt = this.db.prepare('SELECT task_id FROM cg_attempts WHERE id=?').get(command.attemptId)!;
        const history: GroupHistory = { operationId: command.operationId, attemptId: command.attemptId,
          taskId: String(attempt.task_id), generation: this.generation(), revision: nextRevision,
          committedAt: new Date().toISOString(), changes };
        this.db.prepare('INSERT INTO cg_history VALUES (?, ?)').run(command.operationId, json(history));
      }
      return result;
    });
  }
  query(operationId: string): GroupResult | null {
    const row = this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(operationId);
    return row ? parse(row.result) : null;
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
      return { ...attempt, status: 'stopped' };
    });
  }
  history(limit = 50): GroupHistory[] {
    return this.db.prepare('SELECT payload FROM cg_history ORDER BY rowid DESC LIMIT ?').all(Math.min(100, Math.max(1, limit)))
      .map(row => parse(row.payload));
  }
  candidates(attemptId?: string, limit = 50) {
    return this.db.prepare(`SELECT command, result FROM cg_candidates
      WHERE json_extract(result, '$.status')='retained' AND (? IS NULL OR json_extract(command, '$.attemptId')=?)
      ORDER BY rowid DESC LIMIT ?`).all(attemptId ?? null, attemptId ?? null, Math.min(100, Math.max(1, limit)))
      .map(row => ({ command: parse(row.command), result: parse(row.result) }));
  }
  dispatch(action: string, payload: any): unknown {
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
