import { validateRelationCommand, validateRelationGraph } from './relation-validation';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GroupHistory } from '../command-api';
import type { CourseGraph } from '../shared';
import type { RelationBasis, RelationCommand, RelationRead, RelationReceipt, RelationSource } from '../relation-api';
import { transaction, appendEvent } from './save-store';

const parse = (value: unknown) => JSON.parse(String(value));
const json = (value: unknown) => JSON.stringify(value);
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => json(k) + ':' + canonical(value[k])).join(',') + '}' : json(value);
/** Unit teaching facts, distinct from block reference/dependency bookkeeping. Host Worker only. */
export class FormalRelations {
  constructor(private db: DatabaseSync, private seed: CourseGraph, private catalog: { sources: RelationSource[]; retiredUnitIds: string[] }) {
    db.exec(`CREATE TABLE IF NOT EXISTS formal_relations(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS formal_requirement_groups(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS formal_relation_retired(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS formal_relation_bases(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, attempt_id TEXT, generation INTEGER NOT NULL, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('formal-relations-revision', '1');`);
    if (!db.prepare("SELECT 1 FROM metadata WHERE key='formal-relations-seeded'").get()) transaction(db, () => {
      for (const edge of seed.edges) db.prepare('INSERT INTO formal_relations VALUES (?, ?)').run(edge.id, json(edge));
      for (const group of seed.requirementGroups) db.prepare('INSERT INTO formal_requirement_groups VALUES (?, ?)').run(group.id, json(group));
      db.prepare("INSERT INTO metadata VALUES ('formal-relations-seeded', '1')").run();
    });
  }
  private generation() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value); }
  private revision() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='formal-relations-revision'").get()!.value); }
  private eligible(attemptId?: string) {
    if (attemptId === undefined) return;
    if (typeof attemptId !== 'string' || !attemptId.trim() || attemptId.length > 200) throw new Error('任务尝试身份无效');
    const attempt = this.db.prepare('SELECT * FROM cg_attempts WHERE id=?').get(attemptId);
    if (!attempt || attempt.status !== 'running' || Number(attempt.generation) !== this.generation())
      throw new Error('任务尝试已停止或失效，请明确继续并重新读取');
  }
  graph(): CourseGraph {
    const graph = structuredClone(this.seed);
    graph.edges = this.db.prepare('SELECT payload FROM formal_relations ORDER BY id').all().map(row => parse(row.payload));
    graph.requirementGroups = this.db.prepare('SELECT payload FROM formal_requirement_groups ORDER BY id').all().map(row => parse(row.payload));
    graph.conditions = {};
    for (const edge of graph.edges.filter(edge => edge.type === 'requires')) {
      const conditions = graph.conditions[edge.toUnitId] ??= { required: [], groups: [] };
      if (edge.requirementGroupId) { if (!conditions.groups.includes(edge.requirementGroupId)) conditions.groups.push(edge.requirementGroupId); }
      else conditions.required.push(edge.fromUnitId);
    }
    const aggregates = new Map<string, NonNullable<CourseGraph['themeEdges']>[number]>();
    for (const edge of graph.edges) {
      const fromThemeId = graph.nodes.find(n => n.id === edge.fromUnitId)!.themeId;
      const toThemeId = graph.nodes.find(n => n.id === edge.toUnitId)!.themeId;
      if (fromThemeId === toThemeId) continue;
      const key = `${fromThemeId}:${toThemeId}:${edge.type}`;
      const aggregate = aggregates.get(key) ?? { fromThemeId, toThemeId, type: edge.type, relationIds: [], count: 0 };
      aggregate.relationIds.push(edge.id); aggregate.count++; aggregates.set(key, aggregate);
    }
    graph.themeEdges = [...aggregates.values()];
    graph.counts = { units: graph.nodes.length, themes: graph.groups.length, relations: graph.edges.length };
    return graph;
  }
  prerequisites(unitId: string) {
    const graph = this.graph();
    if (!graph.nodes.some(node => node.id === unitId)) throw new Error('前置追溯需要有效且未退休的知识单元');
    const ids = new Set([unitId]), edges = new Map<string, CourseGraph['edges'][number]>();
    for (const target of ids) for (const edge of graph.edges) {
      if (edge.type !== 'requires' || edge.toUnitId !== target) continue;
      edges.set(edge.id, edge); ids.add(edge.fromUnitId);
    }
    return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      conditions: Object.fromEntries(Object.entries(graph.conditions).filter(([id]) => ids.has(id))),
      requirementGroups: graph.requirementGroups.filter(group => ids.has(group.targetUnitId)) };
  }
  read(request: RelationRead): RelationBasis {
    return transaction(this.db, () => {
      this.eligible(request.attemptId);
      const basisId = randomUUID(), generation = this.generation(), revision = this.revision();
      this.db.prepare('INSERT INTO formal_relation_bases VALUES (?, ?, ?, ?, ?)').run(basisId, request.sessionId, request.attemptId ?? null, generation, revision);
      return { basisId, generation, revision, graph: this.graph(), ...structuredClone(this.catalog) };
    });
  }
  query(operationId: string): RelationReceipt | null {
    const row = this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(operationId);
    if (!row) return null;
    const receipt = parse(row.result);
    return receipt.domain === 'formal-relation' && receipt.status === 'committed' ? receipt : null;
  }
  commit(command: RelationCommand): RelationReceipt {
    validateRelationCommand(command);
    const { sessionId: _, ...logical } = command;
    const digest = createHash('sha256').update(canonical(logical)).digest('hex');
    // Bind the identity even for a rejected candidate. Only its digest survives, not another body copy.
    // This registration publishes no fact, history, event, revision or successful receipt.
    transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(command.operationId)) throw new Error('操作身份已用于正文修改');
      const previous = this.db.prepare('SELECT digest FROM cg_candidates WHERE id=?').get(command.operationId);
      if (previous && previous.digest !== digest) throw new Error('同一操作身份不能换用不同内容或依据');
      if (!previous) this.db.prepare('INSERT INTO cg_candidates VALUES (?, ?, ?, ?)').run(command.operationId, digest, '{}',
        json({ domain: 'formal-relation', operationId: command.operationId, status: 'uncommitted' }));
    });
    return transaction(this.db, () => {
      const previous = parse(this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(command.operationId)!.result);
      if (previous.status === 'committed') return previous;
      this.eligible(command.attemptId);
      const basis = this.db.prepare('SELECT * FROM formal_relation_bases WHERE id=?').get(command.basisId);
      if (basis && (basis.attempt_id ?? undefined) !== command.attemptId) throw new Error('正式关系读取与提交的尝试身份不一致');
      if (!basis || basis.session_id !== command.sessionId || Number(basis.generation) !== this.generation() ||
        command.generation !== this.generation() || Number(basis.revision) !== this.revision()) throw new Error('正式关系依据已变化，请重新读取核对；候选仍保留');
      for (const change of [...command.changes, ...(command.groupChanges ?? [])]) {
        if (change.value && this.db.prepare('SELECT 1 FROM formal_relation_retired WHERE id=?').get(change.id)) throw new Error('已退休的关系或路线组身份不能重用');
      }
      const before = this.graph(), after = structuredClone(before);
      for (const [changes, values] of [[command.changes, before.edges], [command.groupChanges ?? [], before.requirementGroups]] as const)
        for (const change of changes) if (change.value === null && !values.some(value => value.id === change.id)) throw new Error('不能移除不存在的关系或路线组身份');
      for (const change of command.changes) {
        after.edges = after.edges.filter(edge => edge.id !== change.id);
        if (change.value) after.edges.push(change.value);
      }
      for (const change of command.groupChanges ?? []) {
        after.requirementGroups = after.requirementGroups.filter(group => group.id !== change.id);
        if (change.value) after.requirementGroups.push(change.value);
      }
      validateRelationGraph(after, this.catalog.sources, this.catalog.retiredUnitIds);
      const changes: GroupHistory['changes'] = [];
      for (const [table, oldValues, newValues] of [
        ['formal_relations', before.edges, after.edges], ['formal_requirement_groups', before.requirementGroups, after.requirementGroups],
      ] as const) {
        const ids = new Set([...oldValues, ...newValues].map(value => value.id));
        for (const id of ids) {
          const oldValue = oldValues.find(value => value.id === id) ?? null, newValue = newValues.find(value => value.id === id) ?? null;
          if (canonical(oldValue) === canonical(newValue)) continue;
          if (newValue) this.db.prepare(`INSERT INTO ${table} VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(id, json(newValue));
          else {
            this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
            this.db.prepare('INSERT INTO formal_relation_retired VALUES (?)').run(id);
          }
          changes.push({ objectId: id, before: oldValue, after: newValue, beforeVersion: this.revision(), afterVersion: this.revision() + 1 });
        }
      }
      if (!changes.length) throw new Error('没有实际的正式关系修改');
      const revision = this.revision() + 1;
      this.db.prepare("UPDATE metadata SET value=? WHERE key='formal-relations-revision'").run(String(revision));
      const receipt: RelationReceipt = { domain: 'formal-relation', operationId: command.operationId, status: 'committed', revision,
        generation: this.generation(), changedObjectIds: changes.map(change => change.objectId), cursor: 0 };
      receipt.cursor = appendEvent(this.db, { type: 'relations.committed', operationId: receipt.operationId, revision,
        changedObjectIds: receipt.changedObjectIds });
      this.db.prepare('UPDATE cg_candidates SET result=? WHERE id=?').run(json(receipt), command.operationId);
      this.db.prepare('INSERT INTO cg_history VALUES (?, ?)').run(command.operationId, json({ operationId: command.operationId,
        domain: 'formal-relation', actor: command.attemptId ? 'agent' : 'student', attemptId: command.attemptId,
        taskId: command.attemptId ? String(this.db.prepare('SELECT task_id FROM cg_attempts WHERE id=?').get(command.attemptId)!.task_id) : undefined,
        generation: this.generation(), revision, committedAt: new Date().toISOString(), changes }));
      return receipt;
    });
  }
}
