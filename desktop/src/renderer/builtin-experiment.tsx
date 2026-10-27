import { useEffect, useRef, useState } from 'react';
import { MathfieldElement } from 'mathlive';
import type { DesktopBridge, ReadingBlock } from '../shared';
import type { ExperimentAction, ExperimentView } from '../experiments-api';
import './builtin-experiment.css';

MathfieldElement.fontsDirectory = './mathlive-fonts';
MathfieldElement.soundsDirectory = null;

type Job = { operationId: string; action: (view: ExperimentView) => ExperimentAction };
/** Retained across reading mounts, never across host sessions. Persistence belongs to CourseService. */
class ExperimentClient {
  view?: ExperimentView;
  error?: string;
  private jobs: Job[] = [];
  private work?: Promise<boolean>;
  private listeners = new Set<() => void>();
  private ready: Promise<void>;
  constructor(private bridge: DesktopBridge, readonly sessionId: string, unitId: string, blockId: string) {
    this.ready = bridge.experiments.open({ sessionId, unitId, blockId }).then(v => { this.view = v; this.emit(); }).catch(error => { this.error = String(error); this.emit(); });
  }
  get pending() { return this.jobs.length > 0; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const fn of this.listeners) fn(); }
  send(action: ExperimentAction | Job['action']) {
    this.jobs.push({ operationId: crypto.randomUUID(), action: typeof action === 'function' ? action : () => action }); this.emit();
    if (!this.error) void this.flush();
  }
  async poll() {
    await this.ready;
    if (!this.view || this.pending || this.error) return;
    try {
      const v = await this.bridge.experiments.read({ sessionId: this.sessionId, instanceId: this.view.instanceId });
      if (!this.pending && (!this.view || v.version >= this.view.version)) { this.view = v; this.emit(); if(v.pendingDefinition && !v.gesture && !v.migrationError && !this.pending) this.send({kind:'migrate',baseVersion:v.version}); }
    } catch (error) { this.error = String(error); this.emit(); }
  }
  async flush(): Promise<boolean> {
    if (this.work) return this.work;
    const running = async () => {
      await this.ready; if (!this.view || this.error) return false;
      while (this.jobs.length) {
        const job = this.jobs[0];
        // Freeze the exact operation before crossing IPC; response loss retries the identical request.
        const command = { sessionId: this.sessionId, instanceId: this.view.instanceId, generation: this.view.generation,
          operationId: job.operationId, action: job.action(this.view) };
        job.action = () => command.action;
        try {
          this.view = await this.bridge.experiments.act(command); this.jobs.shift(); this.emit();
        } catch (error) {
          if (command.action.kind === 'migrate' && /现场已变化|等待当前/.test(String(error))) {
            this.jobs.shift(); this.view = await this.bridge.experiments.read({sessionId:this.sessionId,instanceId:command.instanceId}); this.emit(); continue;
          }
          this.error = String(error);
          try { this.view = await this.bridge.experiments.read({ sessionId: this.sessionId, instanceId: command.instanceId }); } catch { /* Retain the last confirmed view on transport loss. */ }
          this.emit(); return false;
        }
      }
      return true;
    };
    this.work = running().finally(() => { this.work = undefined; }); return this.work;
  }
  async retry() { this.error = undefined; this.emit(); return this.flush(); }
  async recover() {
    await this.ready;
    if (!this.view) return;
    try {
      this.view = await this.bridge.experiments.act({ sessionId: this.sessionId, instanceId: this.view.instanceId,
        generation: this.view.generation, operationId: crypto.randomUUID(), action: { kind: 'recover' } });
      // The student explicitly chose the confirmed state, so unconfirmed failed commands are abandoned.
      this.jobs = []; this.error = undefined; this.emit();
    } catch (error) { this.error = String(error); this.emit(); }
  }
}
const clients = new Map<string, ExperimentClient>();
function clientFor(bridge: DesktopBridge, sessionId: string, unitId: string, blockId: string) {
  const key = `${sessionId}/${unitId}/${blockId}`;
  let client = clients.get(key);
  if (!client) { client = new ExperimentClient(bridge, sessionId, unitId, blockId); clients.set(key, client); }
  return client;
}
/** Close barrier includes all retained clients, including experiments that left the DOM. */
export async function flushBuiltinExperiments(bridge: DesktopBridge, sessionId: string): Promise<boolean> {
  const owned = [...clients.values()].filter(c => c.sessionId === sessionId);
  const results = await Promise.all(owned.map(c => c.flush()));
  if (results.some(ok => !ok)) return false;
  try { await bridge.experiments.pauseAll({ sessionId }); return true; } catch { await Promise.all(owned.map(c => c.poll())); return false; }
}

