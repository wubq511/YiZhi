import { PanelPortal, useDockPanel } from './shell/panels';
import { ChevronDown, CircleAlert, Sparkles, X } from 'lucide-react';
import { Checkbox } from './components/ui/checkbox';
import { Button } from './components/ui/button';
import { InputGroup, InputGroupButton, InputGroupTextarea } from './components/ui/input-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { DescriptionControls, DescriptionFeedback, DescriptionResults, useDescriptionSearch } from './description-search';
import { SearchHitCard } from './search-hit';
import { Tooltip as TooltipPrimitive } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { searchScopes, type SearchHit, type SearchResults, type SearchScope, type SearchStatus } from '../search-api';
import './search-panel.css';
const labels: Record<SearchScope, string> = { knowledge: '知识', notes: '个人笔记', messages: '学习对话', sources: '来源原文' };
const shortLabels: Record<SearchScope, string> = { knowledge: '知识', notes: '笔记', messages: '对话', sources: '原文' };
export function SearchPanel({ sessionId, narrow, locate }: { sessionId: string; narrow: boolean; locate(hit: SearchHit): Promise<void> }) {
  const described = useDescriptionSearch(sessionId);
  const { open, setOpen } = useDockPanel('search');
  const [query, setQuery] = useState(''), [scopes, setScopes] = useState(searchScopes);
  const [aiMode, setAiMode] = useState(false), [aiMotion, setAiMotion] = useState(false), [showAiControls, setShowAiControls] = useState(false);
  const [resultView, setResultView] = useState<'local' | 'ai'>('local');
  const [results, setResults] = useState<SearchResults>(), [status, setStatus] = useState<SearchStatus>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [indexing, setIndexing] = useState(false), [revision, setRevision] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null), panel = useRef<HTMLElement>(null);
  const controlsTimer = useRef<number | undefined>(undefined);
  const lastQuery = useRef('');
  const serial = useRef(0), alive = useRef(true), indexingRef = useRef(false);
  const wasOnline = useRef(described.online);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => () => window.clearTimeout(controlsTimer.current), []);
  useEffect(() => {
    if (!wasOnline.current && described.online && aiMode && !described.checking) void described.check();
    wasOnline.current = described.online;
  }, [described.online]);
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
    if (!query.trim() || !scopes.length || Array.from(query).length > 256) { lastQuery.current = ''; setResults(undefined); setLoading(false); return; }
    const key = JSON.stringify([sessionId, query, scopes]), changed = key !== lastQuery.current; lastQuery.current = key;
    if (changed) { setLoading(true); setResults(undefined); }
    const timer = setTimeout(() => {
      void window.yizhi.search.query({ sessionId, query, scopes }).then(result => {
        if (token === serial.current && alive.current) { setResults(result); setStatus(result.status); setError(''); setLoading(false); }
      }).catch(e => { if (token === serial.current && alive.current) { setError(e.message); setLoading(false); } });
    }, changed ? 150 : 0);
    return () => clearTimeout(timer);
  }, [query, scopes, revision]);
  const openHit = (hit: SearchHit) => { void locate(hit).catch(e => {
    setError((e as Error).message); void window.yizhi.search.status({ sessionId }).then(setStatus).catch(() => {});
  }); };
  const canStartAi = described.online && !described.checking && !!described.executor?.available && !described.starting && described.run?.state !== 'running'
    && !!query.trim() && Array.from(query).length <= 2000 && !!scopes.length && !!described.model;
  const startAi = () => { if (canStartAi) { setResultView('ai'); void described.start(query, scopes); } };
  const aiStale = !!described.run && (query !== described.run.description || described.run.scopes.length !== scopes.length || described.run.scopes.some(scope => !scopes.includes(scope)));
  const hasAiResults = !!described.run || described.starting || resultView === 'ai';
  const localResults = <section className="search-results" role="region" aria-label="搜索结果" aria-busy={loading}>
    {!scopes.length ? <p className="search-results-status" role="status">请选择至少一个搜索范围。</p> : Array.from(query).length > 256 && <p className="search-results-status" role="status">本地搜索最多支持 256 字，可使用 AI 查找。</p>}
    {!!scopes.length && !!query.trim() && loading && <p className="search-results-status" role="status">正在查找…</p>}
    {!!scopes.length && !!query.trim() && results && <><p className="search-results-status" role="status">{results.hits.length ? `找到 ${results.hits.length} 处已有内容` : results.incomplete ? '已检查部分未命中；尚有未索引内容，索引后再查。' : scopes.includes('knowledge') && results.status.unavailable > 0 ? '已检查范围无命中；部分知识内容暂不可搜索。' : '已检查范围无命中。'}{results.truncated && ' 结果较多，请补充关键词或缩小范围。'}{results.incomplete && results.hits.length > 0 && ' 仍有未索引内容。'}</p>
      {results.hits.map((hit, i) => <SearchHitCard key={`${hit.scope}:${hit.entityId}:${hit.field}:${i}`} hit={hit} locate={openHit} />)}
    </>}
  </section>;
  // The retained native input owns its live value. Index/result renders must not replace
  // a new browser edit with the previous query before its input event reaches React.
  return <PanelPortal id="search"><aside ref={panel} className="search-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="搜索课程" onKeyDown={event => {
    // Radix menus render in a portal: Escape belongs to the menu until it closes.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.key === 'Escape') { event.preventDefault(); show(false); }
    if (event.key === 'Tab' && narrow) {
      const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled):not([tabindex="-1"]), textarea:not(:disabled):not([tabindex="-1"]), select:not(:disabled):not([tabindex="-1"]), [role="checkbox"]:not([aria-disabled="true"]):not([tabindex="-1"]), summary')].filter(el => el.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  }}>
    <div className="search-heading"><h2>搜索课程</h2><Button variant="ghost" size="icon-sm" className="panel-close" aria-label="收起搜索" onClick={() => show(false)}><X size={18}/></Button></div>
    <InputGroup className="search-field" data-ai={aiMode || undefined} data-motion={aiMotion ? 'pointer' : undefined}>
      <span className="search-field-wash" aria-hidden="true" />
      <span className="search-field-light" aria-hidden="true" />
      <div className="search-field-main">
        <InputGroupTextarea ref={input} role="searchbox" rows={1} aria-label="查找已有内容" defaultValue={query} placeholder="搜索关键词、公式或描述" maxLength={4000} onInput={event => {
          const field = event.currentTarget; field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 100)}px`;
          setQuery(field.value); if (described.run || described.starting) setResultView('local');
        }} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (aiMode && !event.repeat) startAi(); }
        }} />
        <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={300}>
          <TooltipPrimitive.Root>
            <TooltipPrimitive.Trigger asChild>
              <InputGroupButton size="icon-sm" className="search-ai-toggle" aria-label="AI 检索" aria-pressed={aiMode} onClick={event => {
                const next = !aiMode, pointer = event.detail > 0;
                window.clearTimeout(controlsTimer.current);
                setAiMotion(pointer); setAiMode(next);
                if (next) setShowAiControls(true);
                else if (pointer && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) controlsTimer.current = window.setTimeout(() => setShowAiControls(false), 240);
                else setShowAiControls(false);
                if (next && !described.executor && !described.checking && described.online) void described.check();
                if (!next) setResultView('local');
                if (pointer) input.current?.focus();
              }}><Sparkles size={17} aria-hidden="true" /></InputGroupButton>
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content className="search-ai-tip" side="bottom" sideOffset={6} collisionPadding={10}>AI 检索</TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
      </div>
      <div className="search-controls-reveal" aria-hidden={!aiMode || undefined} inert={!aiMode}>
        <div className="search-controls-clip" onClick={event => { if (!(event.target as HTMLElement).closest('button')) input.current?.focus(); }}>
          {showAiControls && <DescriptionControls state={described} canStart={canStartAi} onStart={startAi} />}
        </div>
      </div>
    </InputGroup>
    {aiMode && <DescriptionFeedback state={described} showError={resultView !== 'ai'} />}
    {aiMode && Array.from(query).length > 2000 && <p className="search-error" role="status">AI 查找最多支持 2000 字。</p>}
    <fieldset className="search-scopes"><legend>搜索范围</legend><div className="search-scope-options">{searchScopes.map(scope => <label className="search-scope" key={scope} title={labels[scope]} data-checked={scopes.includes(scope) || undefined}><Checkbox className="search-scope-check" aria-label={labels[scope]} checked={scopes.includes(scope)} onCheckedChange={checked => { setScopes(current => checked === true ? [...current, scope] : current.filter(s => s !== scope)); if (described.run || described.starting) setResultView('local'); }}/><span>{shortLabels[scope]}</span></label>)}</div></fieldset>
    {status && (status.indexErrors.length > 0 || status.unreadable.length > 0 || status.noText.length > 0) && <div className="search-tools"><details className="search-coverage"><summary className="search-tool-summary"><CircleAlert size={16} aria-hidden="true"/><span>未覆盖与不可读内容</span><ChevronDown className="search-tool-chevron" size={15} aria-hidden="true"/></summary><div className="search-coverage-content">
      {status.indexErrors.map(p => <p key={`index:${p.entityId}`}>{p.title} 尚未索引：{p.reason}。已有内容仍可搜索。</p>)}
      {status.noText.map(p => <p key={p.entityId}>{p.title}：{p.reason}</p>)}
      {status.unreadable.map(p => <div key={`${p.scope}:${p.entityId}`}><p>{labels[p.scope]} · {p.title}：{p.reason}</p>{p.scope === 'sources' && <Button variant="outline" size="sm" onClick={() => { void (async () => {
        try { const { generation } = await window.yizhi.sources.list({ sessionId }); const repaired = await window.yizhi.sources.chooseRepair({ sessionId, generation, operationId: crypto.randomUUID(), versionId: p.entityId }); if (repaired) await rebuild(false, true); }
        catch (e) { setError((e as Error).message); }
      })(); }}>从原件修复此版本</Button>}</div>)}
    </div></details></div>}
    {error && <p role="alert" className="search-error">{error}</p>}
    {indexing && <p className="search-index" role="status">正在更新搜索结果…</p>}
    {hasAiResults ? <Tabs value={resultView} onValueChange={value => { if (value === 'local' || value === 'ai') setResultView(value); }}>
      <TabsList className="search-result-tabs" aria-label="搜索结果类型"><TabsTrigger value="local">本地结果</TabsTrigger><TabsTrigger value="ai">AI 结果</TabsTrigger></TabsList>
      <TabsContent value="local">{localResults}</TabsContent>
      <TabsContent value="ai"><DescriptionResults state={described} stale={aiStale} showCancel={!aiMode} locate={openHit} /></TabsContent>
    </Tabs> : localResults}
  </aside></PanelPortal>;
}
