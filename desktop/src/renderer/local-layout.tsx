import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import type { CourseGraph } from '../shared';
import { projectLayout, type LayoutNode, type LayoutPlacement, type LayoutSizes } from '../layout';
import type { CameraController } from './camera-controller';
import './local-layout.css';
import { observation } from '../acceptance-observation';

export function useLocalLayout(graph: CourseGraph | undefined, activeId: string | undefined, camera: CameraController, enabled: boolean, ready = true,readingAnchorId?:string) {
  const observed = useMemo(() => ({ pending: observation.resource('measurement.pending'),
    frame: observation.resource('layout.scheduledFrames'), metadata: observation.resource('measurement.metadataEntries') }), []);
  const [sizes, setSizes] = useState<LayoutSizes>({});
  const [gesture, setGesture] = useState<LayoutPlacement>();
  const measured = useRef<LayoutSizes>({});
  const pending = useRef<LayoutSizes>({}), frame = useRef<number | undefined>(undefined);
  const measure = useCallback((id: string, width: number, height: number) => {
    // ResizeObserver can deliver a final zero rectangle after a virtualized body detaches.
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return;
    observation.count('measurement.callbacks');
    pending.current[id] = { width, height };
    observed.pending.set(Object.keys(pending.current).length);
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const updates = pending.current; pending.current = {};
      observed.pending.set(0); observed.frame.set(0);
      observation.sample('layout.batchSize', Object.keys(updates).length);
      setSizes(previous => Object.entries(updates).some(([id, size]) => previous[id]?.height !== size.height || previous[id]?.width !== size.width) ? { ...previous, ...updates } : previous);
    });
    observed.frame.set(1);
  }, []);
  useEffect(() => () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    observed.pending.close(); observed.frame.close(); observed.metadata.close(); }, []);
  useLayoutEffect(() => { observed.metadata.set(Object.keys(sizes).length); }, [sizes, observed]);
  const placements = useMemo(() => {
    if(!graph)return [];
    const ids=new Set(graph.layout.nodes.map(n=>n.unitId));
    const known=Object.fromEntries(Object.entries(sizes).filter(([id])=>ids.has(id)));
    // Only a live placement gesture may override the latest manual baseline.
    return projectLayout(graph.layout.nodes,enabled?known:{},gesture);
  },[graph,enabled,sizes,gesture]);
  const manual = useRef<LayoutPlacement | undefined>(undefined);
  const previous = useRef<{ id?: string; fixed?: string; nodes: LayoutNode[] }>({ nodes: [] });
  useLayoutEffect(() => {
    const anchorId = gesture?.unitId ?? manual.current?.unitId ?? readingAnchorId ?? activeId;
    const old = previous.current.nodes.find(n => n.unitId === anchorId), next = placements.find(n => n.unitId === anchorId);
    const manualAnchor = manual.current?.unitId === anchorId;
    const intended = manualAnchor ? manual.current : old;
    const measuredAnchor = anchorId !== undefined && sizes[anchorId] !== undefined;
    // A manual move remains visible. Only the extra collision displacement is
    // compensated, including the transition out of a live placement gesture.
    // The first real measurement can anchor a mounted body; unread placeholders cannot.
    if (ready && enabled && !gesture && (manualAnchor || measuredAnchor) && (previous.current.fixed !== anchorId || manualAnchor) && (previous.current.id === anchorId || manualAnchor) && intended && next && (intended.x !== next.x || intended.y !== next.y))
      camera.compensate(next.x - intended.x, next.y - intended.y);
    measured.current = sizes;
    manual.current = undefined;
    previous.current = { id: anchorId, fixed: gesture?.unitId, nodes: placements };
  }, [placements, activeId, enabled, ready, camera, gesture, sizes,readingAnchorId]);
  const waitForMeasurements = async (ids: string[]) => {
    let unchanged = 0, last = measured.current;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise<void>(done => requestAnimationFrame(() => done()));
      if (ids.every(id => measured.current[id]) && frame.current === undefined && last === measured.current) unchanged++;
      else unchanged = 0;
      last = measured.current;
      if (unchanged >= 2) return;
    }
    throw new Error('阅读尺寸尚未就绪');
  };
  return { placements, measure, waitForMeasurements, gesture: setGesture, manual: (placement: LayoutPlacement) => { manual.current = placement; } };
}

