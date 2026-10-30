import { PanelPortal, useDockPanel } from './shell/panels';
import { Check, ChevronDown, CircleAlert, Search, X } from 'lucide-react';
import { Checkbox } from '@base-ui/react/checkbox';
import { Button } from './components/ui/button';
import { DescriptionSearch, useDescriptionSearch } from './description-search';
import { SearchHitCard } from './search-hit';
import { useEffect, useRef, useState } from 'react';
import { searchScopes, type SearchHit, type SearchResults, type SearchScope, type SearchStatus } from '../search-api';
import './search-panel.css';
const labels: Record<SearchScope, string> = { knowledge: '知识', notes: '个人笔记', messages: '学习对话', sources: '来源原文' };
const shortLabels: Record<SearchScope, string> = { knowledge: '知识', notes: '笔记', messages: '对话', sources: '原文' };
export function SearchPanel({ sessionId, narrow, locate }: { sessionId: string; narrow: boolean; locate(hit: SearchHit): Promise<void> }) {
  const described = useDescriptionSearch(sessionId);
  const { open, setOpen } = useDockPanel('search');
  const [query, setQuery] = useState(''), [scopes, setScopes] = useState(searchScopes);
  const [results, setResults] = useState<SearchResults>(), [status, setStatus] = useState<SearchStatus>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [indexing, setIndexing] = useState(false), [revision, setRevision] = useState(0);
  const input = useRef<HTMLInputElement>(null), panel = useRef<HTMLElement>(null);
  const lastQuery = useRef('');
  const serial = useRef(0), alive = useRef(true), indexingRef = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);
  const show = (value: boolean) => { setOpen(value); };
  const rebuild = async (reset = false, retryErrors = false) => {
    if (indexingRef.current) return;
    indexingRef.current = true; setIndexing(true);
    try {
      let state = await window.yizhi.search.rebuild({ sessionId, batchSize: 2, reset, retryErrors });
      if (alive.current) setStatus(state);
      let refreshedAt = performance.now();
      while (state.pending > state.indexErrors.length && alive.current) {
        await new Promise(resolve => setTimeout(resolve, 25));
        if (!alive.current) break;
        state = await window.yizhi.search.rebuild({ sessionId, batchSize: 2 }); setStatus(state);
        if (performance.now() - refreshedAt >= 300) { refreshedAt = performance.now(); setRevision(n => n + 1); }
      }
      if (alive.current) setRevision(n => n + 1);
    } catch (e) { if (alive.current) setError(`索引未完成：${(e as Error).message}。可重试索引，已有内容仍可查找。`); }
    finally { indexingRef.current = false; if (alive.current) setIndexing(false); }
  };
  useEffect(() => { if (open) { input.current?.focus(); void window.yizhi.search.status({ sessionId }).then(setStatus).catch(e => setError(e.message)); void rebuild(); } }, [open]);
  useEffect(() => {
    const token = ++serial.current;
    if (!query.trim() || !scopes.length) { lastQuery.current = ''; setResults(undefined); setLoading(false); return; }
    const key = JSON.stringify([sessionId, query, scopes]), changed = key !== lastQuery.current; lastQuery.current = key;
    if (changed) { setLoading(true); setResults(undefined); }
    const timer = setTimeout(() => {
      void window.yizhi.search.query({ sessionId, query, scopes }).then(result => {
        if (token === serial.current && alive.current) { setResults(result); setStatus(result.status); setError(''); setLoading(false); }
      }).catch(e => { if (token === serial.current && alive.current) { setError(e.message); setLoading(false); } });
    }, changed ? 150 : 0);
    return () => clearTimeout(timer);
  }, [query, scopes, revision]);
  const openHit = (hit: SearchHit) => { void (async () => {
    try { const current = await window.yizhi.search.locate({ sessionId, hit }); await locate(current); setOpen(false); }
    catch (e) { setError((e as Error).message); void window.yizhi.search.status({ sessionId }).then(setStatus).catch(() => {}); }
  })(); };
  // The retained native input owns its live value. Index/result renders must not replace
  // a new browser edit with the previous query before its input event reaches React.
  return <PanelPortal id="search"><aside ref={panel} className="search-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="搜索课程" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); show(false); }
    if (event.key === 'Tab' && narrow) {
      const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), [role="checkbox"]:not([aria-disabled="true"]):not([tabindex="-1"]), summary')].filter(el => el.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }}>
    <div className="search-heading"><h2>搜索课程</h2><Button variant="ghost" size="icon-sm" className="panel-close" aria-label="收起搜索" onClick={() => show(false)}><X size={18}/></Button></div>
    <label className="search-input"><span className="sr-only">查找已有内容</span><span className="search-field"><Search size={17} aria-hidden="true"/><input ref={input} type="search" aria-label="查找已有内容" defaultValue={query} onInput={e => setQuery(e.currentTarget.value)} placeholder="关键词、别名或公式符号" maxLength={512} /></span></label>
    <fieldset className="search-scopes"><legend>搜索范围</legend><div className="search-scope-options">{searchScopes.map(scope => <Checkbox.Root className="search-scope" key={scope} title={labels[scope]} aria-label={labels[scope]} checked={scopes.includes(scope)} onCheckedChange={checked => setScopes(current => checked ? [...current, scope] : current.filter(s => s !== scope))}><span className="search-scope-check" aria-hidden="true"><Checkbox.Indicator><Check size={11} strokeWidth={3}/></Checkbox.Indicator></span><span>{shortLabels[scope]}</span></Checkbox.Root>)}</div></fieldset>
    <div className="search-tools"><DescriptionSearch state={described} scopes={scopes} locate={openHit} />
    {status && (status.indexErrors.length > 0 || status.unreadable.length > 0 || status.noText.length > 0 || status.unavailable > 0) && <details className="search-coverage"><summary className="search-tool-summary"><CircleAlert size={16} aria-hidden="true"/><span>未覆盖与不可读内容</span><ChevronDown className="search-tool-chevron" size={15} aria-hidden="true"/></summary><div className="search-coverage-content">
      {status.unavailable > 0 && <p>{status.unavailable} 个目录单元尚无已交付可读正文；不将其元数据当作全文。</p>}
      {status.indexErrors.map(p => <p key={`index:${p.entityId}`}>{p.title} 尚未索引：{p.reason}。已有内容仍可搜索。</p>)}
      {status.noText.map(p => <p key={p.entityId}>{p.title}：{p.reason}</p>)}
      {status.unreadable.map(p => <div key={`${p.scope}:${p.entityId}`}><p>{labels[p.scope]} · {p.title}：{p.reason}</p>{p.scope === 'sources' && <Button variant="outline" size="sm" onClick={() => { void (async () => {
        try { const { generation } = await window.yizhi.sources.list({ sessionId }); const repaired = await window.yizhi.sources.chooseRepair({ sessionId, generation, operationId: crypto.randomUUID(), versionId: p.entityId }); if (repaired) await rebuild(false, true); }
        catch (e) { setError((e as Error).message); }
      })(); }}>从原件修复此版本</Button>}</div>)}
    </div></details>}</div>
    {error && <p role="alert" className="search-error">{error}</p>}
    {indexing && <p className="search-index" role="status">正在更新搜索结果…</p>}
    <section className="search-results" role="region" aria-label="搜索结果" aria-busy={loading}>
      {!scopes.length ? <p className="search-results-status" role="status">请选择至少一个搜索范围。</p> : !query.trim() && <div className="search-empty"><Search size={19} aria-hidden="true"/><div><p className="search-empty-title">输入关键词开始查找</p><p>已保存的内容可离线搜索</p></div></div>}
      {!!scopes.length && !!query.trim() && loading && <p className="search-results-status" role="status">正在查找…</p>}
      {!!scopes.length && !!query.trim() && results && <><p className="search-results-status" role="status">{results.hits.length ? `找到 ${results.hits.length} 处已有内容` : results.incomplete ? '已检查部分未命中；尚有未索引内容，索引后再查。' : '已检查范围无命中。'}{results.truncated && ' 结果较多，请补充关键词或缩小范围。'}{results.incomplete && results.hits.length > 0 && ' 仍有未索引内容。'}</p>
        {results.hits.map((hit, i) => <SearchHitCard key={`${hit.scope}:${hit.entityId}:${hit.field}:${i}`} hit={hit} locate={openHit} />)}
      </>}
    </section>
  </aside></PanelPortal>;
}
