import { AnnotationPanel, type AnnotationPanelHandle } from './annotation-panel';
import { CameraController, type FollowState } from './camera-controller';
import { useLocalLayout, ReadingSurface } from './local-layout';
import type { LayoutPlacement } from '../layout';
import {ExtensionExperiment,flushExtensions} from './extension-experiment';
import { BuiltinExperiment, flushBuiltinExperiments } from './builtin-experiment';

import { AgentPanel, type AgentPanelHandle } from './agent-panel';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ReactFlow, ReactFlowProvider, MiniMap, useReactFlow, MarkerType, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createRoot } from 'react-dom/client';
import katex from 'katex';
import rough from 'roughjs';
import 'katex/dist/katex.min.css';
import './style.css';
import type { CourseGraph, CourseUnit, DesktopBridge, OpenedCourse, ReadingBlock, ReadingState } from '../shared';
import { ParagraphSaveChannel, type SaveState } from './save-channel';
import { RelationsPanel, useRelationEvents } from './relations-panel';
import { ControlledProducer } from './controlled-producer';
import { ContinuousUnitEditor } from './editor/continuous-editor';
import type { ContinuousEditor } from './editor/controller';
import { SourcePanel, SourceReferences, type SourcePanelHandle } from './source-panel';
import type { SourceCitation } from '../sources-api';
import { ReviewControls } from './review-controls';
import type { ReviewSnapshot, ReviewStatus } from '../shared';

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

function ReadingBoundary({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { root: element.closest('main.board') });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  return <div data-reading-block ref={ref} inert={!visible && !focused} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>{children}</div>;
}

