import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { searchScopes, type SearchHit, type SearchResults, type SearchScope, type SearchStatus } from '../search-api';
import './search-panel.css';
const labels: Record<SearchScope, string> = { knowledge: '知识', notes: '个人笔记', messages: '学习对话', sources: '来源原文' };
export function SearchPanel({ sessionId, narrow, beforeOpen, onOpenChange, locate }: { sessionId: string; narrow: boolean; beforeOpen(): void; onOpenChange(open: boolean): void; locate(hit: SearchHit): Promise<void> }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [scopes, setScopes] = useState(searchScopes);
  const [results, setResults] = useState<SearchResults>(), [status, setStatus] = useState<SearchStatus>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [indexing, setIndexing] = useState(false), [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const prepared = useRef(false);
  const serial = useRef(0), alive = useRef(true), indexingRef = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);
  const show = (value: boolean) => { setOpen(value); onOpenChange(value); if (!value) requestAnimationFrame(() => trigger.current?.focus()); };
  const rebuild = async (reset = false, retryErrors = false) => {
    if (indexingRef.current) return;
    indexingRef.current = true; setIndexing(true);
    try {
      let state = await window.yizhi.search.rebuild({ sessionId, batchSize: 2, reset, retryErrors });
      if (alive.current) setStatus(state);
      while (state.pending > state.indexErrors.length && alive.current) {
        await new Promise(resolve => setTimeout(resolve, 25));
        if (!alive.current) break;
        state = await window.yizhi.search.rebuild({ sessionId, batchSize: 2 }); setStatus(state);
      }
      if (alive.current) setRevision(n => n + 1);
    } catch (e) { if (alive.current) setError(`索引未完成：${(e as Error).message}。可重试索引，已有内容仍可查找。`); }
    finally { indexingRef.current = false; if (alive.current) setIndexing(false); }
  };
  useEffect(() => { if (open) { input.current?.focus(); void window.yizhi.search.status({ sessionId }).then(setStatus).catch(e => setError(e.message)); void rebuild(); } }, [open]);
  useEffect(() => {
    const token = ++serial.current;
    if (!open || !query.trim()) { setResults(undefined); setLoading(false); return; }
    setLoading(true); setResults(undefined);
    const timer = setTimeout(() => {
      void window.yizhi.search.query({ sessionId, query, scopes }).then(result => {
        if (token === serial.current && alive.current) { setResults(result); setStatus(result.status); setError(''); setLoading(false); }
      }).catch(e => { if (token === serial.current && alive.current) { setError(e.message); setLoading(false); } });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, scopes, open, revision]);
  return <><button ref={trigger} aria-expanded={open} onPointerDown={() => { if (!open) { beforeOpen(); prepared.current = true; } }} onKeyDown={event => { if (!open && ['Enter', ' '].includes(event.key)) { beforeOpen(); prepared.current = true; } }} onClick={() => { if (!open && !prepared.current) beforeOpen(); prepared.current = false; show(true); }}>搜索课程</button>{open && createPortal(<aside ref={panel} className="search-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="搜索课程" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); show(false); }
    if (event.key === 'Tab' && narrow) {
      const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')].filter(el => el.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }}>
    <div className="search-heading"><h2>搜索课程</h2><button onClick={() => show(false)}>收起搜索</button></div>
    <label className="search-input">查找已有内容<input ref={input} type="search" aria-label="查找已有内容" value={query} onChange={e => setQuery(e.target.value)} placeholder="关键词、别名或公式符号" maxLength={512} /></label>
    <fieldset className="search-scopes"><legend>搜索范围</legend>{searchScopes.map(scope => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e => setScopes(current => e.target.checked ? [...current, scope] : current.filter(s => s !== scope))} />{labels[scope]}</label>)}</fieldset>
    {error && <p role="alert" className="search-error">{error}</p>}
    <div className="search-index" role="status" aria-label="搜索索引状态">{status && <span>{status.pending ? `${status.pending} 个对象尚未完成索引；当前变化正用有界直查补齐。` : '当前可读内容已索引。'}{indexing && ' 正在分批索引…'}</span>}
      <button disabled={indexing} onClick={() => void rebuild(true, true)}>重建索引</button>
    </div>
    {status && (status.indexErrors.length > 0 || status.unreadable.length > 0 || status.noText.length > 0 || status.unavailable > 0) && <details className="search-coverage"><summary>未覆盖与不可读内容</summary>
      {status.unavailable > 0 && <p>{status.unavailable} 个目录单元尚无已交付可读正文；不将其元数据当作全文。</p>}
      {status.indexErrors.map(p => <p key={`index:${p.entityId}`}>{p.title} 尚未索引：{p.reason}。仍可直查，或重建索引。</p>)}
      {status.noText.map(p => <p key={p.entityId}>{p.title}：{p.reason}</p>)}
      {status.unreadable.map(p => <div key={`${p.scope}:${p.entityId}`}><p>{labels[p.scope]} · {p.title}：{p.reason}</p>{p.scope === 'sources' && <button onClick={() => { void (async () => {
        try { const { generation } = await window.yizhi.sources.list({ sessionId }); const repaired = await window.yizhi.sources.chooseRepair({ sessionId, generation, operationId: crypto.randomUUID(), versionId: p.entityId }); if (repaired) await rebuild(false, true); }
        catch (e) { setError((e as Error).message); }
      })(); }}>从原件修复此版本</button>}</div>)}
    </details>}
    <section className="search-results" role="region" aria-label="搜索结果" aria-busy={loading}>
      {!query.trim() && <p>查找已保存的知识、笔记、学习对话和来源原文。断网也可使用。</p>}
      {loading && <p role="status">正在查找…</p>}
      {results && <><p role="status">{results.hits.length ? `找到 ${results.hits.length} 处已有内容` : results.incomplete ? '已检查部分未命中；尚有未索引内容，索引后再查。' : '已检查范围无命中。'}{results.truncated && ' 结果较多，请补充关键词或缩小范围。'}{results.incomplete && results.hits.length > 0 && ' 仍有未索引内容。'}</p>
        {results.hits.map((hit, i) => <article className="search-result" key={`${hit.scope}:${hit.entityId}:${hit.field}:${i}`}><p className="search-result-kind">{labels[hit.scope]}{hit.pdfPageIndex !== undefined && ` · PDF 第 ${hit.pdfPageIndex + 1} 页`}</p><h3>{hit.title}</h3><p className="search-excerpt">{hit.excerpt}</p>
          <details><summary>身份与版本</summary><p>{hit.entityId}{hit.blockId && ` · ${hit.blockId}`} · {hit.field}</p><p>版本 {hit.version}</p>{hit.projectionId && <p>文本投影 {hit.projectionId} · {hit.convention}</p>}</details>
          <button onClick={() => { void (async () => { try { const current = await window.yizhi.search.locate({ sessionId, hit }); await locate(current); setOpen(false); onOpenChange(false); } catch (e) { setError((e as Error).message); } })(); }}>定位命中</button>
        </article>)}
      </>}
    </section>
  </aside>, document.body)}</>;
}
