import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { ExperimentCommand, ExperimentView, ConfirmedExperimentSnapshot } from '../experiments-api';
import { definitionFrom, evaluate, convertFormula, assignments, inputsFor, validateInputs } from './builtin-model';
import { transaction, appendEvent } from './save-store';

export class BuiltinExperiments {
  private live = new Map<string, ExperimentView>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private db: DatabaseSync, private readUnit: (id: string) => CourseUnit | undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS builtin_experiments(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_experiment_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_definition_history(instance_id TEXT NOT NULL, revision INTEGER NOT NULL, before_value TEXT NOT NULL, after_value TEXT NOT NULL, PRIMARY KEY(instance_id,revision));`);
  }
  open(input: { unitId: string; blockId: string }): ExperimentView {
    const id = `${input.unitId}/${input.blockId}`;
    if (this.live.has(id)) return this.read({ instanceId: id });
    const row = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(id);
    let v: ExperimentView;
    if (row) {
      v = JSON.parse(String(row.payload)); v.generation++; v.visible = false; v.phase = v.definition.check === 'verified' ? 'paused' : 'needs-check';
    } else {
      const find = (blocks: ReadingBlock[]): ReadingBlock | undefined => {
        for (const b of blocks) { if (b.id === input.blockId) return b; const n = find(b.children ?? []); if (n) return n; }
      };
      const unit = this.readUnit(input.unitId), block = unit && find(unit.reading.blocks);
      if (!block || block.kind !== 'interactive') throw new Error('当前单元没有受支持的内置实验');
      const definition = definitionFrom(block.payload);
      v = { instanceId: id, unitId: input.unitId, blockId: input.blockId, generation: 1, version: 1, definition,
        state: { inputs: structuredClone(definition.initialInputs), step: 0, simulationTime: 0, seed: 1 },
        result: evaluate(definition, definition.initialInputs), visible: false, background: false, running: false, phase: 'paused' };
    }
    this.persist(v); this.live.set(id, v); return structuredClone(v);
  }
  fenceOperation(action: string, operationId: unknown) {
    if (typeof operationId !== 'string') return;
    if (action === 'experiments:act') {
      if (['operations', 'cg_candidates', 'source_operations', 'source_imports', 'parse_operations'].some(table =>
        this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(operationId))) throw new Error('操作身份已用于其他正式修改');
    } else if (['save', 'commitEdit', 'commands:commit', 'relations:commit'].includes(action) || action.startsWith('sources:') || action.startsWith('parsing:')) {
      if (this.db.prepare('SELECT 1 FROM builtin_experiment_operations WHERE id=?').get(operationId)) throw new Error('操作身份已用于实验修改');
    }
  }
  read({ instanceId }: { instanceId: string }): ExperimentView {
    const v = this.live.get(instanceId); if (!v) throw new Error('实验实例未初始化'); return structuredClone(v);
  }
  private persist(v: ExperimentView) {
    this.db.prepare('INSERT INTO builtin_experiments VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(v.instanceId, JSON.stringify(v));
  }
  /** Called at message arrival, before unrelated asynchronous course work drains. */
  stopIssuing(command: ExperimentCommand) {
    const v = this.live.get(command?.instanceId);
    if (!v || command.generation !== v.generation || typeof command.operationId !== 'string' ||
      !command.operationId.length || command.operationId.length > 160 || !command.action || JSON.stringify(command.action).length > 24000) return;
    try { this.fenceOperation('experiments:act', command.operationId); } catch { return; }
    // Duplicate/rejected old operations may return their receipt, but cannot stop a new run.
    if (this.db.prepare('SELECT 1 FROM builtin_experiment_operations WHERE id=?').get(command.operationId)) return;
    const a = command.action;
    if (a?.kind === 'pause' || (a?.kind === 'run' && a.running === false) ||
      (a?.kind === 'visibility' && a.visible === false && !v.background) ||
      (a?.kind === 'background' && a.enabled === false && !v.visible)) {
      clearTimeout(this.timers.get(v.instanceId)); this.timers.delete(v.instanceId);
    }
  }
  snapshot({ instanceId }: { instanceId: string }): ConfirmedExperimentSnapshot {
    const row = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(instanceId);
    if (!row) throw new Error('实验尚无确认现场');
    const v: ExperimentView = JSON.parse(String(row.payload));
    return { schemaVersion: 'builtin-state-1', instanceId, definitionRevision: v.definition.revision, state: v.state };
  }
  act(command: ExperimentCommand): ExperimentView {
    if (!command || typeof command.operationId !== 'string' || !command.operationId.length || command.operationId.length > 160) throw new Error('实验操作身份无效');
    const old = this.live.get(command.instanceId);
    if (!old || command.generation !== old.generation) throw new Error('实验运行代际已变化，旧消息已拒绝');
    const encoded = JSON.stringify({ instanceId: command.instanceId, generation: command.generation, action: command.action });
    if (encoded.length > 24000) throw new Error('实验输入超出范围');
    const hash = createHash('sha256').update(encoded).digest('hex');
    const receipt = this.db.prepare('SELECT digest,receipt FROM builtin_experiment_operations WHERE id=?').get(command.operationId);
    if (receipt) { if (receipt.digest !== hash) throw new Error('同一操作不能换用不同内容'); return JSON.parse(String(receipt.receipt)); }
    const v = structuredClone(old), a = command.action;
    if (a.kind === 'recover') {
      const row = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(v.instanceId)!;
      Object.assign(v, JSON.parse(String(row.payload))); v.generation = old.generation + 1; v.running = false; v.visible = false; delete v.error;
    } else if (a.kind === 'inputs') { validateInputs(v.definition, a.inputs); v.state.inputs = structuredClone(a.inputs); }
    else if (a.kind === 'formula') {
      if (typeof a.formula !== 'string' || a.formula.length > 8000 || a.baseRevision !== v.definition.revision) throw new Error('实验公式版本已变化，请重新核对');
      v.definition = convertFormula(v.definition, a.formula); if (v.definition.check === 'needs-check') v.running = false;
    } else if (a.kind === 'run') { if (typeof a.running !== 'boolean' || (a.running && v.definition.check !== 'verified')) throw new Error('公式需要核对，不能继续计算'); v.running = a.running; }
    else if (a.kind === 'background') { if (typeof a.enabled !== 'boolean') throw new Error('后台选择无效'); v.background = a.enabled; }
    else if (a.kind === 'visibility') { if (typeof a.visible !== 'boolean') throw new Error('可见状态无效'); v.visible = a.visible; }
    else if (a.kind === 'pause') { v.running = false; }
    else throw new Error('不支持的实验操作');
    if (old.phase === 'pause-incomplete' && a.kind !== 'recover') throw new Error('暂停未完成，请从最近确认现场恢复');
    v.result = v.definition.check === 'verified' ? evaluate(v.definition, v.state.inputs) : null;
    v.phase = v.definition.check !== 'verified' ? 'needs-check' : v.running && (v.visible || v.background) ? 'running' : 'paused';
    v.version++;
    // Each bounded step executes synchronously in this Worker. A queued pause therefore runs
    // only after the preceding step's FULL SQLite confirmation; no unacknowledged step can leak past it.
    const stopping = v.phase !== 'running' && old.phase === 'running';
    if (stopping) { clearTimeout(this.timers.get(v.instanceId)); this.timers.delete(v.instanceId); }
    try { transaction(this.db, () => {
      this.persist(v);
      if (a.kind === 'formula') {
        this.db.prepare('INSERT INTO builtin_definition_history VALUES (?,?,?,?)').run(v.instanceId, v.definition.revision, JSON.stringify(old.definition), JSON.stringify(v.definition));
        appendEvent(this.db, { type: 'experiment.changed', instanceId: v.instanceId, definitionRevision: v.definition.revision });
      }
      this.db.prepare('INSERT INTO builtin_experiment_operations VALUES (?,?,?)').run(command.operationId, hash, JSON.stringify(v));
    }); } catch (error) {
      if (stopping) this.live.set(v.instanceId, { ...old, running: false, phase: 'pause-incomplete', error: String(error) });
      throw error;
    }
    this.live.set(v.instanceId, v); this.schedule(v); return structuredClone(v);
  }
  private schedule(v: ExperimentView) {
    clearTimeout(this.timers.get(v.instanceId)); this.timers.delete(v.instanceId);
    if (v.phase !== 'running') return;
    this.timers.set(v.instanceId, setTimeout(() => {
      this.timers.delete(v.instanceId);
      const old = this.live.get(v.instanceId)!;
      if (old.phase !== 'running') return;
      const next = structuredClone(old);
      const rows = assignments(inputsFor(next.definition));
      next.state.step++; next.state.simulationTime += 250;
      next.state.inputs = rows[next.state.step % rows.length]; next.result = evaluate(next.definition, next.state.inputs); next.version++;
      try { this.persist(next); this.live.set(v.instanceId, next); this.schedule(next); }
      catch (error) { this.live.set(v.instanceId, { ...old, running: false, phase: 'pause-incomplete', error: String(error) }); }
    }, 250));
  }
  pauseAll(): ExperimentView[] {
    // Stop issuance for ALL instances before any individual confirmation can fail.
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const result: ExperimentView[] = [];
    let failure: Error | undefined;
    for (const [id, old] of this.live) {
      if (old.phase === 'pause-incomplete') { failure ??= new Error('实验暂停未完成，请恢复最近确认现场'); continue; }
      const v = { ...structuredClone(old), visible: false, phase: old.definition.check === 'verified' ? 'paused' as const : 'needs-check' as const };
      try { this.persist(v); this.live.set(id, v); result.push(structuredClone(v)); }
      catch (error) {
        this.live.set(id, { ...old, running: false, phase: 'pause-incomplete', error: String(error) });
        failure ??= error as Error;
      }
    }
    if (failure) throw failure;
    return result;
  }
  dispose() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