function Block({ block, onReference, reading, updateReading, onSource, experiment }: { block: ReadingBlock; experiment: { contentScope?: string; unitId: string; sessionId: string; active: boolean; disabled: boolean; composition?: (active: boolean) => void }; onReference: (id: string, blockId: string) => void; reading: ReadingState | null; updateReading: (key: string, value: boolean) => void; onSource: (button: HTMLButtonElement) => void }) {
  const payload = block.payload;
  const children = block.children?.map(child => <ReadingBoundary key={child.id}><Block block={child} experiment={experiment} onReference={onReference} onSource={onSource} reading={reading} updateReading={updateReading} /></ReadingBoundary>);
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
    <summary>{payload.title}</summary>{payload.answerNature && <p className="unit-meta">{{'derived-solution':'据题干推导','official-solution':'官方题解','authored-example':'自编例题','self-test':'自测参考答案'}[payload.answerNature as string] ?? payload.answerNature}</p>}<p>{payload.problem}</p>
    {payload.hint && <details className="hint" open={reading?.expanded[block.id + ":hint"] ?? false} onToggle={event => updateReading(block.id + ":hint", event.currentTarget.open)}><summary>学习提示</summary><p>{payload.hint}</p></details>}
    {block.kind === 'exercise' ? <details className="answer" open={reading?.expanded[block.id + ":answer"] ?? false} onToggle={event => updateReading(block.id + ":answer", event.currentTarget.open)}><summary>答案与步骤</summary>{children}</details> : children}
  </details>;
  if (block.kind === 'interactive' && ['mux', 'decoder', 'kmap'].includes(payload.component)) return <BuiltinExperiment block={block} {...experiment} />;
  if (block.kind === 'figure' && payload.asset) {
    const fixedPage = /^\/source-pages\/([^/]+)\/([^/]+)\/(\d+)\.png$/.exec(payload.asset);
    return <figure><img src={experiment.contentScope === 'content-candidate' ? `yizhi-resource://course/${experiment.sessionId}/content/${encodeURIComponent(payload.asset)}` : './ti74153-1.png'} alt={payload.alt} /><figcaption>{payload.caption}</figcaption><button onClick={event => onSource(event.currentTarget)} data-source-version={fixedPage?.[2] ?? (block.sourceRefs as Array<any> | undefined)?.[0]?.versionId} data-source-page={fixedPage?.[3] ?? (block.sourceRefs as Array<any> | undefined)?.[0]?.pdfPages?.[0]}>查看{experiment.contentScope ? '固定原页' : ' TI 74153 原页'}</button></figure>;
  }
  if (block.kind === 'figure' && payload.config?.nodes) return <figure><figcaption>{payload.alt}</figcaption><svg viewBox="0 0 640 250" role="img" aria-label={payload.alt}>{payload.config.edges.map((edge: any, index: number) => { const a = payload.config.nodes.find((node: any) => node.id === edge.from), b = payload.config.nodes.find((node: any) => node.id === edge.to); return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#7798bc" />; })}{payload.config.nodes.map((node: any) => <g key={node.id}><rect x={node.x - 45} y={node.y - 20} width="90" height="40" fill="white" stroke="#7798bc" /><text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle" fontSize="13">{node.label}</text></g>)}</svg><figcaption>{payload.config.caption}</figcaption></figure>;
  if (block.kind === 'knowledge-reference') return <p className="reference">{payload.intent}<br/><button onClick={() => onReference(payload.targetUnitId, block.id)}>前往 {payload.targetUnitId}</button></p>;
  return <details><summary>保留的内容 · {block.kind}</summary><pre>{JSON.stringify(payload, null, 2)}</pre>{children}</details>;
}

function App() {
  const flow = useReactFlow();
  const boardRef = useRef<HTMLElement>(null);
  const [nodesReady, setNodesReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [graph, setGraph] = useState<CourseGraph>();
  const [selected, setSelected] = useState<CourseUnit>();
  const [mounted, setMounted] = useState<CourseUnit[]>([]);
  const [readError, setReadError] = useState<string>();
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 0.1 });
  const [directory, setDirectory] = useState(true);
  const [directoryTheme, setDirectoryTheme] = useState<string>();
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches);
  const directoryButton = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => { const media = matchMedia('(max-width: 760px)'); const update = () => setNarrow(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useEffect(() => { if (cameraReady && narrow && directory) navRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [narrow, directory, cameraReady]);
  const closeDirectory = () => { setDirectory(false); requestAnimationFrame(() => directoryButton.current?.focus()); };
  const trap = (event: KeyboardEvent<HTMLElement>, close: () => void) => {
    if (!narrow) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button, select, input, textarea, [tabindex]:not([tabindex="-1"])')].filter(item => !item.matches(':disabled'));
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
  };
  const [minimap, setMinimap] = useState(true);
  const [tool, setTool] = useState<"read" | "select" | "hand">("read");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const agentPanel = useRef<AgentPanelHandle>(null);
  const notesPanel = useRef<AnnotationPanelHandle>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const sourcesPanel = useRef<SourcePanelHandle>(null);
  const [sourceCitations, setSourceCitations] = useState<SourceCitation[]>([]);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const sourceDialog = useRef<HTMLElement | null>(null);
  const closeSource = () => { setSourceOpen(false); requestAnimationFrame(() => sourceTrigger.current?.focus()); };
  useEffect(() => { if (sourceOpen) sourceDialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [sourceOpen]);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [relationFocus, setRelationFocus] = useState<string>();
  const relationButton = useRef<HTMLButtonElement>(null);
  const relationPanel = useRef<HTMLElement>(null);
  const closeRelations = () => { setRelationsOpen(false); requestAnimationFrame(() => relationButton.current?.focus()); };
  useEffect(() => { if (narrow && relationsOpen) { setDirectory(false); relationPanel.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }, [narrow, relationsOpen]);
  const [relationView, setRelationView] = useState("main");
  const [course, setCourse] = useState<OpenedCourse>();
  const sessionRef = useRef<string | undefined>(undefined); sessionRef.current = course?.sessionId;
  useRelationEvents(course?.sessionId, setGraph);
  const [loadError, setLoadError] = useState<string>();
  const [state, setState] = useState<SaveState>({ status: 'saved' });
  const [closing, setClosing] = useState(false);
  const [producerBusy, setProducerBusy] = useState(false);
  const [producerOpen, setProducerOpen] = useState(false);
  const producerRunning = useRef(false);
  const channel = useRef<ParagraphSaveChannel | undefined>(undefined);
  const continuous = useRef<ContinuousEditor | null>(null);
  const [reading, setReading] = useState<ReadingState | null>(null);
  const [review, setReview] = useState<ReviewSnapshot>();
  const [reviewFilter, setReviewFilter] = useState<'all' | ReviewStatus>('all');
  const readingRef = useRef<ReadingState | null>(null);
  const navigation = useRef<Promise<void>>(Promise.resolve());
  const writes = useRef<Promise<void>>(Promise.resolve());
  const [readingSave, setReadingSave] = useState<'saved' | 'pending' | 'error'>('saved');
  const readingFailed = useRef(false);
  const readingSequence = useRef(0);
  const restored = useRef(false);
  const articleRef = useRef<HTMLElement | null>(null);
  const [followState, setFollowState] = useState<FollowState>('idle');
  const workTarget = useRef('RB-TH-01-03-expansion-terms');
  const camera = useMemo(() => new CameraController({
    get: () => flow.getViewport(), set: next => { void flow.setViewport(next, { duration: 0 }); },
    bounds: () => ({ width: boardRef.current?.clientWidth ?? 800, height: boardRef.current?.clientHeight ?? 600 }),
    reduced: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
    target: () => {
      const element = boardRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(workTarget.current)}"]`);
      if (!element) return;
      const rect = element.getBoundingClientRect(), board = boardRef.current!.getBoundingClientRect(), view = flow.getViewport();
      return { x: (rect.left - board.left - view.x) / view.zoom, y: (rect.top - board.top - view.y) / view.zoom, width: rect.width / view.zoom, height: rect.height / view.zoom };
    },
  }, setFollowState), [flow]);
  useEffect(() => () => camera.dispose(), [camera]);
  const local = useLocalLayout(graph, selected?.id, camera, viewport.zoom >= .55, cameraReady);
  const placementsRef = useRef(local.placements); placementsRef.current = local.placements;
  const [layoutSave, setLayoutSave] = useState<'saved' | 'pending' | 'error'>('saved');
  const layoutPending = useRef(new Map<string, LayoutPlacement>());
  const layoutWrites = useRef<Promise<void>>(Promise.resolve());
  const saveLayout = () => {
    if (!course) return;
    setLayoutSave('pending');
    layoutWrites.current = layoutWrites.current.then(async () => {
      const updates = [...layoutPending.current.values()];
      if (!updates.length) return;
      try {
        await window.yizhi.setLayout(course.sessionId, updates);
        for (const update of updates) if (layoutPending.current.get(update.unitId) === update) layoutPending.current.delete(update.unitId);
        setLayoutSave(layoutPending.current.size ? 'pending' : 'saved');
      } catch { setLayoutSave('error'); }
    });
  };
  const place = (placement: LayoutPlacement) => {
    const old = graph?.layout.nodes.find(node => node.unitId === placement.unitId);
    if (old?.x !== placement.x || old?.y !== placement.y) local.manual(placement.unitId);
    // Update only the explicit object, never persist displaced neighbours.
    setGraph(current => current && ({ ...current, layout: { ...current.layout, nodes: current.layout.nodes.map(node => node.unitId === placement.unitId ? { ...node, ...placement } : node) } }));
    layoutPending.current.set(placement.unitId, placement); saveLayout();
  };

  const persist = (next: ReadingState) => {
    readingRef.current = next; setReading(next);
    if (course) {
      if (readingFailed.current) return;
      const sequence = ++readingSequence.current; setReadingSave('pending');
      writes.current = writes.current.then(async () => {
        if (readingFailed.current) return;
        try {
          await window.yizhi.setReadingState(course.sessionId, next);
          if (sequence === readingSequence.current) setReadingSave('saved');
        } catch { readingFailed.current = true; setReadingSave('error'); }
      });
    }
  };
  const updateReading = (key: string, value: boolean) => {
    const current = readingRef.current;
    if (current && (current.expanded[key] ?? (key.endsWith(':hint') || key.endsWith(':answer') ? false : true)) !== value)
      persist({ ...current, expanded: { ...current.expanded, [key]: value } });
  };
  const composing = useRef(false);
  const load = async () => {
    setLoadError(undefined);
    setCameraReady(false);
    try {
      const opened = await window.yizhi.open();
      channel.current?.dispose();
      channel.current = new ParagraphSaveChannel(window.yizhi, opened, setState, { onSnapshot: setCourse });
      setCourse(opened);
      const [loadedGraph, savedReading, reviewSnapshot] = await Promise.all([window.yizhi.graph(opened.sessionId), window.yizhi.readingState(opened.sessionId), window.yizhi.reviewStates(opened.sessionId)]);
      if (savedReading?.pinnedUnitId === 'KU-001' || savedReading?.modification) setMounted([opened.unit]);
      if (savedReading?.modification) { workTarget.current = savedReading.modification.targetId; camera.restore(savedReading.modification.ended); }
      setGraph(loadedGraph); setReview(reviewSnapshot); readingRef.current = savedReading; restored.current = false; setReading(savedReading);
    } catch (error) { setLoadError((error as Error).message); }
  };
  useEffect(() => { void load(); return () => channel.current?.dispose(); }, []);
  useEffect(() => window.yizhi.onCloseRequested(async () => {
    if (producerRunning.current) return false;
    if (composing.current) {
      setState({ status: 'error', error: '请先完成中文候选输入，再关闭窗口。' });
      return false;
    }
    // A failed course open owns no editable input and must still allow normal exit.
    if (!channel.current) return true;
    setClosing(true);
    try { await navigation.current; }
    catch { setClosing(false); return false; }
    await writes.current;
    await layoutWrites.current;
    if (layoutPending.current.size) { setClosing(false); return false; }
    if (readingFailed.current) { setClosing(false); return false; }
    // A zero-duration viewport update can reach the DOM before onMoveEnd. The close
    // barrier records the actual final camera instead of dropping that last gesture.
    if (readingRef.current && sessionRef.current) {
      try { await window.yizhi.setReadingState(sessionRef.current, { ...readingRef.current, camera: flow.getViewport() }); }
      catch { readingFailed.current = true; setReadingSave('error'); setClosing(false); return false; }
    }
    if (notesPanel.current && !await notesPanel.current.flush()) { setClosing(false); return false; }
    if (sourcesPanel.current && !await sourcesPanel.current.flush()) { setClosing(false); return false; }
    const current = await window.yizhi.open();
    if (!await flushExtensions(current.sessionId)) { setReadError('扩展现场尚未确认，请恢复最近确认现场后重试。'); setClosing(false); return false; }
    if (!await flushBuiltinExperiments(window.yizhi, current.sessionId)) { setReadError('实验现场尚未确认，请返回实验重试保存或恢复最近确认现场。'); setClosing(false); return false; }
    if (agentPanel.current && !await agentPanel.current.flush()) { setClosing(false); return false; }
    const saved = await channel.current.flush();
    if (saved && continuous.current && !await continuous.current.finish()) { setClosing(false); return false; }
    if (!saved) setClosing(false);
    return saved;
  }), []);
  useEffect(() => {
    if (course) setMounted(previous => previous.map(unit => unit.id === course.unit.id ? course.unit : unit));
  }, [course, selected]);
  const navigate = async (id: string, nextState?: ReadingState): Promise<void> => {
    if (!course || !graph) return;
    camera.takeover();
    if (composing.current) { setReadError('请先完成中文候选输入，再切换阅读位置。'); return; }
    const position = placementsRef.current.find(node => node.unitId === id);
    if (!position) return;
    setReadError(undefined);
    try { const unit = await window.yizhi.readUnit(course.sessionId, id); persist(nextState ?? { ...(readingRef.current ?? { expanded: {}, returnStack: [], scrollTop: 0 }), unitId: id, scrollTop: 0, pinnedUnitId: mounted.some(item => item.id === 'KU-001') || id === 'KU-001' ? 'KU-001' : undefined }); setSelected(unit); setDirectoryTheme(unit.theme.id); setMounted(previous => previous.some(item => item.id === id) ? previous : [...previous.filter(item => item.id === 'KU-001'), unit]); }

    catch (error) { setSelected(undefined); setReadError((error as Error).message); }
    if (nextState?.camera) await flow.setViewport(nextState.camera, { duration: 0 });
    else await flow.setCenter(position.x + 325, position.y + 250, { zoom: 0.85, duration: 0 });
  };
  const go = (id: string, nextState?: ReadingState): Promise<void> => {
    const pending = navigate(id, nextState); navigation.current = pending; return pending;
  };
  useEffect(() => {
    if (!course || !graph || !nodesReady || restored.current) return;
    restored.current = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      try {
        if (reading) {
          await go(reading.unitId, reading);
          await local.waitForMeasurements([...new Set([reading.unitId, ...(reading.pinnedUnitId || reading.modification ? ['KU-001'] : [])])]);
          if (reading.camera) await flow.setViewport(reading.camera, { duration: 0 });
        }
        else await flow.fitView({ duration: 0 });
        // Expose navigation after the restored viewport reaches the DOM, so initial
        // placement cannot overwrite an early student gesture or navigation.
        requestAnimationFrame(() => setCameraReady(true));
      } catch { setLoadError('画板定位未完成，请重新打开课程。'); }
    }));
  }, [course, graph, reading, nodesReady]);
  useEffect(() => {
    if (selected && reading?.unitId === selected.id && articleRef.current) articleRef.current.scrollTop = reading.scrollTop;
  }, [selected?.id]);
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const nativeScroll = () => {
      const dx = board.scrollLeft, dy = board.scrollTop;
      if (!dx && !dy) return;
      // Browser caret/focus navigation can scroll overflow:hidden containers.
      // Transfer that visible movement to the saved camera; keep overlay controls fixed.
      board.scrollLeft = 0; board.scrollTop = 0;
      camera.pan(-dx, -dy);
    };
    const wheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.board-tools, .relations-panel, .source-dialog, .react-flow__minimap, .table-scroll, input, select, textarea, .mux, .builtin-formula-editor, math-field')) return;

      event.preventDefault(); event.stopPropagation();
      camera.takeover();
      const current = flow.getViewport();
      if (event.ctrlKey || event.metaKey) {
        const rect = board.getBoundingClientRect(); const px = event.clientX - rect.left, py = event.clientY - rect.top;
        const zoom = Math.max(.04, Math.min(2, current.zoom * Math.exp(-event.deltaY * .001)));
        const ratio = zoom / current.zoom;
        void flow.setViewport({ x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio, zoom });
      } else camera.pan(-(event.shiftKey ? event.deltaY : event.deltaX), -(event.shiftKey ? 0 : event.deltaY));
    };
    board.addEventListener('wheel', wheel, { passive: false, capture: true });
    board.addEventListener('scroll', nativeScroll, { passive: true });
    return () => { board.removeEventListener('wheel', wheel, true); board.removeEventListener('scroll', nativeScroll); };
  }, [flow, camera]);
  const nodes = useMemo(() => graph ? [
    ...graph.layout.groups.map(group => ({ id: group.themeId, position: { x: group.x, y: group.y }, data: { label: group.title }, width: group.width, height: group.height, style: { width: group.width, height: group.height, fontSize: 50, border: "1px solid #bbc9d5", background: "#fff", opacity: viewport.zoom < 0.35 ? 1 : 0.35 }, selectable: false, draggable: false })),
    ...graph.nodes.map(node => { const pos = local.placements.find(item => item.unitId === node.id)!; return { id: node.id, position: { x: pos.x, y: pos.y }, data: { label: node.name }, width: pos.width, height: pos.height, style: { width: pos.width, height: pos.height, opacity: viewport.zoom >= 0.35 ? 1 : 0, pointerEvents: viewport.zoom >= 0.35 ? "auto" as const : "none" as const }, draggable: false, focusable: viewport.zoom >= 0.35 && pos.x * viewport.zoom + viewport.x + pos.width * viewport.zoom > 0 && pos.y * viewport.zoom + viewport.y + pos.height * viewport.zoom > 0 && pos.x * viewport.zoom + viewport.x < (boardRef.current?.clientWidth ?? 0) && pos.y * viewport.zoom + viewport.y < (boardRef.current?.clientHeight ?? 0) }; })
  ] : [], [graph, local.placements, viewport]);
  const edges = useMemo(() => {
    if (!graph) return [];
    const visible = graph.edges.filter(edge => relationView === 'all' || edge.view === relationView);
    if (viewport.zoom >= 0.35) return visible.map(edge => ({ id: edge.id, source: edge.fromUnitId, target: edge.toUnitId, label: edge.requirementGroupId ? `${edge.type} · ${edge.requirementGroupId}（${graph.requirementGroups.find(g => g.id === edge.requirementGroupId)?.mode === "any" ? "或" : "且"}）` : edge.type, markerEnd: edge.directed ? { type: MarkerType.ArrowClosed } : undefined, animated: false }));
    const groups = new Map<string, { source: string; target: string; count: number; type: string; directed: boolean }>();
    for (const edge of visible) {
      const source = graph.nodes.find(node => node.id === edge.fromUnitId)?.themeId;
      const target = graph.nodes.find(node => node.id === edge.toUnitId)?.themeId;
      if (!source || !target || source === target) continue;
      const key = `${source}:${target}:${edge.type}:${edge.directed}`;
      const group = groups.get(key) ?? { source, target, count: 0, type: edge.type, directed: edge.directed }; group.count++; groups.set(key, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, source: group.source, target: group.target, label: `${group.type} · ${group.count} 条已有关系`, markerEnd: group.directed ? { type: MarkerType.ArrowClosed } : undefined, animated: false }));
  }, [graph, relationView, viewport.zoom]);
  const changeReview = async (unitId: string, status: ReviewStatus) => {
    if (!course) return;
    try { setReview(await window.yizhi.setReviewStatus(course.sessionId, unitId, status)); }
    catch (error) { setReadError((error as Error).message); }
  };
  const confirmReview = async (promptId: string, adjust: boolean) => {
    if (!course) return;
    try {
      const outcome = await window.yizhi.confirmReviewPrompt(course.sessionId, promptId, adjust);
      setReview(await window.yizhi.reviewStates(course.sessionId));
      if (outcome === 'stale') setReadError('复习状态或正文已变化，旧确认已失效。');
    } catch (error) { setReadError((error as Error).message); }
  };
  const status = { draft: '草稿已保留', saved: '已保存', pending: '待保存', saving: '正在保存…', error: '未保存' }[state.status];
  return <>
    <header className="app-header" inert={sourceOpen || (narrow && (directory || relationsOpen || sourcesOpen || agentOpen || notesOpen))}><strong className="brand">绎知</strong><span>数字逻辑 · 期中复习</span>
      {course && <AnnotationPanel ref={notesPanel} sessionId={course.sessionId} narrow={narrow} prepare={async () => !!await channel.current?.flush()} onOpenChange={value => { setNotesOpen(value); if (value && narrow) setDirectory(false); }} locate={async note => {
        if (selected?.id !== 'KU-001') await go('KU-001');
        const editor = continuous.current;
        if (!editor) throw new Error('请先定位批注所属单元。');
        if (!await channel.current?.flush() || !await editor.finish()) throw new Error('请先完成当前输入，再定位批注。');
        editor.reconcile(await window.yizhi.open());
        const latest = (await window.yizhi.annotations.list({ sessionId: course.sessionId })).find(item => item.id === note.id);
        if (latest) await editor.revealAnnotation(latest);
      }} />}
      {course && <SourcePanel ref={sourcesPanel} sessionId={course.sessionId} narrow={narrow} target={selected ? { unitId: selected.id } : undefined} onOpenChange={setSourcesOpen} onCitationsChange={setSourceCitations} onQuestion={citation => agentPanel.current?.attachCitation(citation)} />}
      {course && <AgentPanel ref={agentPanel} sessionId={course.sessionId} narrow={narrow} target={{ unitId: selected?.id ?? course.unit.id }} targetName={selected?.name ?? course.unit.name} sourceOpen={sourcesOpen} onOpenChange={value => { setAgentOpen(value); if (value && narrow) setDirectory(false); }} openCitation={citation => sourcesPanel.current?.openCitation(citation)} />}
      {!cameraReady && !loadError && <span role="status" aria-label="画板定位">正在定位画板…</span>}

      {course && <ControlledProducer course={course} narrow={narrow} onOpenChange={setProducerOpen} started={async () => {
        camera.start();
        persist({ ...(readingRef.current ?? { unitId: 'KU-001', expanded: {}, returnStack: [], scrollTop: 0 }), modification: { targetId: workTarget.current, ended: false } });
        if (!mounted.some(unit => unit.id === 'KU-001')) { setMounted(previous => [...previous.filter(item => item.id === selected?.id), course.unit]); }
        // Mounting/snapshot alignment never emits an old delta; only the user's new request starts following.
        requestAnimationFrame(() => camera.updated());
      }} advanced={() => camera.updated()} ended={() => { camera.finish(); if (readingRef.current) persist({ ...readingRef.current, modification: { targetId: workTarget.current, ended: true } }); }} prepare={async () => {
        if (composing.current) throw new Error('请先完成中文候选输入，再运行可控修改。');
        producerRunning.current = true; setProducerBusy(true);
        if (!await channel.current?.flush()) throw new Error('学生输入尚未保存，请先重试保存。');
      }} committed={async () => {
        const current = await window.yizhi.open();
        setReview(await window.yizhi.reviewStates(current.sessionId));
        await channel.current?.synchronize();
        setCourse(current);
        setMounted(previous => previous.map(item => item.id === current.unit.id ? current.unit : item));
      }} settled={() => { producerRunning.current = false; setProducerBusy(false); }} />}
      <div className="save-area" inert={narrow && producerOpen}><span role="status" aria-label="布局状态" className={layoutSave === 'error' ? 'layout-save-error' : ''}>{layoutSave === 'saved' ? '布局已保存' : layoutSave === 'pending' ? '正在保存布局' : '布局未保存'}</span>{layoutSave === 'error' && <button onClick={saveLayout}>重试保存布局</button>}<span role="status" aria-label="阅读状态">{readingSave === "error" ? "阅读位置未保存" : readingSave === "pending" ? "正在保存阅读位置" : "阅读位置已保存"}</span>{readingSave === "error" && <button onClick={() => { if (readingRef.current) { readingFailed.current = false; persist(readingRef.current); } }}>重试保存阅读位置</button>}<span role="status" aria-label="保存状态" aria-live="polite" className={state.status}>{course ? status : '正在打开课程…'}</span>

        {state.status === 'error' && <button onClick={() => void channel.current?.flush()}>重试保存</button>}
      </div>
    </header>
    {state.error && <div className="save-error" role="alert">{state.error}{!state.error.includes('冲突部分') && ' 输入仍保留，请重试保存。'}</div>}
    <div className="workspace board-workspace" inert={(!cameraReady && !loadError) || (narrow && (sourcesOpen || agentOpen || notesOpen))} aria-busy={!cameraReady && !loadError}>
      {directory && <nav ref={navRef} inert={sourceOpen || (narrow && (relationsOpen || producerOpen))} aria-label="课程目录" onKeyDown={event => trap(event, closeDirectory)}><h2>课程目录</h2>{narrow && <button onClick={closeDirectory}>关闭目录</button>}
        <label className="review-filter">复习状态筛选 <select aria-label="复习状态筛选" value={reviewFilter} onChange={event => setReviewFilter(event.target.value as typeof reviewFilter)}><option value="all">全部单元</option><option value="pending">待复习</option><option value="weak">薄弱</option><option value="mastered">已掌握</option></select></label>
        {graph?.groups.map(group => { const counts = review?.themes[group.id]; const matches = graph.nodes.filter(node => node.themeId === group.id && (reviewFilter === 'all' ? (directoryTheme ?? selected?.theme.id) === group.id : review?.units[node.id]?.status === reviewFilter)); return <div key={group.id}><button aria-label={group.name} className="directory-theme" onClick={() => { setDirectoryTheme(group.id); const first = matches[0] ?? graph.nodes.find(node => node.themeId === group.id); if (first) { void go(first.id); if (narrow) closeDirectory(); } }}>{group.name}{counts ? <span aria-hidden="true"> · 待复习 {counts.pending} / 薄弱 {counts.weak} / 已掌握 {counts.mastered}</span> : ''}</button>{matches.map(node => <button aria-label={node.name} className="directory-unit" key={node.id} onClick={() => { void go(node.id); if (narrow) closeDirectory(); }}>{node.name}{review ? <span aria-hidden="true"> · {{ pending: '待复习', weak: '薄弱', mastered: '已掌握' }[review.units[node.id].status]}</span> : ''}</button>)}</div>; })}</nav>}
      <main onWheelCapture={event => { if (!((event.target as HTMLElement).closest('.board-tools, .relations-panel, .source-dialog, input, select, textarea, .mux, .builtin-formula-editor, math-field'))) camera.takeover(); }} onPointerDownCapture={event => { const target = event.target as HTMLElement; if (target.closest('.react-flow__pane, .react-flow__minimap, .board-tools')) camera.takeover(); }} ref={boardRef} className="board" aria-label="知识画板" role="region" inert={narrow && ((directory && !relationsOpen) || producerOpen)}>
        <div className="board-background" inert={sourceOpen || (narrow && relationsOpen)}><ReactFlow nodes={nodes} edges={edges} onInit={() => setNodesReady(true)} onEdgeClick={(_event, edge) => { setRelationFocus(edge.id); setRelationsOpen(true); }} minZoom={0.04} maxZoom={2} nodesDraggable={false} panOnScroll zoomOnScroll={false} zoomOnPinch panOnDrag={tool === "select" ? [1] : [0, 1]} selectionOnDrag={tool === "select"} panActivationKeyCode="Space" onMoveStart={event => { if (event) camera.takeover(); }} onMove={(event, next) => { if (event) camera.takeover(); setViewport(next); }} onMoveEnd={(_event, next) => { const current = readingRef.current; if (current) persist({ ...current, camera: next }); }} onNodeClick={(_event, node) => { const first = graph?.nodes.find(item => item.id === node.id || item.themeId === node.id); if (first) void go(first.id); }}>



          {minimap && <MiniMap ariaLabel="小地图" nodeColor="#7798bc" nodeStrokeColor="#345d88" maskColor="rgba(105,101,219,.12)" pannable zoomable />}
        </ReactFlow>
        <div className="board-tools">{reading?.returnStack.length ? <button onClick={() => { const previous = reading.returnStack[reading.returnStack.length - 1]; void go(previous.unitId, { ...reading, unitId: previous.unitId, scrollTop: previous.scrollTop, camera: previous.camera, returnStack: reading.returnStack.slice(0, -1) }); }}>返回引用位置</button> : null}<button ref={directoryButton} onClick={() => setDirectory(!directory)}>{directory ? '收起目录' : '展开目录'}</button><button onClick={() => setMinimap(!minimap)}>{minimap ? '收起小地图' : '展开小地图'}</button><button onClick={() => { camera.takeover(); void flow.fitView({ duration: 0 }); }}>全图</button><button aria-pressed={tool === "read"} onClick={() => setTool("read")}>阅读工具</button><button aria-pressed={tool === "select"} onClick={() => setTool("select")}>选择工具</button><button aria-pressed={tool === "hand"} onClick={() => setTool("hand")}>手形工具</button><button ref={relationButton} onClick={() => setRelationsOpen(!relationsOpen)}>{relationsOpen ? "关闭关系" : "查看关系"}</button><label>关系 <select aria-label="关系范围" value={relationView} onChange={event => setRelationView(event.target.value)}><option value="main">主关系</option><option value="auxiliary">辅助关系</option><option value="all">全部关系</option></select></label></div>
        {loadError && <div className="load-error" role="alert"><h1>课程未打开</h1><p>{loadError}</p><button onClick={() => void load()}>重新打开课程</button></div>}
        {readError && <div className="read-error" role="status">{readError}</div>}
        {course && mounted.map(unit => { const position = local.placements.find(node => node.unitId === unit.id); if (!position) return null; return <div key={unit.id} className="reading-layer" data-unit-id={unit.id} style={{ width: position.width >= 360 ? position.width : 650, transform: `translate(${viewport.x + position.x * viewport.zoom}px, ${viewport.y + position.y * viewport.zoom}px) scale(${viewport.zoom})`, visibility: viewport.zoom >= 0.55 ? 'visible' : 'hidden' }}>
          <ReadingSurface id={unit.id} name={unit.name} position={position} baseline={graph!.layout.nodes.find(node => node.unitId === unit.id)!} active={selected?.id === unit.id} articleRef={articleRef} measure={local.measure} gesture={local.gesture} commit={place} takeover={() => camera.takeover()}>
            <RoughFrame id={unit.id} />

            <h1>{unit.name}</h1><p className="unit-meta">课程重要性 {unit.rating.stars} / 5 · {unit.id}</p>{review && <ReviewControls unitId={unit.id} snapshot={review} change={status => void changeReview(unit.id, status)} confirm={(id, adjust) => void confirmReview(id, adjust)} />}<p className="outcome">{unit.outcome}</p>
            {unit.id==='KU-001'&&!course.contentScope&&<ExtensionExperiment sessionId={course.sessionId} active={viewport.zoom>=0.55&&selected?.id===unit.id} disabled={closing}/>}
            <SourceReferences citations={sourceCitations.filter(citation => citation.target?.unitId === unit.id)} onOpen={citation => sourcesPanel.current?.openCitation(citation)} />
            {unit.id === 'KU-001' && channel.current ? <ContinuousUnitEditor course={course} channel={channel.current} disabled={closing || producerBusy || !cameraReady} saveError={state.status === 'error'}
              annotate={selection => { void notesPanel.current?.create(selection); }}
              composition={active => { composing.current = active; }} controller={instance => { continuous.current = instance; }}
              renderBlock={block => <ReadingBoundary><Block block={block} experiment={{ contentScope: course.contentScope, unitId: unit.id, sessionId: course.sessionId, active: viewport.zoom >= 0.55 && selected?.id === unit.id, disabled: closing, composition: active => { composing.current = active; } }} reading={reading} updateReading={updateReading}
                onSource={button => { sourceTrigger.current = button; if (course.contentScope && button.dataset.sourceVersion) sourcesPanel.current?.openVersion(button.dataset.sourceVersion, Number(button.dataset.sourcePage ?? 1) - 1); else setSourceOpen(true); }} onReference={(id, blockId) => { const current = readingRef.current!;
                  void go(id, { ...current, unitId: id, scrollTop: 0, camera: undefined, returnStack: [...current.returnStack, { unitId: unit.id, blockId, scrollTop: 0, camera: flow.getViewport() }] }); }} /></ReadingBoundary>} />
              : unit.reading.blocks.map(block => <ReadingBoundary key={block.id}><Block block={block} experiment={{ contentScope: course.contentScope, unitId: unit.id, sessionId: course.sessionId, active: viewport.zoom >= 0.55 && selected?.id === unit.id, disabled: closing, composition: active => { composing.current = active; } }} reading={reading} updateReading={updateReading}
                onSource={button => { sourceTrigger.current = button; if (course.contentScope && button.dataset.sourceVersion) sourcesPanel.current?.openVersion(button.dataset.sourceVersion, Number(button.dataset.sourcePage ?? 1) - 1); else setSourceOpen(true); }} onReference={(id, blockId) => { const current = readingRef.current!;
                  void go(id, { ...current, unitId: id, scrollTop: 0, camera: undefined, returnStack: [...current.returnStack, { unitId: unit.id, blockId, scrollTop: 0, camera: flow.getViewport() }] }); }} /></ReadingBoundary>)}


            <footer>来源：既有数字逻辑课程单元的独立副本。编辑保留原有知识身份。</footer>
          </ReadingSurface>
        </div>; })}</div>
        {followState !== 'idle' && <div className="follow-control"><span role="status" aria-label="修改跟随">{followState === 'following' ? '正在跟随可控修改' : followState === 'paused' ? '已由你控制视野' : '可控修改已结束'}</span>{followState !== 'following' && <button onClick={() => { camera.resume(); }}>{followState === 'finished' ? '查看修改结果' : '返回并继续跟随'}</button>}</div>}
        {relationsOpen && graph && course && <RelationsPanel graph={graph} sessionId={course.sessionId} view={relationView} narrow={narrow} panelRef={relationPanel} onClose={closeRelations} onKeyDown={event => trap(event, closeRelations)} onGraph={setGraph} focusId={relationFocus} />}
        {sourceOpen && <section ref={sourceDialog} className="source-dialog" role="dialog" aria-modal="true" aria-label="TI 74153 原页" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeSource(); } else if (event.key === 'Tab') { event.preventDefault(); sourceDialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); } }}><button onClick={closeSource}>返回正文</button><h2>TI 74153 原页 · 第 1 页</h2><img src="./ti74153-1.png" alt="TI 74153 手册第 1 页" /></section>}
      </main>
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App /></ReactFlowProvider>);
