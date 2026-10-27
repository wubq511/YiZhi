import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ReactFlow, ReactFlowProvider, MiniMap, useReactFlow, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createRoot } from 'react-dom/client';
import katex from 'katex';
import rough from 'roughjs';
import 'katex/dist/katex.min.css';
import './style.css';
import type { CourseGraph, CourseUnit, DesktopBridge, OpenedCourse, ReadingBlock, ReadingState } from '../shared';
import { ParagraphSaveChannel, type SaveState } from './save-channel';
import { ControlledProducer } from './controlled-producer';
declare global { interface Window { yizhi: DesktopBridge } }

function RoughFrame({ id }: { id: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    if (!svg || !svg.parentElement) return;
    const parent = svg.parentElement;
    const draw = () => {
      const width = parent.clientWidth, height = parent.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.replaceChildren(rough.svg(svg).rectangle(3, 3, width - 6, height - 6, { seed: [...id].reduce((n, c) => n + c.charCodeAt(0), 1), stroke: '#7798bc', strokeWidth: 1.5, roughness: 1.45 }));
    };
    const observer = new ResizeObserver(draw); observer.observe(parent); draw();
    return () => observer.disconnect();
  }, [id]);
  return <svg ref={ref} className="rough-frame" aria-hidden="true" />;
}

function Mux({ payload }: { payload: Record<string, any> }) {
  const [bits, setBits] = useState<Record<string, number>>(payload.inputs);
  const index = bits.S1 * 2 + bits.S0;
  const signals: string[] = payload.config.dataSignals;
  const signal = signals[index];
  const output = signal === '0' || signal === '1' ? Number(signal) : signal.startsWith('¬') ? 1 - bits[signal.slice(1)] : bits[signal];
  return <section className="mux"><h3>{payload.title ?? '交互 · 多路选择'}</h3><p>选择端决定输出的数据端。</p>
    {Object.keys(bits).map(name => <label key={name}><input type="checkbox" checked={!!bits[name]} onChange={event => setBits({ ...bits, [name]: Number(event.target.checked) })} />{name} = {bits[name]}</label>)}
    <p role="status" aria-label="MUX 输出">输出 {payload.bindings?.output ?? 'Z'} = {output}</p></section>;
}

