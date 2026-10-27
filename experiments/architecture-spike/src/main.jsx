import React, { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, useReactFlow, useStore, Handle, Position, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { createDynamicLayout } from './dynamic-layout.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'managed';
const dynamic = params.get('dynamic') === '1';
const count = params.get('count') === '500' ? 500 : 84;
const fixture = await fetch('/fixture.json').then(r => r.json());
const P = window.ReviewContentProvider;
const WIDTH = 680;
const nextFrame = () => new Promise(requestAnimationFrame);
const stats = { bodyMounts: 0, bodyUnmounts: 0, paragraphUpdates: 0, deferredUpdates: 0, sizeReports: 0, layoutCommits: 0, lastMoved: [] };
const storageKey = `architecture-spike-v1:${count}${dynamic ? ':dynamic' : ''}`;
const saved = JSON.parse(localStorage.getItem(storageKey) || '{"drafts":{},"patches":{},"details":{},"experiments":{}}');
const persist = () => localStorage.setItem(storageKey, JSON.stringify(saved));
P.restoreState(saved.experiments);
window.addEventListener('review-content-input', () => { saved.experiments = P.captureState(); persist(); });

const units = Array.from({ length: count }, (_, index) => {
  const unit = structuredClone(fixture.units[index % fixture.units.length]);
  const sourceId = unit.id;
  const suffix = index < fixture.units.length ? '' : `--sample-${Math.floor(index / fixture.units.length)}`;
  unit.id += suffix;
  unit.sourceId = sourceId;
  const rename = blocks => blocks.forEach(b => { b.id += suffix; rename(b.children || []); });
  rename(unit.reading.blocks);
  return unit;
});

if (mode === 'calibrate') {
  await document.fonts.ready;
  const measured = {};
  const el = document.createElement('div');
  el.className = 'unit-body unit-content source-content calibrate';
  document.body.append(el);
  for (const unit of fixture.units) {
    el.innerHTML = P.render(unit);
    P.afterRender(el);
    await Promise.all([...el.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
    if ([...el.querySelectorAll('img')].some(img => !img.naturalWidth)) throw new Error(`Missing image in ${unit.id}`);
    await document.fonts.ready;
    measured[unit.id] = Math.ceil(el.getBoundingClientRect().height) + 280;
  }
  el.remove();
  window.probe = { ready: true, measured };
  document.getElementById('root').textContent = `已测量 ${Object.keys(measured).length} 个原始单元。`;
} else {
  const measured = await fetch('/heights.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const colHeights = Array(8).fill(0);
  const nodes = units.map((unit, index) => {
    const column = colHeights.indexOf(Math.min(...colHeights));
    const height = measured[unit.sourceId] || 2200;
    const node = { id: unit.id, type: 'learning', position: { x: column * 810, y: colHeights[column] },
      style: { width: WIDTH, height }, dragHandle: '.unit-handle', data: { unit, index, height } };
    colHeights[column] += height + 160;
    return node;
  });
  const layout = dynamic ? createDynamicLayout({ nodes, width: WIDTH, stats }) : null;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = Array.from({ length: Math.ceil(count / 84) }, (_, cycle) => fixture.edges.map(edge => {
    const suffix = cycle ? `--sample-${cycle}` : '';
    return { id: edge.id + suffix, source: edge.fromUnitId + suffix, target: edge.toUnitId + suffix };
  })).flat().filter(e => byId.has(e.source) && byId.has(e.target));

  // Visibility changes notify only affected bodies; camera movement does not rerender all content.
  const listeners = new Map();
  const visible = new Set(mode === 'all' ? units.map(u => u.id) : []);
  const protectedIds = new Set();
  let focusedId = null, selectedId = null, controller = null;
  const subscribe = (id, listener) => {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(listener);
    return () => listeners.get(id).delete(listener);
  };
  const notify = id => listeners.get(id)?.forEach(fn => fn());
  function refreshProtection() {
    protectedIds.clear();
    if (focusedId) protectedIds.add(focusedId);
    if (selectedId) protectedIds.add(selectedId);
    controller?.reconcileVisibility();
  }
  document.addEventListener('focusin', event => {
    focusedId = event.target.closest('[data-unit]')?.dataset.unit || null;
    refreshProtection();
    if (focusedId) { controller?.cancelAnimation(); controller?.rememberAnchor(event.target); }
  });
  document.addEventListener('focusout', () => queueMicrotask(() => {
    focusedId = document.activeElement?.closest('[data-unit]')?.dataset.unit || null;
    refreshProtection();
  }));
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode?.parentElement;
    selectedId = selection && !selection.isCollapsed ? anchor?.closest('[data-unit]')?.dataset.unit || null : null;
    refreshProtection();
    if (selectedId) { controller?.cancelAnimation(); controller?.rememberAnchor(anchor); }
    document.querySelectorAll('[data-pending-patch]').forEach(el => {
      if (!protectedIds.has(el.closest('[data-unit]')?.dataset.unit)) {
        el.textContent = saved.patches[el.closest('[data-unit]').dataset.unit];
        el.removeAttribute('data-pending-patch');
      }
    });
  });
  function applyPatch(id, text) {
    saved.patches[id] = text;
    persist(); // This probe writes only its localStorage namespace, never the course service.
    const root = document.querySelector(`[data-unit="${id}"] .source-content`);
    const paragraph = root?.querySelector('.reading-paragraph p, .reading-block p');
    if (!paragraph) return;
    const selection = window.getSelection();
    if (!selection.isCollapsed && (paragraph.contains(selection.anchorNode) || paragraph.contains(selection.focusNode))) {
      paragraph.dataset.pendingPatch = 'true'; stats.deferredUpdates++;
    } else { paragraph.textContent = text; stats.paragraphUpdates++; }
  }

  const Body = memo(function Body({ unit }) {
    const root = useRef(null), textarea = useRef(null), formula = useRef(null);
    useLayoutEffect(() => {
      stats.bodyMounts++;
      const el = root.current;
      el.innerHTML = P.render(unit);
      P.afterRender(el);
      const state = saved.drafts[unit.id] || {};
      textarea.current.value = state.text || '';
      formula.current.value = state.formula || 'Y=A\\overline{B}+C';
      const onFormula = () => { saved.drafts[unit.id] = { ...saved.drafts[unit.id], formula: formula.current.value }; persist(); };
      const formulaElement = formula.current;
      formulaElement.addEventListener('input', onFormula);
      if (saved.patches[unit.id]) applyPatch(unit.id, saved.patches[unit.id]);
      el.querySelectorAll('details').forEach(details => {
        details.open = Boolean(saved.details[details.id]);
        details.addEventListener('toggle', () => { saved.details[details.id] = details.open; persist(); });
      });
      const reveal = event => {
        const button = event.target.closest('[data-reveal]');
        if (button) {
          const target = document.getElementById(button.dataset.reveal);
          target.hidden = !target.hidden;
          button.setAttribute('aria-expanded', String(!target.hidden));
        }
      };
      el.addEventListener('click', reveal);
      return () => { stats.bodyUnmounts++; formulaElement.removeEventListener('input', onFormula); };
    }, [unit]);
    return <div className="unit-body nodrag nopan unit-content">
      <div className="probe-editors">
        <label>输入保留<textarea ref={textarea} data-draft className="nowheel" placeholder="试写中文，再拖动画板或模拟修改" onInput={event => {
          saved.drafts[unit.id] = { ...saved.drafts[unit.id], text: event.target.value }; persist();
        }}/></label>
        <label>公式光标<math-field ref={formula} class="nowheel" math-virtual-keyboard-policy="manual"/></label>
        <span className="status">验证样例：输入仅自动保存到此样例的浏览器存储</span>
      </div>
      <div ref={root} className="source-content"/>
    </div>;
  });
  const LearningNode = memo(function LearningNode({ data }) {
    const { unit, height } = data;
    const article = useRef(null);
    const show = useSyncExternalStore(fn => subscribe(unit.id, fn), () => visible.has(unit.id));
    useLayoutEffect(() => { if (show && layout) return layout.observe(unit.id, article.current); }, [show, unit.id]);
    return <article ref={article} className="unit" data-unit={unit.id} style={{ minHeight: dynamic && show ? undefined : height }}>
      <Handle type="target" position={Position.Left}/>
      <div className="unit-handle"><h2>{unit.name}</h2><small>{unit.id} · {unit.reading.blocks.length} 个顶层内容块{unit.id !== unit.sourceId ? ' · 合成副本' : ''}</small></div>
      {show ? <Body unit={unit}/> : <div className="unit-shell">{unit.summary}<p>靠近阅读时加载完整正文、公式与实验。</p></div>}
      <Handle type="source" position={Position.Right}/>
    </article>;
  });
  const nodeTypes = { learning: LearningNode };
  function CameraManager() {
    const flow = useReactFlow();
    const transform = useStore(state => state.transform);
    const [owner, setOwner] = useState('follow');
    const [working, setWorking] = useState(0);
    const [dom, setDom] = useState(0);
    const state = useRef({ owner: 'follow', index: 0, raf: 0, epoch: 0, lastTarget: null, running: false, interval: 0 });
    function reconcileVisibility() {
      if (mode === 'all') return;
      const { x, y, zoom } = flow.getViewport();
      const width = document.querySelector('.board')?.clientWidth || innerWidth;
      const height = document.querySelector('.board')?.clientHeight || innerHeight;
      const margin = 260;
      for (const node of flow.getNodes()) {
        const left = node.position.x * zoom + x, top = node.position.y * zoom + y;
        const show = protectedIds.has(node.id) || (zoom >= .22 && left + WIDTH * zoom > -margin && left < width + margin && top + node.data.height * zoom > -margin && top < height + margin);
        if (show !== visible.has(node.id)) { show ? visible.add(node.id) : visible.delete(node.id); notify(node.id); }
      }
    }
    // One camera owns both user motion and layout compensation. A later user gesture
    // invalidates pending compensation; compensation never changes follow ownership.
    const reader = useRef(null), cameraEpoch = useRef(0);
    function rememberAnchor(element) {
      const el = element?.closest?.('textarea, math-field, summary, p, h2') || element;
      if (el?.closest?.('[data-unit]')) reader.current = { el, top: el.getBoundingClientRect().top, left: el.getBoundingClientRect().left };
    }
    function refreshAnchor() {
      if (reader.current?.el.isConnected) rememberAnchor(reader.current.el);
    }
    function captureAnchor() {
      if (!reader.current?.el.isConnected) {
        // Navigation may mount an upstream body with newer content than its cached size.
        // Anchor a visible destination before applying that size feedback.
        const top = document.querySelector('.board').getBoundingClientRect().top;
        const el = [...document.querySelectorAll('[data-unit] .unit-handle')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.top >= top && r.top < innerHeight && r.right > 0 && r.left < innerWidth; })
          .sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
        if (el) rememberAnchor(el);
      }
      const a = reader.current;
      return a?.el.isConnected ? { ...a, epoch: cameraEpoch.current } : null;
    }
    function restoreAnchor(anchor) {
      if (!anchor || anchor.epoch !== cameraEpoch.current || !anchor.el.isConnected) return;
      const rect = anchor.el.getBoundingClientRect(), v = flow.getViewport();
      const dx = anchor.left - rect.left, dy = anchor.top - rect.top;
      if (Math.abs(dx) > .1 || Math.abs(dy) > .1) {
        flow.setViewport({ ...v, x: v.x + dx, y: v.y + dy }, { duration: 0 });
      }
      reader.current = anchor;
    }
    function cancelAnimation() { state.current.epoch++; cancelAnimationFrame(state.current.raf); }
    function manual() { cameraEpoch.current++; refreshAnchor(); cancelAnimation(); state.current.owner = 'manual'; setOwner('manual'); }
    function animateTo(target, animate = true) {
      cancelAnimation();
      const epoch = state.current.epoch;
      const from = flow.getViewport(), start = performance.now();
      const tick = now => {
        if (epoch !== state.current.epoch) return;
        const t = animate ? Math.min(1, (now - start) / 240) : 1;
        const p = 1 - (1 - t) ** 3;
        flow.setViewport({ x: from.x + (target.x - from.x) * p, y: from.y + (target.y - from.y) * p, zoom: from.zoom + (target.zoom - from.zoom) * p }, { duration: 0 });
        if (t < 1) state.current.raf = requestAnimationFrame(tick);
      };
      state.current.raf = requestAnimationFrame(tick);
    }
    function jump(index, animate = false) {
      reader.current = null; cameraEpoch.current++;
      const node = flow.getNode(nodes[index].id);
      animateTo({ x: 95 - node.position.x * .7, y: 35 - node.position.y * .7, zoom: .7 }, animate);
    }
    function followTarget(index) {
      if (state.current.owner !== 'follow' || protectedIds.size) return;
      if (state.current.lastTarget !== index) { state.current.lastTarget = index; jump(index, true); }
    }
    function emit(index, text) {
      state.current.index = index; setWorking(index);
      applyPatch(nodes[index].id, text);
      followTarget(index);
    }
    function resume() {
      state.current.owner = 'follow'; state.current.lastTarget = null;
      setOwner('follow'); followTarget(state.current.index);
    }
    function startSimulation() {
      clearInterval(state.current.interval);
      state.current.running = true; resume(); let tick = 0;
      state.current.interval = setInterval(() => {
        const index = Math.floor(tick / 28) % Math.min(8, nodes.length);
        emit(index, `模拟 Agent 正在补充第 ${index + 1} 个单元：${'先核对定义，再用输入组合验证结论。'.repeat(tick % 28 + 1)}`);
        if (++tick >= 224) { clearInterval(state.current.interval); state.current.running = false; }
      }, 100);
    }
    useEffect(() => { reconcileVisibility(); refreshAnchor(); }, [transform]);
    useEffect(() => {
      controller = { cancelAnimation, manual, reconcileVisibility, rememberAnchor, captureAnchor, restoreAnchor, clearAnchor: () => { reader.current = null; cameraEpoch.current++; } };
      layout?.attach(flow, controller);
      const board = document.querySelector('.board');
      const onWheel = event => { if (!event.target.closest('.nowheel, .reading-table-wrap, math-field')) manual(); };
      const onPointer = event => { cameraEpoch.current++; cancelAnimation(); rememberAnchor(event.target); };
      board.addEventListener('wheel', onWheel, { capture: true, passive: true });
      board.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
      let frames = [], tasks = [], recording = false, lastFrame = 0;
      const observer = new PerformanceObserver(list => { if (recording) tasks.push(...list.getEntries().map(e => e.duration)); });
      observer.observe({ type: 'longtask', buffered: false });
      const sample = time => { if (recording && lastFrame) frames.push(time - lastFrame); lastFrame = time; requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
      const snapshot = () => ({ mode, count, dynamic, domElements: document.querySelectorAll('*').length, heavyBodies: document.querySelectorAll('.source-content').length,
        heapBytes: performance.memory?.usedJSHeapSize, viewport: flow.getViewport(), owner: state.current.owner, workIndex: state.current.index, ...stats });
      window.probe = { ready: false, snapshot, unitIds: units.map(u => u.id), getSaved: () => structuredClone(saved),
        viewport: () => flow.getViewport(), jump, emit, resume, manual, startSimulation,
        layout: () => layout?.snapshot(),
        moveNode: (index, position) => { layout?.move(nodes[index].id, position); flow.updateNode(nodes[index].id, {position}); requestAnimationFrame(reconcileVisibility); },
        setViewport: viewport => { reader.current = null; cameraEpoch.current++; return flow.setViewport(viewport, { duration: 0 }); },
        startRecording: () => { frames = []; tasks = []; lastFrame = 0; recording = true; },
        stopRecording: () => { recording = false; const sorted = [...frames].sort((a,b) => a-b); return { frames: frames.length,
          frameMedianMs: sorted[Math.floor(sorted.length / 2)] || 0, frameP95Ms: sorted[Math.floor(sorted.length * .95)] || 0,
          framesOver33ms: frames.filter(t => t > 33.34).length, maxFrameMs: Math.max(0,...frames), longTasks: tasks.length,
          maxLongTaskMs: Math.max(0,...tasks), ...snapshot() }; },
      };
      (async () => {
        window.probe.phase = 'fonts';
        await document.fonts.ready;
        window.probe.phase = 'images';
        await Promise.all([...document.querySelectorAll('.source-content img')].map(img => img.decode().catch(() => {})));
        window.probe.assetErrors = [...document.querySelectorAll('.source-content img')].filter(img => !img.naturalWidth).map(img => img.getAttribute('src'));
        if (window.probe.assetErrors.length) throw new Error('Some source images failed to load');
        window.probe.phase = 'frames';
        await nextFrame(); await nextFrame();
        window.probe.initial = { ...snapshot(), loadToReadyMs: performance.now() - window.probeStartedAt };
        setDom(window.probe.initial.domElements);
        window.probe.phase = 'ready';
        window.probe.ready = true;
      })().catch(error => { window.probe.failure = error.message; });
      const timer = setInterval(() => setDom(document.querySelectorAll('*').length), 1000);
      return () => { observer.disconnect(); clearInterval(timer); board.removeEventListener('wheel', onWheel, true); board.removeEventListener('pointerdown', onPointer, true); };
    }, []);
    return <div className="floating nodrag nopan nowheel">
      <p><strong>{owner === 'follow' ? '跟随修改中' : '已由你接管视野'}</strong> · 当前对象 {nodes[working].id}</p>
      <p className="probe-summary">{count} 单元 · {mode === 'managed' ? '按视野加载正文' : '全量挂载'} · {dynamic ? '实测尺寸局部让位' : '固定预测量基线'} · {dom.toLocaleString()} DOM 元素</p>
      <p>滚轮平移 · 捏合缩放 · 空白拖动 · 正文可选文</p>
      <button data-simulate onClick={startSimulation}>模拟实时修改</button>{' '}
      {owner === 'manual' && <button data-resume onClick={resume}>返回并继续跟随</button>}
    </div>;
  }
  function App() {
    return <div className="app"><div className="toolbar">
      <strong>复习画板 · 架构验证</strong>
      <select aria-label="负载场景" value={`${count}:${mode}`} onChange={event => { const [c,m]=event.target.value.split(':'); location.search=`?count=${c}&mode=${m}&dynamic=${Number(dynamic)}`; }}>
        <option value="84:managed">84 个真实单元 · 按需正文</option><option value="84:all">84 个真实单元 · 全量正文</option>
        <option value="500:managed">500 个合成单元 · 按需正文</option><option value="500:all">500 个合成单元 · 全量正文</option>
      </select>
      <button onClick={() => { params.set('dynamic', dynamic ? '0' : '1'); location.search = params; }}>{dynamic ? '切换固定布局基线' : '验证动态布局'}</button>
      <button onClick={() => { window.probe.manual(); window.probe.jump(34); }}>查看交互实验</button>
      <button onClick={() => { window.probe.manual(); window.probe.setViewport({x:30,y:20,zoom:.035}); }}>概览</button>
      <span className="hint">独立样例 · 使用课程副本 · 模拟生成 · 不写正式课程</span>
    </div><div className="board"><ReactFlowProvider><ReactFlow defaultNodes={nodes} defaultEdges={edges} nodeTypes={nodeTypes}
      defaultViewport={{x:95,y:35,zoom:.7}} minZoom={.008} maxZoom={2.5}
      panOnScroll zoomOnScroll={false} zoomOnPinch zoomActivationKeyCode="Meta" panOnDrag={[0,1]}
      zoomOnDoubleClick={false} selectionOnDrag={false} nodesConnectable={false} nodesFocusable={false}
      autoPanOnNodeFocus={false} deleteKeyCode={null} onlyRenderVisibleElements={false}
      onNodeDragStart={(_, node) => { controller?.clearAnchor(); layout?.dragStart(node.id, node.position); }}
      onNodeDragStop={(_, node) => { layout?.dragStop(node.id, node.position); controller?.reconcileVisibility(); }}
      onMoveStart={event => { if (event) controller?.manual(); }}>
      <Background gap={30} size={1} color="#c8d2c2"/><CameraManager/>
    </ReactFlow></ReactFlowProvider></div></div>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
}