function FormulaEditor({ initial, changed, done, composition }: { initial: string; changed: (latex: string) => void; done: () => void; composition?: (active: boolean) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = new MathfieldElement(); field.mathVirtualKeyboardPolicy = 'manual';
    field.setAttribute('aria-label', '实验公式内容'); field.value = initial.replace(/¬/g, '\\neg ').replace(/·/g, '\\cdot ');
    const input = () => changed(field.getValue('latex'));
    field.addEventListener('input', input);
    const composing = () => composition?.(true), composed = () => composition?.(false);
    field.addEventListener('compositionstart', composing); field.addEventListener('compositionend', composed);
    field.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation(); field.executeCommand(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo'); input();
      }
    }, true);
    host.current!.append(field); field.focus();
    return () => { field.removeEventListener('input', input); field.removeEventListener('compositionstart', composing); field.removeEventListener('compositionend', composed); composition?.(false); field.remove(); };
  }, []);
  return <div className="builtin-formula-editor"><div ref={host} /><button onClick={done}>完成公式编辑</button></div>;
}
function Diagram({ v }: { v: ExperimentView }) {
  const d = v.definition, r = v.result;
  if (!r) return null;
  if (d.kind === 'kmap') return <div className="builtin-kmap"><table aria-label="固定卡诺图 A / BC"><thead><tr><th>A / BC</th>{d.config.columnOrder.map((c: string) => <th key={c}>{c}</th>)}</tr></thead><tbody>{d.config.cells.map((row: number[], i: number) => <tr key={i}><th>{i}</th>{row.map((value, j) => <td key={j} data-highlighted={r.highlighted?.includes(i * 4 + j) ? 'true' : 'false'}>{value}</td>)}</tr>)}</tbody></table><p role="status" aria-label="卡诺图结论">{v.state.inputs.showCorners ? '四格跨边相邻，A、B 变化，C 恒为 0，所以 F = ¬C。' : '显示圈组，观察首末列的跨边相邻。'}</p></div>;
  const data: string[] = d.kind === 'mux' ? d.config.dataSignals : Array.from({ length: 8 }, (_, i) => `Y${i}`);
  return <svg className="builtin-diagram" viewBox={`0 0 520 ${data.length * 38 + 55}`} role="img" aria-label={d.kind === 'mux' ? 'MUX 数据通路' : '74LS138 输出通路'}>
    <path d={`M 210 14 L 335 40 L 335 ${data.length * 38 - 6} L 210 ${data.length * 38 + 20} Z`} fill="#f0f5fc" stroke="#7798bc" strokeWidth="2" />
    <text x="266" y={data.length * 19 + 16} textAnchor="middle">{d.kind === 'mux' ? 'MUX' : '74LS138'}</text>
    {data.map((n, i) => { const active = i === r.selected && (d.kind === 'mux' || r.enabled); const y = 38 * i + 32; return <g key={i} className={active ? 'active-path' : ''}>
      <path d={d.kind === 'mux' ? `M 135 ${y} H 210` : `M 335 ${y} H 390`} fill="none" strokeWidth={active ? 4 : 2} />
      <text x={d.kind === 'mux' ? 125 : 400} y={y + 6} textAnchor={d.kind === 'mux' ? 'end' : 'start'}>{d.kind === 'mux' ? `I${i} ← ${n}` : `${n} = ${r.outputs![i]}`}</text></g>; })}
    {d.kind === 'mux' && <><path d={`M 335 ${data.length * 19 + 10} H 400`} stroke="#286b58" strokeWidth="4" /><text x="415" y={data.length * 19 + 16}>{d.outputName} = {r.output}</text></>}
    <text x="265" y={data.length * 38 + 47} textAnchor="middle">{(d.kind === 'mux' ? d.config.selectBits : d.config.addressBits).map((n: string) => `${n}=${v.state.inputs[n]}`).join(' · ')}</text>
  </svg>;
}
export function BuiltinExperiment({ block, unitId, sessionId, active, disabled, composition }: { block: ReadingBlock; unitId: string; sessionId: string; active: boolean; disabled: boolean; composition?: (active: boolean) => void }) {
  const client = clientFor(window.yizhi, sessionId, unitId, block.id);
  const [, paint] = useState(0);
  const host = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const [formula, setFormula] = useState<string>();
  const [localInputs, setLocalInputs] = useState<Record<string, number>>();
  useEffect(() => client.subscribe(() => { paint(n => n + 1); if (!client.pending && !client.error) setLocalInputs(undefined); }), [client]);
  useEffect(() => {
    const timer = setInterval(() => void client.poll(), 150); void client.poll();
    return () => clearInterval(timer);
  }, [client]);
  useEffect(() => {
    let inView = false, last: boolean | undefined;
    const update = () => { const visible = active && inView && !document.hidden; if (visible !== last) { last = visible; client.send({ kind: 'visibility', visible }); } };
    const observer = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; update(); }, { root: host.current?.closest('main.board') });
    if (host.current) observer.observe(host.current);
    document.addEventListener('visibilitychange', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); client.send({ kind: 'visibility', visible: false }); };
  }, [client, active, client.view?.generation]);
  const gesture = useRef(false);
  const beginGesture=()=>{if(!gesture.current){gesture.current=true;client.send({kind:'gesture',active:true});}};
  const endGesture=()=>{if(gesture.current){gesture.current=false;client.send({kind:'gesture',active:false});}};
  useEffect(()=>{window.addEventListener('pointerup',endGesture);window.addEventListener('pointercancel',endGesture);window.addEventListener('blur',endGesture);return()=>{window.removeEventListener('pointerup',endGesture);window.removeEventListener('pointercancel',endGesture);window.removeEventListener('blur',endGesture);endGesture();};},[client]);
  const v = client.view;
  const title = block.payload.title ?? (block.payload.component === 'kmap' ? '固定卡诺图 · 跨边四格' : '交互 · 多路选择');
  return <section ref={host} inert={disabled} className="builtin-experiment nodrag nopan" role="region" aria-label={title} onPointerDownCapture={beginGesture} onKeyDownCapture={e=>{if(e.key!=='Tab')beginGesture();}} onKeyUpCapture={endGesture} onCompositionStartCapture={beginGesture} onCompositionEndCapture={endGesture}>
    <h3 data-search-field="title">{title}</h3>

    {!v ? <p role="status">{client.error ?? '正在恢复实验现场…'}</p> : <>
      {v.pendingDefinition && <div role="status" aria-label="实验定义迁移"><p>正式定义 {v.pendingDefinition.revision} 已保存；当前现场仍采用定义 {v.definition.revision}。{v.gesture ? '本次操作结束后迁移。' : v.migrationError ?? '正在接续兼容现场。'}</p>{v.migrationError && <button onClick={()=>client.send({kind:'restart',baseVersion:v.version})}>按新定义重新开始</button>}</div>}
      <p className="builtin-scope">{v.definition.kind === 'mux' ? '仅演示通道选择；不模拟器件使能端。' : v.definition.kind === 'decoder' ? '74LS138 式：使能满足时，仅选中输出为低电平。' : '固定 A / BC 示例，列按格雷顺序排列；不改变函数或自动化简。'}</p>
      <fieldset disabled={v.phase === 'pause-incomplete'}><legend>实验输入</legend>{Object.entries(localInputs ?? v.state.inputs).map(([n, value]) => <label key={n}><input type="checkbox" aria-label={n === 'showCorners' ? '显示跨边四格' : n} checked={!!value} onChange={event => {
        const next = { ...(localInputs ?? v.state.inputs), [n]: Number(event.target.checked) }; setLocalInputs(next); client.send({ kind: 'inputs', inputs: next });
      }} />{n === 'showCorners' ? '显示跨边四格' : `${n} = ${value}`}</label>)}</fieldset>
      <div className="builtin-formula"><span>本实验公式</span>{editing ? <FormulaEditor composition={composition} initial={formula ?? v.definition.formula} changed={latex => { setFormula(latex); client.send(current => ({ kind: 'formula', formula: latex, baseRevision: current.definition.revision })); }} done={() => setEditing(false)} /> : <><p role="math" aria-label="本实验公式">{v.definition.formula}</p><button onClick={() => { setFormula(v.definition.formula); setEditing(true); }}>编辑实验公式</button></>}</div>
      <p className="builtin-grammar">{v.definition.kind === 'mux' ? '可转换：0、1、声明变量及非／与／或；每一路须能化为常量或单个输入（含取反）。' : v.definition.kind === 'decoder' ? '可转换：Y0–Y7 的八个布尔等式（分号分隔），须与当前 74LS138 定义等价。' : '可转换：与 ¬C 等价的三变量布尔式。'}</p>
      {v.definition.check === 'needs-check' ? <p className="builtin-error" role="status">公式需要核对；当前不显示计算结果。</p> : <><Diagram v={v} />{v.definition.kind === 'mux' && <p className="builtin-result" role="status" aria-label="MUX 输出">输出 {v.definition.outputName} = {v.result?.output}</p>}{v.definition.kind === 'decoder' && <p className="builtin-result" role="status" aria-label="译码器输出">{v.result?.enabled ? `选中 Y${v.result.selected}` : '未使能'} · Y0–Y7 = {v.result?.outputs?.join('')}</p>}</>}
      <div className="builtin-runtime"><button disabled={v.definition.check !== 'verified' || v.phase === 'pause-incomplete'} onClick={() => client.send({ kind: 'run', running: !v.running })}>{v.running ? '暂停遍历' : '开始遍历输入'}</button><label><input type="checkbox" checked={v.background} onChange={e => client.send({ kind: 'background', enabled: e.target.checked })} />离屏继续运行</label></div>
      <p className="builtin-runtime-state" role="status" aria-label="实验运行状态">{v.phase === 'running' ? '正在遍历' : v.phase === 'pause-incomplete' ? '暂停未完成' : v.phase === 'needs-check' ? '等待公式核对' : '已暂停'} · 模拟时间 {v.state.simulationTime} ms · 已确认 {v.state.step} 步 · 定义 {v.definition.revision}</p>
      <p role="status" aria-label="实验保存状态">{client.error || v.phase === 'pause-incomplete' ? '现场未保存' : client.pending ? '正在保存现场' : '现场已保存'}</p>
      {client.error && <p className="builtin-error" role="alert">{client.error} 输入仍保留。<button onClick={() => void client.retry()}>重试保存现场</button></p>}
      {v.phase === 'pause-incomplete' && <p className="builtin-error" role="alert">暂停未完成，显示的是最近确认现场。<button onClick={() => void client.recover()}>恢复最近确认现场</button></p>}
    </>}
  </section>;
}
