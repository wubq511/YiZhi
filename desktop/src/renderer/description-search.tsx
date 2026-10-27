import { useEffect, useRef, useState } from 'react';
import type { DescriptionRun } from '../description-api';
import type { ExecutorStatus } from '../agent-api';
import type { SearchHit, SearchScope } from '../search-api';
import { SearchHitCard } from './search-hit';
import './description-search.css';

/** Lives with the search panel even while its portal is closed. Never reads the QA composer. */
export function useDescriptionSearch(sessionId: string) {
  const [online, setOnline] = useState(navigator.onLine), [executor, setExecutor] = useState<ExecutorStatus>();
  const [description, setDescription] = useState(''), [model, setModel] = useState(''), [run, setRun] = useState<DescriptionRun>();
  const [error, setError] = useState(''), [checking, setChecking] = useState(false), [starting, setStarting] = useState(false);
  const alive = useRef(true);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { alive.current = false; window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  const check = async () => {
    if (checking || !online) return;
    setChecking(true); setError('');
    try { const value = await window.yizhi.description.status(); if (alive.current) { setExecutor(value); setModel(current => current || value.models.find(m => m.isDefault)?.model || value.models[0]?.model || ''); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setChecking(false); }
  };
  const start = async (scopes: SearchScope[]) => {
    if (starting || run?.state === 'running') return;
    if (!online) { setError('当前离线，仍可使用上方关键词、别名和符号查找。'); return; }
    setStarting(true); setError('');
    try { const next = await window.yizhi.description.start({ sessionId, id: crypto.randomUUID(), description, scopes, ...(model ? { model } : {}) }); if (alive.current) setRun(next); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setStarting(false); }
  };
  useEffect(() => {
    if (run?.state !== 'running') return;
    const id = run.id;
    const poll = () => { void window.yizhi.description.get({ sessionId, id }).then(next => { if (alive.current) setRun(current => current?.id === id ? next : current); }).catch(e => { if (alive.current) setError(e.message); }); };
    poll(); const timer = setInterval(poll, 250); return () => clearInterval(timer);
  }, [run?.id, run?.state, sessionId]);
  const cancel = async () => { if (!run) return; try { setRun(await window.yizhi.description.cancel({ sessionId, id: run.id })); } catch (e) { setError((e as Error).message); } };
  return { online, executor, description, setDescription, model, setModel, run, error, checking, starting, check, start, cancel };
}
export function DescriptionSearch({ state, scopes, locate }: { state: ReturnType<typeof useDescriptionSearch>; scopes: SearchScope[]; locate(hit: SearchHit): void }) {
  const { online, executor, description, setDescription, model, setModel, run, error, checking, starting } = state;
  const pending = starting || run?.state === 'running';
  const partial = run?.queries.some(q => q.incomplete || q.scopes.includes('knowledge') && q.status.unavailable > 0);
  const unreadable = run?.queries.some(q => q.status.unreadable.length > 0);
  const completeLabel = !run ? '' : run.state === 'running' ? '正在改写查询并检查已有内容…' : run.state === 'cancelled' ? '描述检索已停止；基础检索仍可使用。' : run.state === 'failed' ? '描述检索未完成；基础检索仍可使用。' : run.hits.length ? `检索完成 · ${run.hits.length} 处已有内容` : run.outcome === 'no-selection' ? '本次描述未选出仍有效的匹配；可核对实际查询或补充线索。' : partial ? '已检查部分未命中；仍有未索引或不可用内容。' : unreadable ? '可读范围未命中；仍有内容不可读。' : '执行查询未命中已有内容。';
  return <details className="description-search" onToggle={event => { if (event.currentTarget.open && !executor && !checking && online) void state.check(); }}>
    <summary>按记忆线索查找（Agent）</summary>
    <p className="description-help">让 Agent 改写关键词并重排已有命中。点击查找时，会将这段描述与命中摘录交给所选模型。</p>
    {!online && <p role="status">当前离线。上方关键词、别名和符号查找继续可用。</p>}
    {checking && <p role="status">正在检查本机 CLI 与模型目录…</p>}
    {executor && <p className="description-executor" role="status" aria-label="描述检索可用性">{executor.available ? `${executor.version} · 模型目录可用，远程检索尚需实际请求。` : `描述增强暂不可用：${executor.error} 基础检索继续可用。`}</p>}
    <label className="description-input">记忆线索<textarea aria-label="记忆线索" value={description} maxLength={4000} placeholder="例如：把输入的编号变成只有一条输出为 1 的电路" onChange={e => setDescription(e.target.value)} /></label>
    {executor?.available && <label className="description-model">检索模型<select aria-label="描述检索模型" value={model} disabled={pending} onChange={e => setModel(e.target.value)}>{executor.models.map(m => <option key={m.id} value={m.model}>{m.displayName}</option>)}</select></label>}
    <div className="description-actions"><button disabled={!online || checking || pending || !description.trim() || !scopes.length || executor?.available === false} onClick={() => void state.start(scopes)}>用描述查找已有内容</button>{pending && <button onClick={() => void state.cancel()}>停止描述检索</button>}{!pending && <button disabled={!online || checking} onClick={() => void state.check()}>检查执行器</button>}</div>
    {error && <p role="alert" className="search-error">{error}</p>}
    {run && <section data-description-id={run.id} role="region" aria-label="描述检索结果" className="description-results" aria-busy={run.state === 'running'}>
      <p role="status" aria-label="描述检索状态">{completeLabel}</p>
      <p className="description-help">本次线索：{run.description}</p>
      {run.error && <p role="alert" className="search-error">{run.error}</p>}
      {run.executor && <p className="description-executor">{run.executor.version} · {run.executor.model}</p>}
      {run.queries.length > 0 && <details className="description-evidence"><summary>实际执行的查询 · {run.queries.length}</summary>{run.queries.map(q => <section key={q.id}><p>{q.id}：{q.query} · {q.mode === 'trigram' ? 'trigram' : '字面匹配'} · 返回 {q.hitIds.length} 处</p><p>工具调用 {q.callId}</p>
        {q.incomplete && <p>仍有未索引内容；这里只检查了有界范围，不能据此断言全课无命中。</p>}
        {q.status.unavailable > 0 && q.scopes.includes('knowledge') && <p>{q.status.unavailable} 个目录单元尚无可读正文。</p>}
        {q.status.pending > 0 && <p>{q.status.pending} 个对象尚未完成索引。</p>}
        {q.status.unreadable.map(p => <p key={p.entityId}>{p.scope === 'sources' ? '来源不可读' : '内容不可读'}：{p.title} · {p.reason}</p>)}
        {q.status.noText.map(p => <p key={p.entityId}>原页无可靠文字层：{p.title} · {p.reason}</p>)}
        {q.status.indexErrors.map(p => <p key={p.entityId}>尚未索引：{p.title} · {p.reason}</p>)}
        {q.truncated && <p>此查询仅返回部分命中，可缩小范围后再查。</p>}
      </section>)}</details>}
      {run.rejected.map(item => <p className="search-error" key={item.id}>命中已变化，未列入结果：{item.reason}</p>)}
      {run.toolErrors.length > 0 && <details className="description-evidence"><summary>被拒绝的工具请求</summary>{run.toolErrors.map((item, i) => <p key={i}>{item.callId} · {item.tool}：{item.reason}</p>)}</details>}
      {run.hits.map(selected => <SearchHitCard key={selected.id} hit={selected.hit} locate={locate}><details className="description-evidence"><summary>查询与排序依据</summary><p>实际命中 {selected.id} · 描述排序 {selected.rank}</p>{selected.basis.map(b => <p key={b.queryId}>{b.queryId}：{b.query} · 原查询第 {b.originalRank} 处 · 工具调用 {b.callId}</p>)}<p>选择调用 {run.ranking?.callId}</p></details></SearchHitCard>)}
    </section>}
  </details>;
}