function Block({ block, onReference, reading, updateReading }: { block: ReadingBlock; onReference: (id: string, blockId: string) => void; reading: ReadingState | null; updateReading: (key: string, value: boolean) => void }) {
  const payload = block.payload;
  const children = block.children?.map(child => <Block key={child.id} block={child} onReference={onReference} reading={reading} updateReading={updateReading} />);
  if (block.kind === 'paragraph') return <p>{payload.text}</p>;
  if (block.kind === 'formula') return <div className="formula" role="math" aria-label={payload.latex}
    dangerouslySetInnerHTML={{ __html: katex.renderToString(payload.latex, { throwOnError: false, trust: false, displayMode: true }) }} />;
  if (block.kind === 'table') return <div className="table-scroll" tabIndex={0} aria-label="数制对照表"><table>
    <thead><tr>{payload.columns.map((column: string, i: number) => <th key={i}>{column}</th>)}</tr></thead>
    <tbody>{payload.rows.map((row: (string | number)[], i: number) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
  if (block.kind === 'callout') return <aside className="reminder"><p>{payload.text}</p>{children}</aside>;
  if (block.kind === 'steps') return <ol>{payload.items.map((item: string, i: number) => <li key={i}>{item}</li>)}{children}</ol>;
  if (block.kind === 'example' || block.kind === 'exercise') return <details className="material" open={reading?.expanded[block.id] ?? true} onToggle={event => updateReading(block.id, event.currentTarget.open)}>
    <summary>{payload.title}</summary><p>{payload.problem}</p>
    {payload.hint && <details className="hint" open={reading?.expanded[block.id + ":hint"] ?? false} onToggle={event => updateReading(block.id + ":hint", event.currentTarget.open)}><summary>学习提示</summary><p>{payload.hint}</p></details>}
    {block.kind === 'exercise' ? <details className="answer" open={reading?.expanded[block.id + ":answer"] ?? false} onToggle={event => updateReading(block.id + ":answer", event.currentTarget.open)}><summary>答案与步骤</summary>{children}</details> : children}
  </details>;
  if (block.kind === 'interactive' && payload.component === 'mux') return <Mux payload={payload} />;
  if (block.kind === 'figure' && payload.asset) return <figure><img src="./ti74153-1.png" alt={payload.alt} /><figcaption>{payload.caption}</figcaption></figure>;
  if (block.kind === 'figure' && payload.config?.nodes) return <figure><figcaption>{payload.alt}</figcaption><svg viewBox="0 0 640 250" role="img" aria-label={payload.alt}>{payload.config.edges.map((edge: any, index: number) => { const a = payload.config.nodes.find((node: any) => node.id === edge.from), b = payload.config.nodes.find((node: any) => node.id === edge.to); return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#7798bc" />; })}{payload.config.nodes.map((node: any) => <g key={node.id}><rect x={node.x - 45} y={node.y - 20} width="90" height="40" fill="white" stroke="#7798bc" /><text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle" fontSize="13">{node.label}</text></g>)}</svg><figcaption>{payload.config.caption}</figcaption></figure>;
  if (block.kind === 'knowledge-reference') return <p className="reference">{payload.intent}<br/><button onClick={() => onReference(payload.targetUnitId, block.id)}>前往 {payload.targetUnitId}</button></p>;
  return <details><summary>保留的内容 · {block.kind}</summary><pre>{JSON.stringify(payload, null, 2)}</pre>{children}</details>;
}

function App() {
  const flow = useReactFlow();
  const boardRef = useRef<HTMLElement>(null);
  const [nodesReady, setNodesReady] = useState(false);
  const [graph, setGraph] = useState<CourseGraph>();
  const [selected, setSelected] = useState<CourseUnit>();
  const [mounted, setMounted] = useState<CourseUnit[]>([]);
  const [readError, setReadError] = useState<string>();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 0.1 });
  const [directory, setDirectory] = useState(true);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches);
  const directoryButton = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => { const media = matchMedia('(max-width: 760px)'); const update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => { if (narrow && directory) navRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [narrow, directory]);
  const closeDirectory = () => { setDirectory(false); requestAnimationFrame(() => directoryButton.current?.focus()); };
  const trap = (event: KeyboardEvent<HTMLElement>, close: () => void) => {
    if (!narrow) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button, select, input, [tabindex]:not([tabindex="-1"])')].filter(item => !item.hasAttribute('disabled'));
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
  };
  const [minimap, setMinimap] = useState(true);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const relationButton = useRef<HTMLButtonElement>(null);
  const relationPanel = useRef<HTMLElement>(null);
  const closeRelations = () => { setRelationsOpen(false); requestAnimationFrame(() => relationButton.current?.focus()); };
  useEffect(() => { if (narrow && relationsOpen) relationPanel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [narrow, relationsOpen]);
  const [relationView, setRelationView] = useState("main");
  const [course, setCourse] = useState<OpenedCourse>();
  const [loadError, setLoadError] = useState<string>();
  const [state, setState] = useState<SaveState>({ status: 'saved' });
  const [closing, setClosing] = useState(false);
  const [producerBusy, setProducerBusy] = useState(false);
  const producerRunning = useRef(false);
  const channel = useRef<ParagraphSaveChannel | undefined>(undefined);
  const editor = useRef<HTMLDivElement>(null);
  const editedText = useRef<string | undefined>(undefined);
  const [reading, setReading] = useState<ReadingState | null>(null);
  const readingRef = useRef<ReadingState | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const restored = useRef(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const persist = (next: ReadingState) => {
    readingRef.current = next; setReading(next);
    if (course) writes.current = writes.current.then(() => window.yizhi.setReadingState(course.sessionId, next)).catch(error => { setReadError(`阅读位置未保存：${error.message}`); });
  };
  const updateReading = (key: string, value: boolean) => {
    const current = readingRef.current;
    if (current && (current.expanded[key] ?? (key.endsWith(':hint') || key.endsWith(':answer') ? false : true)) !== value)
      persist({ ...current, expanded: { ...current.expanded, [key]: value } });
  };
  const composing = useRef(false);
  const load = async () => {
    setLoadError(undefined);
    try {
      const opened = await window.yizhi.open();
      channel.current = new ParagraphSaveChannel(window.yizhi, opened, setState);
      setCourse(opened);
      const [loadedGraph, savedReading] = await Promise.all([window.yizhi.graph(opened.sessionId), window.yizhi.readingState(opened.sessionId)]);
      setGraph(loadedGraph); readingRef.current = savedReading; restored.current = false; setReading(savedReading);
    } catch (error) { setLoadError((error as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => window.yizhi.onCloseRequested(async () => {
    if (producerRunning.current) return false;
    if (composing.current) {
      setState({ status: 'error', error: '请先完成中文候选输入，再关闭窗口。' });
      return false;
    }
    // A failed course open owns no editable input and must still allow normal exit.
    if (!channel.current) return true;
    setClosing(true);
    await writes.current;
    const saved = await channel.current.flush();
    if (!saved) setClosing(false);
    return saved;
  }), []);
  useEffect(() => {
    if (course && editor.current && !editor.current.dataset.initialized) { editor.current.textContent = editedText.current ?? String(course.unit.reading.blocks[0].payload.text); editor.current.dataset.initialized = "yes"; }
  }, [course, selected]);
  const go = async (id: string, nextState?: ReadingState) => {
    if (!course || !graph) return;
    const position = graph.layout.nodes.find(node => node.unitId === id);
    if (!position) return;
    setReadError(undefined);
    try { const unit = await window.yizhi.readUnit(course.sessionId, id); persist(nextState ?? { ...(readingRef.current ?? { expanded: {}, returnStack: [], scrollTop: 0 }), unitId: id, scrollTop: 0 }); setSelected(unit); setMounted(previous => previous.some(item => item.id === id) ? previous : [...previous.filter(item => item.id === 'KU-001'), unit]); }
    catch (error) { setSelected(undefined); setReadError((error as Error).message); }
    if (nextState?.camera) await flow.setViewport(nextState.camera, { duration: 0 });
    else await flow.setCenter(position.x + 325, position.y + 250, { zoom: 0.85, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 });
  };
  useEffect(() => {
    if (!course || !graph || !nodesReady || restored.current) return;
    restored.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (reading) void go(reading.unitId, reading); else void flow.fitView({ duration: 0 }); }));
  }, [course, graph, reading, nodesReady]);
  useEffect(() => {
    if (selected && reading?.unitId === selected.id && articleRef.current) articleRef.current.scrollTop = reading.scrollTop;
  }, [selected?.id]);
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const wheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.reading-layer') || target.closest('.table-scroll, input, select, textarea, .mux')) return;
      event.preventDefault(); event.stopPropagation();
      const current = flow.getViewport();
      if (event.ctrlKey || event.metaKey) {
        const rect = board.getBoundingClientRect(); const px = event.clientX - rect.left, py = event.clientY - rect.top;
        const zoom = Math.max(.04, Math.min(2, current.zoom * Math.exp(-event.deltaY * .002)));
        const ratio = zoom / current.zoom;
        void flow.setViewport({ x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio, zoom });
      } else void flow.setViewport({ ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX), y: current.y - (event.shiftKey ? 0 : event.deltaY) });
    };
    board.addEventListener('wheel', wheel, { passive: false });
    return () => board.removeEventListener('wheel', wheel);
  }, [flow]);
  const nodes = useMemo(() => graph ? [
    ...graph.layout.groups.map(group => ({ id: group.themeId, position: { x: group.x, y: group.y }, data: { label: group.title }, style: { width: group.width, height: group.height, fontSize: 50, border: "1px solid #bbc9d5", background: "#fff", opacity: viewport.zoom < 0.35 ? 1 : 0.35 }, selectable: false, draggable: false })),
    ...graph.nodes.map(node => { const pos = graph.layout.nodes.find(item => item.unitId === node.id)!; return { id: node.id, position: { x: pos.x, y: pos.y }, data: { label: node.name }, style: { width: pos.width, height: pos.height, opacity: viewport.zoom >= 0.35 ? 1 : 0, pointerEvents: viewport.zoom >= 0.35 ? "auto" as const : "none" as const }, draggable: false }; })
  ] : [], [graph, viewport.zoom]);
  const edges = useMemo(() => {
    if (!graph) return [];
    const visible = graph.edges.filter(edge => relationView === 'all' || edge.view === relationView);
    if (viewport.zoom >= 0.35) return visible.map(edge => ({ id: edge.id, source: edge.fromUnitId, target: edge.toUnitId, label: edge.type, animated: false }));
    const groups = new Map<string, { source: string; target: string; count: number }>();
    for (const edge of visible) {
      const source = graph.nodes.find(node => node.id === edge.fromUnitId)?.themeId;
      const target = graph.nodes.find(node => node.id === edge.toUnitId)?.themeId;
      if (!source || !target || source === target) continue;
      const key = `${source}:${target}`;
      const group = groups.get(key) ?? { source, target, count: 0 }; group.count++; groups.set(key, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, source: group.source, target: group.target, label: `${group.count} 条已有关系`, animated: false }));
  }, [graph, relationView, viewport.zoom]);
  const status = { saved: '已保存', pending: '待保存', saving: '正在保存…', error: '未保存' }[state.status];
  return <>
    <header className="app-header" inert={narrow && (directory || relationsOpen)}><strong className="brand">绎知</strong><span>数字逻辑 · 期中复习</span>
      {course && <ControlledProducer course={course} prepare={async () => {
        if (composing.current) throw new Error('请先完成中文候选输入，再运行可控修改。');
        producerRunning.current = true; setProducerBusy(true);
        if (!await channel.current?.flush()) throw new Error('学生输入尚未保存，请先重试保存。');
      }} committed={async () => {
        const current = await window.yizhi.open();
        channel.current = new ParagraphSaveChannel(window.yizhi, current, setState);
        setCourse(current);
        editedText.current = String(current.unit.reading.blocks[0].payload.text);
        if (editor.current) editor.current.textContent = editedText.current;
        setMounted(previous => previous.map(item => item.id === current.unit.id ? current.unit : item));
      }} settled={() => { producerRunning.current = false; setProducerBusy(false); }} />}
      <div className="save-area"><span role="status" aria-label="保存状态" aria-live="polite" className={state.status}>{course ? status : '正在打开课程…'}</span>

        {state.status === 'error' && <button onClick={() => void channel.current?.flush()}>重试保存</button>}
      </div>
    </header>
    {state.error && <div className="save-error" role="alert">{state.error} 输入仍保留，请重试保存。</div>}
    <div className="workspace board-workspace">
      {directory && <nav ref={navRef} inert={narrow && relationsOpen} aria-label="课程目录" onKeyDown={event => trap(event, closeDirectory)}><h2>课程目录</h2>{narrow && <button onClick={closeDirectory}>关闭目录</button>}{graph?.groups.map(group => <div key={group.id}><button className="directory-theme" onClick={() => { const first = graph.nodes.find(node => node.themeId === group.id); if (first) void go(first.id); }}>{group.name}</button>{selected?.theme.id === group.id && graph.nodes.filter(node => node.themeId === group.id).map(node => <button className="directory-unit" key={node.id} onClick={() => void go(node.id)}>{node.name}</button>)}</div>)}</nav>}
      <main ref={boardRef} className="board" aria-label="知识画板" role="region" inert={narrow && directory}>
        <div className="board-background" inert={narrow && relationsOpen}><ReactFlow nodes={nodes} edges={edges} onInit={() => setNodesReady(true)} minZoom={0.04} maxZoom={2} nodesDraggable={false} panOnScroll zoomOnScroll={false} zoomOnPinch panOnDrag onMove={(_event, next) => setViewport(next)} onMoveEnd={(_event, next) => { const current = readingRef.current; if (current) persist({ ...current, camera: next }); }} onNodeClick={(_event, node) => { const first = graph?.nodes.find(item => item.id === node.id || item.themeId === node.id); if (first) void go(first.id); }}>
          {minimap && <MiniMap ariaLabel="小地图" nodeColor="#7798bc" nodeStrokeColor="#345d88" maskColor="rgba(105,101,219,.12)" pannable zoomable />}
        </ReactFlow>
        <div className="board-tools">{reading?.returnStack.length ? <button onClick={() => { const previous = reading.returnStack[reading.returnStack.length - 1]; void go(previous.unitId, { ...reading, unitId: previous.unitId, scrollTop: previous.scrollTop, camera: previous.camera, returnStack: reading.returnStack.slice(0, -1) }); }}>返回引用位置</button> : null}<button ref={directoryButton} onClick={() => setDirectory(!directory)}>{directory ? '收起目录' : '展开目录'}</button><button onClick={() => setMinimap(!minimap)}>{minimap ? '收起小地图' : '展开小地图'}</button><button onClick={() => void flow.fitView({ duration: 0 })}>全图</button><button ref={relationButton} onClick={() => setRelationsOpen(!relationsOpen)}>{relationsOpen ? "关闭关系" : "查看关系"}</button><label>关系 <select aria-label="关系范围" value={relationView} onChange={event => setRelationView(event.target.value)}><option value="main">主关系</option><option value="auxiliary">辅助关系</option><option value="all">全部关系</option></select></label></div>
        {loadError && <div className="load-error" role="alert"><h1>课程未打开</h1><p>{loadError}</p><button onClick={() => void load()}>重新打开课程</button></div>}
        {readError && <div className="read-error" role="status">{readError}</div>}
        {course && mounted.map(unit => { const position = graph?.layout.nodes.find(node => node.unitId === unit.id); if (!position) return null; return <div key={unit.id} className="reading-layer" style={{ transform: `translate(${viewport.x + position.x * viewport.zoom}px, ${viewport.y + position.y * viewport.zoom}px) scale(${viewport.zoom})`, visibility: viewport.zoom >= 0.55 && selected?.id === unit.id ? 'visible' : 'hidden' }}>
          <article id="unit" ref={element => { if (selected?.id === unit.id) articleRef.current = element; }} onScroll={event => { const current = readingRef.current; if (current && current.unitId === unit.id && Math.abs(current.scrollTop - event.currentTarget.scrollTop) > 2) persist({ ...current, scrollTop: event.currentTarget.scrollTop }); }} className="nodrag nopan nowheel"><RoughFrame id={unit.id} />
            <h1>{unit.name}</h1><p className="unit-meta">课程重要性 {unit.rating.stars} / 5 · {unit.id}</p><p className="outcome">{unit.outcome}</p>
            {unit.id === 'KU-001' && <div className="editable-section"><label id="editor-label">首段正文 <span>可直接编辑，自动保存</span></label><div ref={editor} role="textbox" aria-label="编辑首段正文" aria-multiline="true" contentEditable={!closing && !producerBusy} suppressContentEditableWarning className="paragraph-editor" onInput={event => { editedText.current = event.currentTarget.innerText; if (!composing.current) channel.current?.input(event.currentTarget.innerText); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; editedText.current = event.currentTarget.innerText; channel.current?.input(event.currentTarget.innerText); }} /></div>}
            {unit.reading.blocks.slice(unit.id === 'KU-001' ? 1 : 0).map(block => <Block key={block.id} block={block} reading={reading} updateReading={updateReading} onReference={(id, blockId) => { const current = readingRef.current!; void go(id, { ...current, unitId: id, scrollTop: 0, camera: undefined, returnStack: [...current.returnStack, { unitId: unit.id, blockId, scrollTop: 0, camera: flow.getViewport() }] }); }} />)}

            <footer>来源：既有数字逻辑课程单元的独立副本。编辑保留原有知识身份。</footer>
          </article>
        </div>; })}</div>
        {relationsOpen && graph && <aside ref={relationPanel} className="relations-panel" role={narrow ? "dialog" : undefined} aria-modal={narrow || undefined} aria-label="关系详情" onKeyDown={event => trap(event, closeRelations)}><h2>关系详情</h2><button onClick={closeRelations}>关闭关系详情</button><p>前置条件中，未分组的项目全部必要；路线组按指定规则选择。</p>
          {relationView !== 'auxiliary' && graph.requirementGroups.map(group => <section key={group.id}><h3>{graph.nodes.find(n => n.id === group.targetUnitId)?.name} · 前置条件</h3>{(graph.conditions[group.targetUnitId]?.required ?? []).map(id => <p key={id}>{id}：{graph.nodes.find(n => n.id === id)?.name}</p>)}<p>{group.mode === 'any' ? '任选一条' : '全部需要'}：{group.unitIds.map(id => `${id} ${graph.nodes.find(n => n.id === id)?.name}`).join(' 或 ')}</p><p>{group.value}</p></section>)}
          {graph.edges.filter(edge => relationView === 'all' || edge.view === relationView).map(edge => <section key={edge.id}><h3>{edge.id} · {edge.type}</h3><p>{edge.fromUnitId} {graph.nodes.find(n => n.id === edge.fromUnitId)?.name} → {edge.toUnitId} {graph.nodes.find(n => n.id === edge.toUnitId)?.name}</p><p>{edge.value}</p><p>来源：{edge.sourceRefs.map(ref => `${ref.sourceId} ${ref.pdfPages?.join('、') ?? ''} ${ref.note ?? ''}`).join('；')}</p></section>)}
        </aside>}
      </main>
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
