import { unitBlocks,linkedExperiment } from './consistency-links';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { BuiltinDefinition, ExperimentCommand, ExperimentView, ConfirmedExperimentSnapshot } from '../experiments-api';
import { definitionFrom, evaluate, convertFormula, assignments, inputsFor, validateInputs } from './builtin-model';
import { equal } from '../editor-api';
import { transaction, appendEvent } from './save-store';

export class BuiltinExperiments {
  private live = new Map<string, ExperimentView>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private db: DatabaseSync, private readUnit: (id: string) => CourseUnit | undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS builtin_experiments(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_formal_definitions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_experiment_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS builtin_definition_history(instance_id TEXT NOT NULL, revision INTEGER NOT NULL, before_value TEXT NOT NULL, after_value TEXT NOT NULL, PRIMARY KEY(instance_id,revision));`);
  }
  open(input: { unitId: string; blockId: string }): ExperimentView {
    const id = `${input.unitId}/${input.blockId}`;
    if (this.live.has(id)) return this.read({ instanceId: id });
    const row = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(id);
    let v: ExperimentView;
    if (row) {
      v = JSON.parse(String(row.payload)); v.gesture=false; v.generation++; v.visible = false; v.phase = v.definition.check === 'verified' ? 'paused' : 'needs-check';
    } else {
      const find = (blocks: ReadingBlock[]): ReadingBlock | undefined => {
        for (const b of blocks) { if (b.id === input.blockId) return b; const n = find(b.children ?? []); if (n) return n; }
      };
      const unit = this.readUnit(input.unitId), block = unit && find(unit.reading.blocks);
      if (!block || block.kind !== 'interactive') throw new Error('当前单元没有受支持的内置实验');
      const definition = this.formalDefinition(input.unitId,input.blockId);
      v = { instanceId: id, unitId: input.unitId, blockId: input.blockId, generation: 1, version: 1, definition,
        state: { inputs: structuredClone(definition.initialInputs), step: 0, simulationTime: 0, seed: 1 },
        result: evaluate(definition, definition.initialInputs), visible: false, background: false, running: false, phase: 'paused' };
    }
    this.persist(v); this.live.set(id, v); return this.project(v);
  }
  formalDefinition(unitId: string, blockId: string): BuiltinDefinition {
    const id = `${unitId}/${blockId}`, row = this.db.prepare('SELECT payload FROM builtin_formal_definitions WHERE id=?').get(id);
    if (row) return JSON.parse(String(row.payload));
    const runtime = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(id);
    if (runtime) return JSON.parse(String(runtime.payload)).definition;
    const block = unitBlocks(this.readUnit(unitId)).find(b => b.id === blockId);
    if (!block) throw new Error('实验定义不存在'); return definitionFrom(block.payload);
  }
  prepareDefinition(unitId: string, block: ReadingBlock, formula: string) {
    const before = this.formalDefinition(unitId,block.id), body = definitionFrom(block.payload), definition = convertFormula(body, formula);
    if (definition.check !== 'verified' || !equal(definition.config,block.payload.config) || definition.outputName!==body.outputName) throw new Error('公式不能转换为所提交的完整实验配置');
    definition.revision = before.revision + 1;
    return { definition, apply: () => {
      if (!this.db.isTransaction) throw new Error('实验定义必须在必要组事务内应用');
      const id = `${unitId}/${block.id}`;
      this.db.prepare('INSERT INTO builtin_formal_definitions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(definition));
      this.db.prepare('INSERT INTO builtin_definition_history VALUES(?,?,?,?)').run(id,definition.revision,JSON.stringify(before),JSON.stringify(definition));
      const row = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(id);
      let pending: ExperimentView | undefined;
      if (row) { pending = JSON.parse(String(row.payload)); pending!.pendingDefinition=definition; pending!.version++; delete pending!.migrationError; this.persist(pending!); }
      appendEvent(this.db,{ type:'experiment.changed',instanceId:id,definitionRevision:definition.revision });
      // No heap/timer mutation before the enclosing necessary group really commits.
      return () => { if (pending && this.live.has(id)) this.live.set(id,pending); };
    } };
  }
  /** Historical values are already stored facts. Restore their definition, never a runtime snapshot. */
  restoreDefinition(unitId:string, block:ReadingBlock, historical:BuiltinDefinition) {
    if(!this.db.isTransaction)throw new Error('历史实验恢复必须在共同事务内');
    const before=this.formalDefinition(unitId,block.id), body=definitionFrom(block.payload);
    if(!equal([historical.kind,historical.config,historical.initialInputs,historical.outputName],
      [body.kind,body.config,body.initialInputs,body.outputName]))throw new Error('历史实验定义与正文配置不一致');
    const definition={...structuredClone(historical),revision:before.revision+1};
    const id=`${unitId}/${block.id}`;
    this.db.prepare('INSERT INTO builtin_formal_definitions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(definition));
    this.db.prepare('INSERT INTO builtin_definition_history VALUES(?,?,?,?)').run(id,definition.revision,JSON.stringify(before),JSON.stringify(definition));
    const row=this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(id);
    let pending:ExperimentView|undefined;
    if(row) {pending=JSON.parse(String(row.payload));pending!.pendingDefinition=definition;pending!.version++;delete pending!.migrationError;this.persist(pending!);}
    appendEvent(this.db,{type:'experiment.changed',instanceId:id,definitionRevision:definition.revision});
    return {definition,publish:()=>{if(pending&&this.live.has(id))this.live.set(id,pending);}};
  }
  fenceOperation(action: string, operationId: unknown) {
    if (typeof operationId !== 'string') return;
    if (action === 'experiments:act') {
      if (['operations', 'cg_candidates', 'source_operations', 'source_imports', 'parse_operations', 'agent_operations'].some(table =>
        this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(operationId))) throw new Error('操作身份已用于其他正式修改');
    } else if (['save', 'commitEdit', 'commands:commit', 'relations:commit'].includes(action) || action.startsWith('sources:') || action.startsWith('parsing:') || action.startsWith('agent:')) {
      if (this.db.prepare('SELECT 1 FROM builtin_experiment_operations WHERE id=?').get(operationId)) throw new Error('操作身份已用于实验修改');
    }
  }
  read({ instanceId }: { instanceId: string }): ExperimentView {
    const v = this.live.get(instanceId); if (!v) throw new Error('实验实例未初始化'); return this.project(v);
  }
  private project(v:ExperimentView):ExperimentView {
    return {...structuredClone(v),formulaScope:unitBlocks(this.readUnit(v.unitId)).some(b=>linkedExperiment(b)===v.blockId)?'consistency-group':'independent'};
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
    if (receipt) { if (receipt.digest !== hash) throw new Error('同一操作不能换用不同内容'); return this.project(JSON.parse(String(receipt.receipt))); }
    const v = structuredClone(old), a = command.action;
    if (a.kind === 'recover') {
      const row = this.db.prepare('SELECT payload FROM builtin_experiments WHERE id=?').get(v.instanceId)!;
      Object.assign(v, JSON.parse(String(row.payload))); v.generation = old.generation + 1; v.running = false; v.visible = false; delete v.error;
    } else if (a.kind === 'inputs') { validateInputs(v.definition, a.inputs); v.state.inputs = structuredClone(a.inputs); }
    else if (a.kind === 'gesture') { if (typeof a.active !== 'boolean') throw new Error('实验手势状态无效'); v.gesture=a.active; }
    else if (a.kind === 'migrate' || a.kind === 'restart') {
      if (a.baseVersion !== v.version) throw new Error('实验现场已变化，迁移副本失效');
      if (v.gesture) throw new Error('等待当前实验操作结束');
      const next = v.pendingDefinition; if (!next) throw new Error('没有待迁移定义');
      const compatible = equal(Object.keys(v.state.inputs).sort(),Object.keys(next.initialInputs).sort()) && next.kind === v.definition.kind;
      if (!compatible && a.kind !== 'restart') { v.migrationError='新定义输入与当前现场不兼容；已保留旧版和现场，请选择是否重新开始。'; }
      else {
        if (a.kind === 'restart') v.state={ inputs: structuredClone(next.initialInputs),step:0,simulationTime:0,seed:1 };
        else validateInputs(next,v.state.inputs);
        v.definition=next; delete v.pendingDefinition; delete v.migrationError; v.generation++; v.running=false;
      }
    }
    else if (a.kind === 'formula') {
      if(unitBlocks(this.readUnit(v.unitId)).some(b=>linkedExperiment(b)===v.blockId))throw new Error('当前实验有关联正文公式，修改必须通过完整一致组共同校验保存');
      if (v.pendingDefinition) throw new Error('请先完成待升级定义的现场迁移');
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
        this.db.prepare('INSERT INTO builtin_formal_definitions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(v.instanceId,JSON.stringify(v.definition));
        this.db.prepare('INSERT INTO builtin_definition_history VALUES (?,?,?,?)').run(v.instanceId, v.definition.revision, JSON.stringify(old.definition), JSON.stringify(v.definition));
        appendEvent(this.db, { type: 'experiment.changed', instanceId: v.instanceId, definitionRevision: v.definition.revision });
      }
      this.db.prepare('INSERT INTO builtin_experiment_operations VALUES (?,?,?)').run(command.operationId, hash, JSON.stringify(v));
    }); } catch (error) {
      if (stopping) this.live.set(v.instanceId, { ...old, running: false, phase: 'pause-incomplete', error: String(error) });
      throw error;
    }
    this.live.set(v.instanceId, v); this.schedule(v); return this.project(v);
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
  fenceGeneration() {
    if(!this.db.isTransaction)throw new Error('运行代际切换必须与课程恢复共同提交');
    for(const row of this.db.prepare('SELECT payload FROM builtin_experiments').all()) {
      const v:ExperimentView=JSON.parse(String(row.payload));v.generation++;v.version++;v.running=false;v.visible=false;v.gesture=false;
      v.phase=v.definition.check==='verified'?'paused':'needs-check';this.persist(v);
    }
    return ()=>{this.dispose();this.live.clear();};
  }
}
