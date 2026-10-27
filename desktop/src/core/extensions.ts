import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishResource, hashFile } from './immutable-resource';
import { transaction, appendEvent } from './save-store';
import { EXTENSION_VERSIONS, PARITY_ORACLES, type ExtensionManifest, type ExtensionView, type ExtensionCommand, type ExtensionVersion, type ExtensionState } from '../extensions-api';

/** Trusted storage/eligibility only. No eval, VM, import or execution of package JavaScript here. */
export class Extensions {
  private live?: ExtensionView;
  constructor(private db: DatabaseSync, private directory: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS extension_packages(version TEXT PRIMARY KEY, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_scene(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS extension_operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }
  private async install(version: ExtensionVersion): Promise<ExtensionManifest> {
    if (!EXTENSION_VERSIONS.includes(version)) throw new Error('仅支持已预构建的奇偶校验扩展');
    const old = this.db.prepare('SELECT manifest FROM extension_packages WHERE version=?').get(version);
    if (old) return JSON.parse(String(old.manifest));
    const folder = join(__dirname, 'extensions', version);
    const m: ExtensionManifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
    for (const r of m.resources) {
      const result = await publishResource(join(this.directory, 'resources'), join(folder, r.path), async () => {}, r.sha256);
      if (result.sha256 !== r.sha256 || result.byteLength !== r.byteLength) throw new Error('扩展资源摘要不符');
    }
    this.db.prepare('INSERT INTO extension_packages VALUES (?,?)').run(version, JSON.stringify(m));
    return m;
  }
  private persist(v: ExtensionView) {
    this.db.prepare('INSERT INTO extension_scene VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(v.id, JSON.stringify(v));
  }
  async open(): Promise<ExtensionView> {
    if (this.live) return this.read();
    const row = this.db.prepare("SELECT payload FROM extension_scene WHERE id='parity-lab'").get();
    let v: ExtensionView;
    if (row) { v = JSON.parse(String(row.payload)); v.generation++; v.instanceId = randomUUID(); v.running = false; v.visible = false; v.gesture = false;
      v.phase = v.pending && v.error ? 'conflict' : v.checked.includes(v.definition.packageVersion) ? 'paused' : 'needs-check'; }
    else v = { id: 'parity-lab', unitId: 'KU-001', blockId: 'extension-parity-lab', instanceId: randomUUID(), generation: 1, revision: 1,
      definition: await this.install('1.0.0'), checked: [], state: { inputs: { A: 0, B: 0, C: 0 }, step: 0, simulationTime: 0, seed: 1, output: 0 },
      inputs: { A:0,B:0,C:0 }, running: false, visible: false, background: false, gesture: false, phase: 'needs-check' };
    this.persist(v); this.live = v; return this.read();
  }
  recoverRenderer() {
    if(!this.live)return;
    const old=this.read(),v=structuredClone(old);
    v.generation++;v.instanceId=randomUUID();v.running=false;v.visible=false;v.gesture=false;
    v.phase=v.pending&&v.error?'conflict':v.checked.includes(v.definition.packageVersion)?'paused':'needs-check';v.revision++;
    transaction(this.db,()=>{this.persist(v);appendEvent(this.db,{type:'extension.changed',instanceId:v.instanceId,definitionVersion:v.definition.packageVersion});});
    this.live=v;
  }
  read(): ExtensionView { if (!this.live) throw new Error('扩展尚未打开'); return structuredClone(this.live); }
  resource({version, path}: {version: ExtensionVersion; path: string}) {
    const row = this.db.prepare('SELECT manifest FROM extension_packages WHERE version=?').get(version);
    const m: ExtensionManifest | undefined = row && JSON.parse(String(row.manifest));
    const r = m?.resources.find(r => r.path === path);
    if (!r) throw new Error('未登记的扩展资源');
    const file = join(this.directory, 'resources', r.sha256), actual = hashFile(file);
    if (actual.sha256 !== r.sha256 || actual.byteLength !== r.byteLength) throw new Error('扩展资源已损坏');
    return { bytes: new Uint8Array(readFileSync(file)), mediaType: r.mediaType };
  }
  private validateInputs(m:ExtensionManifest,inputs:Record<string,number>) {
    if(!inputs || Object.keys(inputs).length!==m.inputs.length || m.inputs.some(n=>![0,1].includes(inputs[n])) || Object.keys(inputs).some(n=>!m.inputs.includes(n))) throw new Error('输入超出声明范围');
  }
  private validateState(m:ExtensionManifest,s:ExtensionState) {
    if(!s || JSON.stringify(s).length>4000) throw new Error('实验快照无效');
    const keys=['inputs','step','simulationTime','seed','output',...(m.stateVersion!=='parity-state-1'?['ones']:[])];
    if(Object.keys(s).length!==keys.length || Object.keys(s).some(k=>!keys.includes(k))) throw new Error('现场包含未声明字段');
    this.validateInputs(m,s.inputs);
    const row=m.inputs.reduce((n,key)=>n*2+s.inputs[key],0);
    if(s.output!==Number(PARITY_ORACLES[m.packageVersion][row]) || !Number.isSafeInteger(s.step) || s.step<0 || s.step>1000000 || s.simulationTime!==s.step*250 || s.seed!==1 ||
      (m.stateVersion!=='parity-state-1' && s.ones!==Object.values(s.inputs).filter(n=>n===1).length)) throw new Error('实验快照未通过学习结果检查');
  }
  fence(action: string, id: unknown) {
    if (typeof id !== 'string') return;
    if (action === 'extensions:act') {
      for (const table of ['operations','cg_candidates','source_operations','source_imports','parse_operations','agent_operations','builtin_experiment_operations'])
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) throw new Error('操作身份已用于其他正式修改');
    } else if (this.db.prepare('SELECT 1 FROM extension_operations WHERE id=?').get(id)) throw new Error('操作身份已用于扩展修改');
  }
  async act(c: ExtensionCommand): Promise<ExtensionView> {
    if (!c || typeof c.operationId !== 'string' || !c.operationId.length || c.operationId.length > 160 || JSON.stringify(c.action).length > 16000) throw new Error('扩展操作无效');
    const old = this.read();
    const digest = createHash('sha256').update(JSON.stringify({instanceId:c.instanceId,generation:c.generation,action:c.action})).digest('hex');
    const receipt = this.db.prepare('SELECT digest,receipt FROM extension_operations WHERE id=?').get(c.operationId);
    if (receipt) { if (receipt.digest !== digest) throw new Error('同一操作不能换用不同内容'); return JSON.parse(String(receipt.receipt)); }
    if (c.instanceId !== old.instanceId || c.generation !== old.generation) throw new Error('扩展实例或运行代际已变化');
    const v = structuredClone(old), a = c.action;
    if (old.phase === 'pause-incomplete' && !['recover','fail'].includes(a.kind)) throw new Error('暂停未完成，请恢复最近确认现场');
    if (a.kind === 'validate') {
      if (![v.definition.packageVersion,v.pending?.packageVersion].includes(a.version) || a.report?.outputs !== PARITY_ORACLES[a.version] || !a.report.lifecycle || !a.report.migration) throw new Error('扩展学习结果或生命周期检查未通过');
      if (!v.checked.includes(a.version)) v.checked.push(a.version);
      if(a.version===v.definition.packageVersion) v.phase = 'paused';
    } else if (a.kind === 'run') {
      if (typeof a.running !== 'boolean' || !v.checked.includes(v.definition.packageVersion)) throw new Error('扩展尚未通过检查');
      v.running = a.running; v.phase = a.running && (v.visible || v.background) ? 'running' : 'pausing';
    } else if (a.kind === 'inputs') {
      this.validateInputs(v.definition,a.inputs); v.inputs=Object.fromEntries(v.definition.inputs.map(n=>[n,a.inputs[n]]));
    } else if (a.kind === 'visibility' || a.kind === 'background') {
      const flag = a.kind === 'visibility' ? a.visible : a.enabled;
      if (typeof flag !== 'boolean') throw new Error('实验运行选择无效');
      if (a.kind === 'visibility') v.visible=flag; else v.background=flag;
      if (v.checked.includes(v.definition.packageVersion)) v.phase=v.running && (v.visible||v.background) ? 'running' : 'pausing';
    } else if (a.kind === 'gesture') {
      if (typeof a.active !== 'boolean') throw new Error('输入状态无效'); v.gesture=a.active;
    } else if (a.kind === 'confirm') {
      if (a.baseRevision !== v.revision || a.definitionVersion !== v.definition.packageVersion) throw new Error('实验现场已变化，旧计算已拒绝');
      if (!v.checked.includes(v.definition.packageVersion)) throw new Error('扩展尚未通过检查');
      this.validateState(v.definition,a.state);
      if (JSON.stringify(a.state.inputs)!==JSON.stringify(v.inputs) || a.state.seed!==v.state.seed) throw new Error('计算与最新输入不符');
      const increment=a.mode==='step'?1:0;
      if (a.mode==='step' && v.phase!=='running') throw new Error('实验已停止发步');
      if (a.state.step!==v.state.step+increment || a.state.simulationTime!==v.state.simulationTime+increment*250) throw new Error('不完整的实验步或模拟时间');
      v.state=structuredClone(a.state);
      if(a.mode==='pause') v.phase='paused';
    } else if (a.kind === 'definition') {
      if(a.version===v.definition.packageVersion) throw new Error('实例已使用该定义');
      v.pending=await this.install(a.version); delete v.error;
    } else if (a.kind === 'upgrade' || a.kind === 'restart') {
      if(a.baseRevision!==v.revision) throw new Error('实验现场已变化，迁移副本已失效');
      if(v.gesture) throw new Error('请等待本次操作结束');
      const target=v.pending;
      if(!target || target.packageVersion!==a.version || !v.checked.includes(a.version)) throw new Error('新定义尚未通过检查');
      if(a.kind==='upgrade') {
        if(!target.migratesFrom.includes(v.definition.stateVersion)) throw new Error('定义与当前现场不兼容');
        this.validateState(target,a.state);
        if(JSON.stringify(a.state.inputs)!==JSON.stringify(v.inputs) || JSON.stringify(v.inputs)!==JSON.stringify(v.state.inputs) ||
          a.state.step!==v.state.step || a.state.simulationTime!==v.state.simulationTime || a.state.seed!==v.state.seed) throw new Error('迁移不能改变最新输入或模拟进度');
        v.state=structuredClone(a.state);
      } else {
        v.inputs=Object.fromEntries(target.inputs.map(n=>[n,0]));
        v.state={inputs:structuredClone(v.inputs),step:0,simulationTime:0,seed:1,output:0,...(target.stateVersion!=='parity-state-1'?{ones:0}:{})};
      }
      v.definition=target; delete v.pending; delete v.error; v.generation++; v.instanceId=randomUUID();
      v.running=false;v.phase='paused';
    } else if (a.kind === 'migrationFailed') {
      if(!v.pending) throw new Error('没有待迁移定义');
      v.running=false;v.phase='conflict';v.error=String(a.error).slice(0,500);
    } else if (a.kind === 'fail') {
      v.running=false; v.phase='pause-incomplete'; v.error=String(a.error).slice(0,500);
    } else if (a.kind === 'recover') {
      v.generation++; v.instanceId=randomUUID(); v.running=false; v.visible=false; v.gesture=false;
      v.phase=v.pending&&v.error?'conflict':v.checked.includes(v.definition.packageVersion)?'paused':'needs-check'; if(!v.pending)delete v.error;
    } else throw new Error('不支持的扩展操作');
    v.revision++;
    transaction(this.db, () => { this.persist(v); appendEvent(this.db, {type:'extension.changed', instanceId:v.instanceId, definitionVersion:v.definition.packageVersion});
      this.db.prepare('INSERT INTO extension_operations VALUES (?,?,?)').run(c.operationId,digest,JSON.stringify(v)); });
    this.live = v; return this.read();
  }
}
