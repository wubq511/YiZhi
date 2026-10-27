import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, MiniMap, useReactFlow, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createRoot } from 'react-dom/client';
import katex from 'katex';
import rough from 'roughjs';
import 'katex/dist/katex.min.css';
import './style.css';
import type { CourseGraph, CourseUnit, DesktopBridge, OpenedCourse, ReadingBlock } from '../shared';
import { ParagraphSaveChannel, type SaveState } from './save-channel';
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
  return <section className="mux"><h3>{payload.title}</h3><p>选择端决定输出的数据端。</p>
    {['S1', 'S0', 'I0', 'I1', 'I2', 'I3'].map(name => <label key={name}><input type="checkbox" checked={!!bits[name]} onChange={event => setBits({ ...bits, [name]: Number(event.target.checked) })} />{name} = {bits[name]}</label>)}
    <p role="status" aria-label="MUX 输出">输出 Z = {bits[`I${index}`]}</p></section>;
}

function Block({ block, onReference }: { block: ReadingBlock; onReference: (id: string) => void }) {
  const payload = block.payload;
  const children = block.children?.map(child => <Block key={child.id} block={child} onReference={onReference} />);
  if (block.kind === 'paragraph') return <p>{payload.text}</p>;
  if (block.kind === 'formula') return <div className="formula" role="math" aria-label={payload.latex}
    dangerouslySetInnerHTML={{ __html: katex.renderToString(payload.latex, { throwOnError: false, trust: false, displayMode: true }) }} />;
  if (block.kind === 'table') return <div className="table-scroll" tabIndex={0} aria-label="数制对照表"><table>
    <thead><tr>{payload.columns.map((column: string, i: number) => <th key={i}>{column}</th>)}</tr></thead>
    <tbody>{payload.rows.map((row: (string | number)[], i: number) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
  if (block.kind === 'callout') return <aside className="reminder"><p>{payload.text}</p>{children}</aside>;
  if (block.kind === 'steps') return <ol>{payload.items.map((item: string, i: number) => <li key={i}>{item}</li>)}{children}</ol>;
  if (block.kind === 'example' || block.kind === 'exercise') return <details className="material" open>
    <summary>{payload.title}</summary><p>{payload.problem}</p>
    {payload.hint && <details className="hint"><summary>学习提示</summary><p>{payload.hint}</p></details>}
    {block.kind === 'exercise' ? <details className="answer"><summary>答案与步骤</summary>{children}</details> : children}
  </details>;
  if (block.kind === 'interactive' && payload.component === 'mux') return <Mux payload={payload} />;
  if (block.kind === 'figure' && payload.asset) return <figure><img src="./ti74153-1.png" alt={payload.alt} /><figcaption>{payload.caption}</figcaption></figure>;
  if (block.kind === 'figure' && payload.config?.nodes) return <figure><figcaption>{payload.alt}</figcaption><svg viewBox="0 0 640 250" role="img" aria-label={payload.alt}>{payload.config.edges.map((edge: any, index: number) => { const a = payload.config.nodes.find((node: any) => node.id === edge.from), b = payload.config.nodes.find((node: any) => node.id === edge.to); return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#7798bc" />; })}{payload.config.nodes.map((node: any) => <g key={node.id}><rect x={node.x - 45} y={node.y - 20} width="90" height="40" fill="white" stroke="#7798bc" /><text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle" fontSize="13">{node.label}</text></g>)}</svg><figcaption>{payload.config.caption}</figcaption></figure>;
  if (block.kind === 'knowledge-reference') return <p className="reference">{payload.intent}<br/><button onClick={() => onReference(payload.targetUnitId)}>前往 {payload.targetUnitId}</button></p>;
  return <details><summary>保留的内容 · {block.kind}</summary><pre>{JSON.stringify(payload, null, 2)}</pre>{children}</details>;
}

function App() {
  const flow = useReactFlow();
  const [graph, setGraph] = useState<CourseGraph>();
  const [selected, setSelected] = useState<CourseUnit>();
  const [mounted, setMounted] = useState<CourseUnit[]>([]);
  const [readError, setReadError] = useState<string>();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 0.1 });
  const [directory, setDirectory] = useState(true);
  const [minimap, setMinimap] = useState(true);
  const [relationView, setRelationView] = useState("main");
  const [course, setCourse] = useState<OpenedCourse>();
  const [loadError, setLoadError] = useState<string>();
  const [state, setState] = useState<SaveState>({ status: 'saved' });
  const [closing, setClosing] = useState(false);
  const channel = useRef<ParagraphSaveChannel | undefined>(undefined);
  const editor = useRef<HTMLDivElement>(null);
  const editedText = useRef<string | undefined>(undefined);
  const [backUnit, setBackUnit] = useState<string>();
  const composing = useRef(false);
  const load = async () => {
    setLoadError(undefined);
    try {
      const opened = await window.yizhi.open();
      channel.current = new ParagraphSaveChannel(window.yizhi, opened, setState);
      setCourse(opened);
      setGraph(await window.yizhi.graph(opened.sessionId));
    } catch (error) { setLoadError((error as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => window.yizhi.onCloseRequested(async () => {
    if (composing.current) {
      setState({ status: 'error', error: '请先完成中文候选输入，再关闭窗口。' });
      return false;
    }
    // A failed course open owns no editable input and must still allow normal exit.
    if (!channel.current) return true;
    setClosing(true);
    const saved = await channel.current.flush();
    if (!saved) setClosing(false);
    return saved;
  }), []);
  useEffect(() => {
    if (course && editor.current && !editor.current.dataset.initialized) { editor.current.textContent = editedText.current ?? String(course.unit.reading.blocks[0].payload.text); editor.current.dataset.initialized = "yes"; }
  }, [course, selected]);
  const go = async (id: string) => {
    if (!course || !graph) return;
    const position = graph.layout.nodes.find(node => node.unitId === id);
    if (!position) return;
    setReadError(undefined);
    try { const unit = await window.yizhi.readUnit(course.sessionId, id); setSelected(unit); setMounted(previous => previous.some(item => item.id === id) ? previous : [...previous.filter(item => item.id === 'KU-001'), unit]); }
    catch (error) { setSelected(undefined); setReadError((error as Error).message); }
    await flow.setCenter(position.x + 325, position.y + 250, { zoom: 0.85, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180 });
  };
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
    <header className="app-header"><strong className="brand">绎知</strong><span>数字逻辑 · 期中复习</span>
      <div className="save-area"><span role="status" aria-live="polite" className={state.status}>{course ? status : '正在打开课程…'}</span>
        {state.status === 'error' && <button onClick={() => void channel.current?.flush()}>重试保存</button>}
      </div>
    </header>
    {state.error && <div className="save-error" role="alert">{state.error} 输入仍保留，请重试保存。</div>}
    <div className="workspace board-workspace">
      {directory && <nav aria-label="课程目录"><h2>课程目录</h2>{graph?.groups.map(group => <button className="directory-theme" key={group.id} onClick={() => { const first = graph.nodes.find(node => node.themeId === group.id); if (first) void go(first.id); }}>{group.name}</button>)}</nav>}
      <main className="board" aria-label="知识画板" role="region">
        <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.04} maxZoom={2} nodesDraggable={false} panOnScroll zoomOnScroll={false} zoomOnPinch panOnDrag onMove={(_event, next) => setViewport(next)} onNodeClick={(_event, node) => { const first = graph?.nodes.find(item => item.id === node.id || item.themeId === node.id); if (first) void go(first.id); }}>
          {minimap && <MiniMap ariaLabel="小地图" nodeColor="#7798bc" nodeStrokeColor="#345d88" maskColor="rgba(105,101,219,.12)" pannable zoomable />}
        </ReactFlow>
        <div className="board-tools">{backUnit && <button onClick={() => { const id = backUnit; setBackUnit(undefined); void go(id); }}>返回引用位置</button>}<button onClick={() => setDirectory(!directory)}>{directory ? '收起目录' : '展开目录'}</button><button onClick={() => setMinimap(!minimap)}>{minimap ? '收起小地图' : '展开小地图'}</button><button onClick={() => void flow.fitView({ duration: 0 })}>全图</button><label>关系 <select value={relationView} onChange={event => setRelationView(event.target.value)}><option value="main">主关系</option><option value="auxiliary">辅助关系</option><option value="all">全部关系</option></select></label></div>
        {loadError && <div className="load-error" role="alert"><h1>课程未打开</h1><p>{loadError}</p><button onClick={() => void load()}>重新打开课程</button></div>}
        {readError && <div className="read-error" role="status">{readError}</div>}
        {course && mounted.map(unit => { const position = graph?.layout.nodes.find(node => node.unitId === unit.id); if (!position) return null; return <div key={unit.id} className="reading-layer" style={{ transform: `translate(${viewport.x + position.x * viewport.zoom}px, ${viewport.y + position.y * viewport.zoom}px) scale(${viewport.zoom})`, visibility: viewport.zoom >= 0.55 && selected?.id === unit.id ? 'visible' : 'hidden' }}>
          <article id="unit" className="nodrag nopan nowheel"><RoughFrame id={unit.id} />
            <h1>{unit.name}</h1><p className="unit-meta">课程重要性 {unit.rating.stars} / 5 · {unit.id}</p><p className="outcome">{unit.outcome}</p>
            {unit.id === 'KU-001' && <div className="editable-section"><label id="editor-label">首段正文 <span>可直接编辑，自动保存</span></label><div ref={editor} role="textbox" aria-label="编辑首段正文" aria-multiline="true" contentEditable={!closing} suppressContentEditableWarning className="paragraph-editor" onInput={event => { editedText.current = event.currentTarget.innerText; if (!composing.current) channel.current?.input(event.currentTarget.innerText); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; editedText.current = event.currentTarget.innerText; channel.current?.input(event.currentTarget.innerText); }} /></div>}
            {unit.reading.blocks.slice(unit.id === 'KU-001' ? 1 : 0).map(block => <Block key={block.id} block={block} onReference={id => { setBackUnit(unit.id); void go(id); }} />)}
            <footer>来源：既有数字逻辑课程单元的独立副本。编辑保留原有知识身份。</footer>
          </article>
        </div>; })}
      </main>
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