export function ReadingSurface({ id, name, position, baseline, measure, gesture, commit, takeover, children, active, articleRef }: {
  id: string; name: string; position: LayoutNode; baseline: LayoutNode; active: boolean; articleRef: React.RefObject<HTMLElement | null>;
  measure(id: string, width: number, height: number): void; gesture(placement?: LayoutPlacement): void;
  commit(placement: LayoutPlacement): void; takeover(): void; children: ReactNode;
}) {
  const element = useRef<HTMLElement>(null);
  const latest = useRef(measure); latest.current = measure;
  const drag = useRef<{ x: number; y: number; placement: LayoutPlacement; kind: 'move' | 'width' } | undefined>(undefined);
  const [width, setWidth] = useState<number>();
  const readWidth = width ?? (position.width >= 360 ? position.width : 650);
  useEffect(() => {
    const node = element.current!;
    const resource = observation.resource('reading.surfaces'); resource.set(1);
    const observer = new ResizeObserver(() => latest.current(id, node.offsetWidth, node.offsetHeight));
    observer.observe(node); return () => { observer.disconnect(); resource.close(); };
  }, [id]);
  useEffect(() => { if (active) articleRef.current = element.current; }, [active, articleRef]);
  const start = (event: PointerEvent<HTMLElement>, kind: 'move' | 'width') => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); takeover();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, placement: { ...position, width: readWidth }, kind };
    gesture(drag.current.placement);
  };
  const move = (event: PointerEvent<HTMLElement>, finish = false) => {
    if (!drag.current) return;
    event.preventDefault(); event.stopPropagation();
    const scale = element.current!.getBoundingClientRect().width / element.current!.offsetWidth;
    const { x, y, placement, kind } = drag.current;
    const next = kind === 'move' ? { ...placement, x: placement.x + (event.clientX - x) / scale, y: placement.y + (event.clientY - y) / scale } :
      { ...placement, width: Math.round(Math.max(360, Math.min(1800, placement.width + (event.clientX - x) / scale))) };
    if (kind === 'width') setWidth(next.width);
    gesture(next);
    if (finish) { drag.current = undefined; commit(kind === 'width' ? { ...baseline, width: next.width } : next); gesture(undefined); }
  };
  const cancel = () => { if (drag.current?.kind === 'width') setWidth(drag.current.placement.width); drag.current = undefined; gesture(undefined); };
  useEffect(()=>{const key=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'&&drag.current){event.preventDefault();cancel();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  useEffect(()=>{if(!drag.current)setWidth(baseline.width>=360?baseline.width:650);},[baseline.width]);
  return <article ref={element} className="nodrag nopan nowheel" style={{ width: readWidth }} data-unit-id={id} data-agent-unit={id} data-reading-active={active ? "true" : undefined}>
    <div className="layout-controls" aria-label={`${name}布局`}>
      <button aria-label={`移动${name}`} onPointerDown={e => start(e, 'move')} onPointerMove={e => move(e)} onPointerUp={e => move(e, true)} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={event => { const delta: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }; if (!delta[event.key]) return; event.preventDefault(); takeover(); commit({ ...position, width: readWidth, x: position.x + delta[event.key][0], y: position.y + delta[event.key][1] }); }}>移动单元</button>
      <span>宽度 {Math.round(readWidth)}</span>
      <div role="slider" tabIndex={0} aria-label={`调整${name}宽度`} aria-valuemin={360} aria-valuemax={1800} aria-valuenow={Math.round(readWidth)} aria-orientation="horizontal"
        onPointerDown={e => start(e, 'width')} onPointerMove={e => move(e)} onPointerUp={e => move(e, true)} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); takeover(); const next = event.key === 'Home' ? 360 : event.key === 'End' ? 1800 : Math.max(360, Math.min(1800, readWidth + (event.key === 'ArrowRight' ? 24 : -24))); setWidth(next); commit({ ...baseline, width: next }); }}>拖动调宽</div>
    </div>{children}
  </article>;
}
