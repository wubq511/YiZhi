import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle } from '../components/ui/popover';
import { Button } from '../components/ui/button';
export type SavePhase = 'saved' | 'draft' | 'pending' | 'saving' | 'error';
export interface SaveReport { label: string; status: SavePhase; detail?: string; retry?: () => unknown }
const reports = new Map<string, SaveReport>(), listeners = new Set<() => void>();
let snapshot: Array<SaveReport & {id:string}> = [];
function emit() { snapshot = [...reports].map(([id, report]) => ({id,...report})); listeners.forEach(fn => fn()); }
export function reportSave(id: string, value: SaveReport) { reports.set(id, value); emit(); }
export function clearSave(id: string) { if (reports.get(id)?.status === 'error' || ['pending','saving'].includes(reports.get(id)?.status ?? '')) return; reports.delete(id); emit(); }
export function resetSaves() { reports.clear(); emit(); }
export function useSaveReport(id: string, report: SaveReport) {
  const latest = useRef(report); latest.current = report;
  useLayoutEffect(() => { reportSave(id, { ...report, retry: () => latest.current.retry?.() }); }, [id, report.label, report.status, report.detail]);
  useEffect(() => () => clearSave(id), [id]);
}
export function aggregateSaves(values: SaveReport[]): SavePhase {
  if (values.some(v => v.status === 'error')) return 'error';
  if (values.some(v => v.status === 'pending' || v.status === 'saving')) return 'saving';
  if (values.some(v => v.status === 'draft')) return 'draft';
  return 'saved';
}
export function SaveIndicator({ ready }: { ready: boolean }) {
  const values = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => snapshot);
  const phase = ready ? aggregateSaves(values) : 'saving';
  const label = { error: '有改动未保存', saving: ready ? '正在保存' : '正在打开课程', pending: '待保存', draft: '草稿已保留', saved: '已保存' }[phase];
  const Icon = phase === 'error' ? CircleAlert : phase === 'saving' ? LoaderCircle : Check;
  const priorities: Record<SavePhase, number> = { error:0, saving:1, pending:2, draft:3, saved:4 };
  const attention=values.filter(v=>v.status!=='saved').sort((a,b)=>priorities[a.status]-priorities[b.status]);
  const saved=values.filter(v=>v.status==='saved');
  return <Popover><PopoverTrigger render={<Button variant="ghost" className={`shell-save shell-save-${phase}`} />}><Icon size={16}/><span role="status" aria-label="保存状态">{label}</span></PopoverTrigger>
    <PopoverContent className="shell-save-details" align="end"><PopoverTitle>自动保存</PopoverTitle>
      {attention.map(v=><div key={v.id} className={`save-channel save-channel-${v.status}`}><strong>{v.label}</strong><span>{({saved:'已保存',draft:'草稿已保留',pending:'待保存',saving:'正在保存',error:'未保存'})[v.status]}</span>{v.status==='error'&&<><p>{v.detail ? v.detail.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'').split(/\n\s*at\s/)[0] : `${v.label}尚未确认保存，当前现场仍保留。`}</p>{v.retry&&<Button variant="outline" onClick={()=>void v.retry?.()}>重试保存{v.label}</Button>}</>}</div>)}
      {!!saved.length&&<details className="save-confirmed"><summary>已保存 · {saved.length} 项</summary>{saved.map(v=><div key={v.id}><Check size={13}/><span>{v.label}</span></div>)}</details>}
    </PopoverContent>
  </Popover>;
}
