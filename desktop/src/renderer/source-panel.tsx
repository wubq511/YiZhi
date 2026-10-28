import type { SearchHit } from '../search-api';
import { paintFrame } from './search-location';
import { forwardRef, useEffect, useLayoutEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SourcePage, SourceCitation, SourceReadingContext, SourceList, CiteSource, PrintedPage } from '../sources-api';
import { ParsingSection } from './parsing-section';
import { SourcePdf, type SourceSelection } from './source-pdf';
import './source-panel.css';

export interface SourceScene { open: boolean; context: SourceReadingContext | null }
export interface SourcePanelHandle { capture(): SourceScene; restore(scene: SourceScene): Promise<void>; openSearch(hit: SearchHit): Promise<void>; flush(): Promise<boolean>; openCitation(citation: SourceCitation): void; openVersion(versionId: string, pdfPageIndex: number): void }
export const SourcePanel = forwardRef<SourcePanelHandle, { sessionId: string; narrow: boolean; target?: CiteSource['target']; onOpenChange(open: boolean): void; onCitationsChange(citations: SourceCitation[]): void; onQuestion?(citation: SourceCitation): void }>(function SourcePanel({ sessionId, narrow, target, onOpenChange, onCitationsChange, onQuestion }, ref) {
  const api = window.yizhi.sources;
  const [open, setOpen] = useState(false), [list, setList] = useState<SourceList>({ generation: 1, versions: [], intents: [], readingSeq: 0 });
  const [initialized, setInitialized] = useState(false);
  const [versionId, setVersionId] = useState(''), [pageIndex, setPageIndex] = useState(0), [scale, setScale] = useState(1.2);
  const [page, setPage] = useState<SourcePage>(), [citations, setCitations] = useState<SourceCitation[]>([]);
  const [selection, setSelection] = useState<SourceSelection | null>(null), [regionMode, setRegionMode] = useState(false);
  const [searchHit, setSearchHit] = useState<SearchHit>();
  const [activeCitation, setActiveCitation] = useState<SourceCitation | null>(null);
  const [ready, setReady] = useState(false), [reload, setReload] = useState(0), [printed, setPrinted] = useState('');
  const [printedTarget, setPrintedTarget] = useState(''), [printedMatches, setPrintedMatches] = useState<PrintedPage[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [renderError, setRenderError] = useState(''), [message, setMessage] = useState('');
  const [contextStatus, setContextStatus] = useState<'saved' | 'pending' | 'error'>('saved');
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null), scroller = useRef<HTMLDivElement>(null);
  const context = useRef<SourceReadingContext | null>(null), seq = useRef(0), writes = useRef(Promise.resolve());
  const failed = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), restored = useRef(false);
  const retryAction = useRef<(() => Promise<void>) | null>(null), actionInFlight = useRef(false);
  const version = list.versions.find(item => item.versionId === versionId);
  const refresh = async () => { const next = await api.list({ sessionId }); setList(next); return next; };
  useEffect(() => {
    let active = true;
    void Promise.all([api.list({ sessionId }), api.context({ sessionId }), api.citations({ sessionId })]).then(([next, saved, quotes]) => {
      if (!active) return;
      setList(next); seq.current = next.readingSeq; setCitations(quotes); onCitationsChange(quotes); setInitialized(true);
      if (saved) { context.current = saved; setVersionId(saved.versionId); setPageIndex(saved.pdfPageIndex); setScale(saved.scale); setOpen(saved.open); }
      else if (next.versions.length) setVersionId(next.versions.at(-1)!.versionId);
    }).catch(error => { if (active) { setError(error.message); setInitialized(true); } });
    return () => { active = false; clearTimeout(timer.current); };
  }, [sessionId]);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    onOpenChange(open);
    if (open) panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (wasOpen.current) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
    wasOpen.current = open;
  }, [open]);
  const saveLatest = async () => {
    clearTimeout(timer.current);
    const current = context.current;
    if (!current || failed.current) return;
    const inputSeq = ++seq.current, generation = list.generation;
    writes.current = writes.current.then(async () => {
      if (failed.current) return;
      try { await api.saveContext({ sessionId, generation, seq: inputSeq, state: current }); if (context.current === current) setContextStatus('saved'); }
      catch { failed.current = true; setContextStatus('error'); }
    });
    await writes.current;
  };
  const persist = (next: SourceReadingContext) => {
    context.current = next;
    if (failed.current) return;
    setContextStatus('pending'); clearTimeout(timer.current); timer.current = setTimeout(() => void saveLatest(), 200);
  };
  const flush = async () => { await saveLatest(); await writes.current; return !failed.current && !actionInFlight.current; };
  useImperativeHandle(ref, () => ({ flush, openCitation, openVersion: (id: string, index: number) => { setOpen(true); void run(async () => { await refresh(); choose(id,index); }); },
    capture: () => ({ open, context: context.current ? { ...context.current, scrollTop: scroller.current?.scrollTop ?? context.current.scrollTop, scrollLeft: scroller.current?.scrollLeft ?? context.current.scrollLeft } : null }),
    async restore(scene) {
      if (!await flush()) throw new Error('原文位置尚未保存');
      setSearchHit(undefined); setOpen(scene.open);
      if (scene.context) { choose(scene.context.versionId, scene.context.pdfPageIndex, scene.context.scale); persist(scene.context); }
      else if (context.current) persist({ ...context.current, open: false });
      await paintFrame();
    },
    async openSearch(hit) {
      if (!await flush()) throw new Error('原文位置尚未保存');
      await refresh(); setOpen(true); choose(hit.versionId!, hit.pdfPageIndex!); setSearchHit(hit);
    }
  }));
  const run = async (action: () => Promise<void>) => {
    if (actionInFlight.current) return;
    retryAction.current = action; actionInFlight.current = true; setBusy(true); setError('');
    try { await action(); retryAction.current = null; }
    catch (error) { setError((error as Error).message); }
    finally { actionInFlight.current = false; setBusy(false); }
  };
  const choose = (id: string, index = 0, nextScale = scale) => {
    setSearchHit(undefined); setVersionId(id); setPageIndex(index); setScale(nextScale); setSelection(null); setReady(false); setRegionMode(false); setActiveCitation(null); setPage(undefined); restored.current = false;
    setReload(value => value + 1);
    persist({ open: true, versionId: id, pdfPageIndex: index, scrollTop: 0, scrollLeft: 0, scale: nextScale, target: context.current?.target ?? target });
  };
  function openCitation(citation: SourceCitation) { setOpen(true); choose(citation.versionId, citation.pdfPageIndex); setActiveCitation(citation); }
  const importSource = (sourceId?: string) => {
    const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), sourceId };
    void run(async () => {
      const result = await api.chooseImport(request);
      if (!result) return;
      await refresh(); choose(result.version.versionId); setMessage('资料版本已保存。是否根据它更新画板，由你决定。');
    });
  };
  useEffect(() => {
    if (!open || !version) return;
    let active = true; setReady(false); setPage(undefined); setRenderError(''); setSelection(null); restored.current = false;
    void api.page({ sessionId, versionId, pdfPageIndex: pageIndex }).then(result => { if (active) { setPage(result); setPrinted(''); } }).catch(error => { if (active) setRenderError(error.message); });
    return () => { active = false; };
  }, [open, versionId, pageIndex, reload]);
  const pageReady = (position?: { x: number; y: number }) => {
    setReady(true);
    requestAnimationFrame(() => {
      if (scroller.current) {
        scroller.current.scrollTop = position ? Math.max(0, position.y - 60) : context.current?.scrollTop ?? 0;
        scroller.current.scrollLeft = position ? Math.max(0, position.x - 60) : context.current?.scrollLeft ?? 0;
        if (position && context.current) persist({ ...context.current, scrollTop: scroller.current.scrollTop, scrollLeft: scroller.current.scrollLeft });
      }
      requestAnimationFrame(() => { restored.current = true; });
    });
  };
  const close = async () => {
    const previous = context.current;
    if (context.current) persist({ ...context.current, open: false });
    if (!await flush()) { if (previous) context.current = { ...previous, open: true }; return; }
    setOpen(false);
  };
  const intent = [...list.intents].reverse().find(item => item.versionId === versionId);
  return <><button ref={trigger} disabled={!initialized} className="source-launcher" aria-expanded={open} onClick={() => {
    setReady(false); setOpen(true);
    void run(async () => {
      const next = await refresh();
      if (versionId) persist({ ...(context.current ?? { scrollTop: 0, scrollLeft: 0 }), open: true, versionId, pdfPageIndex: pageIndex, scale, target });
      else if (next.versions.length) choose(next.versions.at(-1)!.versionId);
    });
  }}>原文资料</button>{open && createPortal(<aside ref={panel} className="source-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="原文资料" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    if (event.key === 'Tab' && narrow) {
      const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0);
      if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0]?.focus(); }
    }
  }}>
    <div className="source-heading"><h2>原文资料</h2><button onClick={() => void close()}>返回画板</button></div>
    <div className="source-controls"><button disabled={busy} onClick={() => importSource()}>导入资料</button>
      {version && <button disabled={busy} onClick={() => importSource(version.sourceId)}>导入此来源新版</button>}
      {list.versions.length ? <label>资料版本<select aria-label="资料版本" disabled={busy} value={versionId} onChange={event => choose(event.target.value)}>{list.versions.map((item, i) => <option key={item.versionId} value={item.versionId}>{item.title} · 版本 {i + 1}</option>)}</select></label> : <p>导入 PDF 或图片，保留原件后再核对出处。</p>}
    </div>
    {version && <><div className="source-update"><p>{intent?.decision === 'defer' ? '已选择暂不更新，画板及旧引用保持原样。' : intent?.decision === 'update' ? '已记录更新意图，尚未执行画板修改。' : message || '导入不会自动改写画板。'}</p>
      <button disabled={busy} onClick={() => { const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), versionId, decision: 'update' as const }; void run(async () => { await api.setUpdateIntent(request); await refresh(); }); }}>根据新版更新</button>
      <button disabled={busy} onClick={() => { const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), versionId, decision: 'defer' as const }; void run(async () => { await api.setUpdateIntent(request); await refresh(); }); }}>暂不更新</button></div>
      <div className="source-pagination"><button disabled={busy || pageIndex === 0} onClick={() => choose(versionId, pageIndex - 1)}>上一页</button>
        <label>{version.mediaType === 'application/pdf' ? 'PDF 页序' : '图片'}<input aria-label="PDF 页序" type="number" min="1" max={version.pdfPages || 1} value={pageIndex + 1} onChange={event => { const next = Number(event.target.value) - 1; if (Number.isSafeInteger(next) && next >= 0 && next < (version.pdfPages || 1)) choose(versionId, next); }} /> / {version.pdfPages || 1}</label>
        <button disabled={busy || pageIndex + 1 >= (version.pdfPages || 1)} onClick={() => choose(versionId, pageIndex + 1)}>下一页</button>
        <label>缩放<select aria-label="原页缩放" value={scale} onChange={event => choose(versionId, pageIndex, Number(event.target.value))}><option value={0.75}>75%</option><option value={1.2}>120%</option><option value={1.75}>175%</option><option value={2.5}>250%</option></select></label></div>
      <div className="source-page-map"><span>印刷页：{page?.printedPage?.label ?? '未核对'}</span>
        <input aria-label="已核对的印刷页" placeholder="看原页核对后填写" value={printed} maxLength={200} onChange={event => setPrinted(event.target.value)} />
        <button disabled={busy || !ready || !printed.trim()} onClick={() => { const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), versionId, pdfPageIndex: pageIndex, printedPage: printed }; void run(async () => { const mapping = await api.mapPrintedPage(request); setPage(previous => previous && ({ ...previous, printedPage: mapping })); }); }}>登记印刷页</button></div>
      <details className="source-print-navigation"><summary>按已核对的印刷页定位</summary><input aria-label="前往印刷页" value={printedTarget} onChange={event => setPrintedTarget(event.target.value)} placeholder="输入已核对的页码" /><button disabled={busy || !printedTarget.trim()} onClick={() => void run(async () => {
        const matches = await api.locatePrintedPage({ sessionId, versionId, printedPage: printedTarget }); setPrintedMatches(matches);
        if (matches.length === 1) choose(versionId, matches[0].pdfPageIndex);
        else if (!matches.length) throw new Error('尚未登记此印刷页，请按 PDF 页序定位并核对；不会推算页码偏移。');
      })}>前往印刷页</button>{printedMatches.length > 1 && <p>同名印刷页有多处，请选择：{printedMatches.map(match => <button key={match.id} onClick={() => choose(versionId, match.pdfPageIndex)}>PDF 第 {match.pdfPageIndex + 1} 页</button>)}</p>}</details>
      {activeCitation?.printedPage && <p>原引用印刷页：{activeCitation.printedPage.label}（保留引用时的核对记录）</p>}
    </>}
    {version && <ParsingSection key={versionId} sessionId={sessionId} generation={list.generation} source={version} onSource={index => { choose(versionId,index); setReload(n=>n+1); requestAnimationFrame(()=>scroller.current?.scrollIntoView({block:'center'})); }} />}
    <div role="status" aria-label="原文状态" aria-live="polite" className="source-status">{busy ? '正在保存资料…' : renderError ? '原页暂不可读' : ready ? '原页已载入' : version ? '正在读取本地原页…' : '尚未导入资料'}</div>
    {error && <div role="alert" className="source-error"><p>{error}</p>{retryAction.current && <button disabled={busy} onClick={() => retryAction.current && void run(retryAction.current)}>重试资料操作</button>}</div>}
    {renderError && <div role="alert" className="source-error"><p>该来源暂不可读：{renderError}。画板正文仍可阅读。</p><button onClick={() => setReload(value => value + 1)}>重试原页</button><button disabled={busy} onClick={() => {
      const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), versionId };
      void run(async () => { if (await api.chooseRepair(request)) setReload(value => value + 1); });
    }}>从原件修复此版本</button></div>}
    <div ref={scroller} className="source-scroll" tabIndex={0} aria-label="原页阅读区" onScroll={event => {
      if (!restored.current || !context.current || !ready) return;
      persist({ ...context.current, scrollTop: event.currentTarget.scrollTop, scrollLeft: event.currentTarget.scrollLeft });
    }}>{page && version && <SourcePdf sessionId={sessionId} version={version} page={page} scale={scale} regionMode={regionMode} citation={activeCitation} searchHit={searchHit} onSelection={setSelection} onReady={pageReady} onError={error => setRenderError(error.message)} />}</div>
    {page && version && <div className="source-selection"><p>{page.projection.text.length ? '选取实际文本层中的文字，或拖动框选原页区域。' : '本页没有可靠文本层。可保留实际原页或框选区域，不会生成精确选文。'}</p>
      <button disabled={!ready || busy} aria-pressed={regionMode} onClick={() => { setRegionMode(!regionMode); setSelection(null); }}>选取页面区域</button>
      <button disabled={!ready || busy} onMouseDown={event => event.preventDefault()} onClick={() => {
        const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), versionId, pdfPageIndex: pageIndex, target: context.current?.target ?? target, ...selection };
        void run(async () => { await api.cite(request); const next = await api.citations({ sessionId }); setCitations(next); onCitationsChange(next); setMessage('原文与出处已保留，可从下方打开固定版本。'); });
      }}>{selection?.start !== undefined ? '保留选文与出处' : selection?.region ? '保留选区出处' : '保留本页出处'}</button>
      {onQuestion && <button disabled={busy || !ready} onClick={() => {
        const request = { sessionId, generation: list.generation, operationId: crypto.randomUUID(), versionId, pdfPageIndex: pageIndex, target: context.current?.target ?? target, ...selection };
        void run(async () => {
          const citation = await api.cite(request); const next = await api.citations({ sessionId }); setCitations(next); onCitationsChange(next);
          if (narrow) { if (context.current) persist({ ...context.current, open: false }); setOpen(false); }
          onQuestion(citation);
        });
      }}>带此选段向 Agent 提问</button>}
    </div>}
    {searchHit && <blockquote className="source-search-quote">搜索原文：{searchHit.quote}</blockquote>}
    <div className="source-context-status" role="status" aria-label="原文位置保存">{contextStatus === 'saved' ? '原文位置已保存' : contextStatus === 'pending' ? '正在保存原文位置' : '原文位置未保存'}{contextStatus === 'error' && <button onClick={() => { failed.current = false; setContextStatus('pending'); void saveLatest(); }}>重试保存原文位置</button>}</div>
    <details className="source-citations" open={!!citations.length}><summary>保留的原文与出处 · {citations.length}</summary>{citations.map(citation => <section key={citation.id}>
      {citation.quote ? <blockquote>{citation.quote}</blockquote> : <p>{citation.textStatus === 'no-text-layer' ? '无可靠文本层 · ' : ''}{citation.region ? '原页选区' : '整页出处'}</p>}
      <p>{list.versions.find(item => item.versionId === citation.versionId)?.title} · PDF 第 {citation.pdfPageIndex + 1} 页 · 印刷页 {citation.printedPage?.label ?? '未核对'}</p>
      <button onClick={() => openCitation(citation)}>打开引用原页</button>{onQuestion && <button onClick={() => { if (narrow) setOpen(false); onQuestion(citation); }}>带此出处提问</button>}
    </section>)}</details>
    {version && <details className="source-identity"><summary>版本身份与原件摘要</summary><p>{version.originalName} · {version.importedAt}</p><p>版本 {version.versionId}</p><p>SHA-256 {version.sha256}</p><p>{version.byteLength} bytes · {version.mediaType}</p></details>}
  </aside>, document.body)}</>;
});

export function SourceReferences({ citations, onOpen }: { citations: SourceCitation[]; onOpen(citation: SourceCitation): void }) {
  if (!citations.length) return null;
  return <section className="source-references" aria-label="正文来源引用"><h3>原文出处</h3>{citations.map(citation => <p key={citation.id}>
    {citation.quote ? `“${citation.quote}”` : citation.region ? '原页选区' : '原页'} · PDF 第 {citation.pdfPageIndex + 1} 页 · 印刷页 {citation.printedPage?.label ?? '未核对'}{' '}
    <button onClick={() => onOpen(citation)}>核对来源原页</button>
  </p>)}</section>;
}
