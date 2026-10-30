import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import type { DescriptionRun } from '../description-api';
import type { ExecutorStatus } from '../agent-api';
import type { SearchHit, SearchScope } from '../search-api';
import { Button } from './components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { InputGroupAddon, InputGroupButton } from './components/ui/input-group';
import { SearchHitCard } from './search-hit';
import './description-search.css';

const modelPreferenceKey = 'yizhi.description-search.model';

function preferredModel() {
  try { return localStorage.getItem(modelPreferenceKey) || ''; }
  catch { return ''; }
}

/** Lives with the search panel even while its portal is closed. Never reads the QA composer. */
export function useDescriptionSearch(sessionId: string) {
  const [online, setOnline] = useState(navigator.onLine), [executor, setExecutor] = useState<ExecutorStatus>();
  const [model, setModel] = useState(''), [run, setRun] = useState<DescriptionRun>();
  const [error, setError] = useState(''), [preferenceError, setPreferenceError] = useState('');
  const [checking, setChecking] = useState(false), [starting, setStarting] = useState(false);
  const alive = useRef(true), preferred = useRef(preferredModel()), startingRef = useRef(false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { alive.current = false; window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== modelPreferenceKey) return;
      preferred.current = event.newValue || '';
      if (event.newValue && executor?.models.some(item => item.model === event.newValue)) setModel(event.newValue);
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, [executor]);
  const chooseModel = (value: string) => {
    preferred.current = value; setModel(value);
    try { localStorage.setItem(modelPreferenceKey, value); setPreferenceError(''); }
    catch { setPreferenceError('模型选择无法保存，下次打开时需要重新选择。'); }
  };
  const check = async () => {
    if (checking || !online) return;
    setChecking(true); setError('');
    try {
      const value = await window.yizhi.description.status();
      if (alive.current) {
        setExecutor(value);
        setModel(current => value.models.find(item => item.model === preferred.current)?.model
          || value.models.find(item => item.model === current)?.model
          || value.models.find(item => item.isDefault)?.model || value.models[0]?.model || '');
      }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setChecking(false); }
  };
  const start = async (description: string, scopes: SearchScope[]) => {
    if (startingRef.current || run?.state === 'running') return;
    if (!online) { setError('当前离线，仍可使用本地搜索。'); return; }
    startingRef.current = true; setStarting(true); setError(''); setRun(undefined);
    try {
      const next = await window.yizhi.description.start({ sessionId, id: crypto.randomUUID(), description, scopes, ...(model ? { model } : {}) });
      if (alive.current) setRun(next);
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { startingRef.current = false; if (alive.current) setStarting(false); }
  };
  useEffect(() => {
    if (run?.state !== 'running') return;
    const id = run.id;
    const poll = () => { void window.yizhi.description.get({ sessionId, id }).then(next => { if (alive.current) setRun(current => current?.id === id && current.state === 'running' ? next : current); }).catch(e => { if (alive.current) setError(e.message); }); };
    poll(); const timer = setInterval(poll, 250); return () => clearInterval(timer);
  }, [run?.id, run?.state, sessionId]);
  const cancel = async () => { if (!run) return; try { setRun(await window.yizhi.description.cancel({ sessionId, id: run.id })); } catch (e) { setError((e as Error).message); } };
  return { online, executor, model, chooseModel, run, error, preferenceError, checking, starting, check, start, cancel };
}

type DescriptionState = ReturnType<typeof useDescriptionSearch>;

export function DescriptionControls({ state, canStart, onStart }: { state: DescriptionState; canStart: boolean; onStart(): void }) {
  const { online, executor, model, chooseModel, checking, starting, run } = state;
  const models = executor?.models ?? [];
  const pending = starting || run?.state === 'running';
  const modelName = models.find(item => item.model === model)?.displayName || model || (checking ? '正在检查…' : '检索模型');
  return <InputGroupAddon align="block-end" className="description-controls">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <InputGroupButton variant="outline" size="xs" className="description-model-trigger" aria-label="检索模型" disabled={!online || checking || !executor?.available || pending}>
          <span className="description-model-value">{modelName}</span><ChevronDown size={14} aria-hidden="true" />
        </InputGroupButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="description-model-menu" align="start" sideOffset={6}>
        <DropdownMenuRadioGroup value={model} onValueChange={chooseModel}>
          {models.map(item => <DropdownMenuRadioItem className="description-model-item" key={item.id} value={item.model}>{item.displayName || item.model}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <InputGroupButton size="icon-sm" variant="default" className="description-submit" aria-label={pending ? '停止 AI 查找' : 'AI 查找'} title={pending ? '停止 AI 查找' : '联网发送输入和匹配内容摘录'} disabled={starting || (!pending && !canStart)} onClick={pending ? () => void state.cancel() : onStart}>
      {pending ? <Square size={14} fill="currentColor" aria-hidden="true" /> : <ArrowUp size={17} aria-hidden="true" />}
    </InputGroupButton>
  </InputGroupAddon>;
}

export function DescriptionFeedback({ state, showError }: { state: DescriptionState; showError: boolean }) {
  const { online, executor, checking, preferenceError, error } = state;
  return <>
    {!online && <p className="description-problem" role="status">当前离线，仍可使用本地搜索。</p>}
    {online && executor && !executor.available && <div className="description-problem" role="status">AI 查找暂不可用：{executor.error} <Button variant="outline" size="sm" type="button" onClick={() => void state.check()} disabled={checking}>重新检查</Button></div>}
    {online && error && showError && <div className="search-error" role="alert">{error}{!executor && <> <Button variant="outline" size="sm" className="description-retry" type="button" onClick={() => void state.check()} disabled={checking}>重新检查</Button></>}</div>}
    {preferenceError && <p className="search-error" role="alert">{preferenceError}</p>}
  </>;
}

export function DescriptionResults({ state, stale, showCancel, locate }: { state: DescriptionState; stale: boolean; showCancel: boolean; locate(hit: SearchHit): void }) {
  const { run, starting, error } = state;
  const partial = run?.queries.some(q => q.incomplete || q.scopes.includes('knowledge') && q.status.unavailable > 0);
  const unreadable = run?.queries.some(q => q.status.unreadable.length > 0);
  const completeLabel = starting || run?.state === 'running' ? '正在 AI 查找…' : !run ? '' : run.state === 'cancelled' ? 'AI 查找已停止。' : run.state === 'failed' ? 'AI 查找未完成。' : run.hits.length ? `AI 检索完成 · ${run.hits.length} 处已有内容` : run.outcome === 'no-selection' ? '未选出有效匹配，可补充线索再试。' : partial ? '已检查部分未命中；仍有未索引或不可用内容。' : unreadable ? '可读范围未命中；仍有内容不可读。' : '未找到已有内容。';
  return <section data-description-id={run?.id} role="region" aria-label="AI 检索结果" className="description-results" aria-busy={starting || run?.state === 'running'}>
    {stale && <p className="description-previous">搜索条件已改变，显示的是上次 AI 结果。</p>}
    {completeLabel && <div className="description-result-status"><p role="status" aria-label="描述检索状态">{completeLabel}</p>{showCancel && run?.state === 'running' && <Button variant="ghost" size="sm" onClick={() => void state.cancel()}>停止 AI 查找</Button>}</div>}
    {error && <p role="alert" className="search-error">{error}</p>}
    {run?.error && <p role="alert" className="search-error">{run.error}</p>}
    {!!run?.queries.length && <details className="description-evidence"><summary>实际执行的查询 · {run.queries.length}</summary>{run.queries.map(q => <section key={q.id}><p>{q.id}：{q.query} · {q.mode === 'trigram' ? 'trigram' : '字面匹配'} · 返回 {q.hitIds.length} 处</p><p>工具调用 {q.callId}</p>
      {q.incomplete && <p>仍有未索引内容；这里只检查了有界范围，不能据此断言全课无命中。</p>}
      {q.status.pending > 0 && <p>{q.status.pending} 个对象尚未完成索引。</p>}
      {q.status.unreadable.map(p => <p key={p.entityId}>{p.scope === 'sources' ? '来源不可读' : '内容不可读'}：{p.title} · {p.reason}</p>)}
      {q.status.noText.map(p => <p key={p.entityId}>原页无可靠文字层：{p.title} · {p.reason}</p>)}
      {q.status.indexErrors.map(p => <p key={p.entityId}>尚未索引：{p.title} · {p.reason}</p>)}
      {q.truncated && <p>此查询仅返回部分命中，可缩小范围后再查。</p>}
    </section>)}</details>}
    {run?.rejected.map(item => <p className="search-error" key={item.id}>命中已变化，未列入结果：{item.reason}</p>)}
    {!!run?.toolErrors.length && <details className="description-evidence"><summary>被拒绝的工具请求</summary>{run.toolErrors.map((item, i) => <p key={i}>{item.callId} · {item.tool}：{item.reason}</p>)}</details>}
    {run?.hits.map(selected => <SearchHitCard key={selected.id} hit={selected.hit} locate={locate}><details className="description-evidence"><summary>查询与排序依据</summary><p>实际命中 {selected.id} · 描述排序 {selected.rank}</p>{selected.basis.map(b => <p key={b.queryId}>{b.queryId}：{b.query} · 原查询第 {b.originalRank} 处 · 工具调用 {b.callId}</p>)}<p>选择调用 {run.ranking?.callId}</p></details></SearchHitCard>)}
  </section>;
}
