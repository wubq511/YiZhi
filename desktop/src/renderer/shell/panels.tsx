import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
export type LeftPanel = 'directory' | 'search' | 'notes' | 'sources';
export type Panel = LeftPanel | 'agent';
type DockSide = 'left' | 'agent';
const railWidth = 64, boardMin = 480;
const limits: Record<DockSide, { min: number; default: number; max: number }> = {
  left: { min: 260, default: 330, max: 560 },
  agent: { min: 320, default: 360, max: 720 },
};
const widthKey = 'yizhi.shell.panel-widths.v1';
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), max);
const readWidths = (): Record<DockSide, number> => {
  const fallback = { left: limits.left.default, agent: limits.agent.default };
  try {
    const stored = JSON.parse(localStorage.getItem(widthKey) ?? '{}') as Record<string, unknown>;
    const pick = (side: DockSide) => {
      const value = Number(stored[side]);
      return Number.isFinite(value) && value > 0 ? clamp(value, limits[side].min, limits[side].max) : fallback[side];
    };
    return { left: pick('left'), agent: pick('agent') };
  } catch { return fallback; }
};
const persistWidths = (widths: Record<DockSide, number>) => { try { localStorage.setItem(widthKey, JSON.stringify(widths)); } catch { /* UI preference only */ } };
function usePanelState() {
  const activity = useRef(0);
  const [left, setLeft] = useState<LeftPanel | null>('directory');
  const [agent, setAgent] = useState(false);
  const [priority, setPriority] = useState<'left' | 'agent'>('left');
  const [width, setWidth] = useState(window.innerWidth);
  const [stored, setStored] = useState(readWidths);
  const storedRef = useRef(stored); storedRef.current = stored;
  const dragWidth = useRef<Partial<Record<DockSide, number>>>({});
  const [leftHost, setLeftHost] = useState<HTMLDivElement | null>(null);
  const [agentHost, setAgentHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { const update = () => setWidth(window.innerWidth); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update); }, []);
  const fitted = (side: DockSide) => width <= 760
    ? clamp(stored[side], limits[side].min, Math.max(limits[side].min, width - railWidth))
    : clamp(stored[side], limits[side].min, Math.max(limits[side].min, Math.min(limits[side].max, width - railWidth - 240)));
  const leftContentWidth = fitted('left'), agentContentWidth = fitted('agent');
  const cramped = !!left && agent && width < railWidth + leftContentWidth + agentContentWidth + boardMin;
  const visibleLeft = cramped && priority === 'agent' ? null : left;
  const visibleAgent = agent && !(cramped && priority === 'left');
  const bounds = (side: DockSide) => {
    const limit = limits[side];
    if (width <= 760) return { min: limit.min, max: Math.max(limit.min, width - railWidth) };
    const other = side === 'left' ? (visibleAgent ? agentContentWidth : 0) : (visibleLeft ? leftContentWidth : 0);
    return { min: limit.min, max: Math.max(limit.min, Math.min(limit.max, width - railWidth - other - boardMin)) };
  };
  const resizeWidth = (side: DockSide, next: number) => {
    const range = bounds(side), value = clamp(next, range.min, range.max);
    const updated = { ...storedRef.current, [side]: value };
    storedRef.current = updated;
    setStored(updated);
  };
  const commitWidth = () => persistWidths(storedRef.current);
  const resetWidth = (side: DockSide) => { resizeWidth(side, limits[side].default); commitWidth(); };
  const set = (id: Panel, open: boolean) => {
    activity.current++;
    if (!open && (id === 'agent' ? visibleAgent : visibleLeft === id)) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(id === 'agent' ? 'button[aria-label="学习对话"]' : `.shell-rail button[aria-label="${{directory:'课程目录',search:'搜索课程',notes:'个人批注',sources:'原文资料'}[id]}"]`)?.focus({preventScroll:true}));
    if (id === 'agent') { setAgent(open); if (open) setPriority('agent'); }
    else { setLeft(previous => open ? id : previous === id ? null : previous); if (open) setPriority('left'); }
  };
  return { activity: () => activity.current, capture: () => ({left,agent,priority}), restore: (scene:{left:LeftPanel|null;agent:boolean;priority:'left'|'agent'}, options:{keepLeft?:boolean} = {}) => { if (!options.keepLeft) { setLeft(scene.left); setPriority(scene.priority); } setAgent(scene.agent); return ++activity.current; }, left, agent, visibleLeft, visibleAgent, set, leftHost, agentHost, setLeftHost, setAgentHost,
    leftWidth: visibleLeft ? leftContentWidth : 0, agentWidth: visibleAgent ? agentContentWidth : 0, leftContentWidth, agentContentWidth, dragWidth: dragWidth.current,
    bounds, resizeWidth, commitWidth, resetWidth, focusSide: (side: DockSide) => setPriority(side), narrow: width <= 760 };
}
const PanelContext = createContext<ReturnType<typeof usePanelState> | null>(null);
export function ShellPanels({ children }: { children: ReactNode }) { const value = usePanelState(); return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>; }
export function usePanels() { return useContext(PanelContext)!; }
export function useDockPanel(id: Panel) {
  const shell = usePanels();
  return { open: id === 'agent' ? shell.visibleAgent : shell.visibleLeft === id, setOpen: (open: boolean) => shell.set(id, open) };
}
export function PanelPortal({ id, children }: { id: Panel; children: ReactNode }) {
  const shell = usePanels(), host = id === 'agent' ? shell.agentHost : shell.leftHost;
  const open = id === 'agent' ? shell.visibleAgent : shell.visibleLeft === id;
  return host ? createPortal(<div className="shell-panel-slot" hidden={!open} inert={!open} data-panel={id}>{children}</div>, host) : null;
}
function DockResizer({ side }: { side: DockSide }) {
  const shell = usePanels();
  const range = shell.bounds(side);
  const value = Math.round(shell.dragWidth[side] ?? (side === 'left' ? shell.leftContentWidth : shell.agentContentWidth));
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number; dock: HTMLElement; inner: HTMLElement; handle: HTMLElement; cursor: string; selection: string; cleanup(): void } | null>(null);
  const stop = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    current.cleanup();
    current.dock.style.transition = '';
    delete current.dock.dataset.resizing;
    delete current.handle.dataset.active;
    document.documentElement.style.cursor = current.cursor;
    document.body.style.userSelect = current.selection;
    if (commit) { shell.dragWidth[side] = undefined; shell.resizeWidth(side, current.width); shell.commitWidth(); }
    else { shell.dragWidth[side] = undefined; current.dock.style.width = `${current.startWidth}px`; current.inner.style.width = `${current.startWidth}px`; }
  };
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); stop(false); return; }
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft', shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (![grow, shrink, 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 48 : 16;
    const next = event.key === 'Home' ? range.min : event.key === 'End' ? range.max : event.key === grow ? value + step : value - step;
    shell.resizeWidth(side, next); shell.commitWidth();
  };
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    const handle = event.currentTarget;
    const dock = handle.parentElement, inner = dock?.querySelector<HTMLElement>('.shell-dock-inner');
    if (!dock || !inner) return;
    shell.focusSide(side);
    const startWidth = side === 'left' ? shell.leftContentWidth : shell.agentContentWidth;
    const move = (next: PointerEvent) => {
      const current = drag.current;
      if (!current || next.pointerId !== current.pointerId) return;
      const limit = shell.bounds(side), width = clamp(current.startWidth + (next.clientX - current.startX) * (side === 'left' ? 1 : -1), limit.min, limit.max);
      current.width = width;
      shell.dragWidth[side] = width;
      current.dock.style.width = `${width}px`;
      current.inner.style.width = `${width}px`;
      current.handle.setAttribute('aria-valuenow', String(width));
      current.handle.setAttribute('aria-valuetext', `${width} 像素`);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', commitPointer);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('blur', cancelPointer);
    };
    const commitPointer = () => stop(true), cancelPointer = () => stop(false);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth, dock, inner, handle, cursor: document.documentElement.style.cursor, selection: document.body.style.userSelect, cleanup };
    dock.style.transition = 'none'; dock.dataset.resizing = 'true'; handle.dataset.active = 'true';
    document.documentElement.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', commitPointer);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('blur', cancelPointer);
  };
  return <div className="shell-dock-resizer" role="separator" aria-orientation="vertical" tabIndex={0} title="拖动调整宽度，双击恢复默认" aria-label={side === 'left' ? '调整左侧面板宽度' : '调整学习对话宽度'} aria-controls={`shell-${side}-panel`} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={value} aria-valuetext={`${value} 像素`}
    onPointerDown={start} onKeyDown={key} onDoubleClick={() => shell.resetWidth(side)} />;
}
export function PanelDock({ side, children }: { side: DockSide; children?: ReactNode }) {
  const shell = usePanels();
  const dragging = shell.dragWidth[side];
  const width = dragging ?? (side === 'left' ? shell.leftWidth : shell.agentWidth);
  const contentWidth = dragging ?? (side === 'left' ? shell.leftContentWidth : shell.agentContentWidth);
  return <div className={`shell-dock shell-dock-${side}`} data-open={width > 0} inert={!width} style={{ width }}>
    <div className="shell-dock-clip"><div className="shell-dock-inner" id={`shell-${side}-panel`} style={{ width: contentWidth }} ref={side === 'left' ? shell.setLeftHost : shell.setAgentHost}>{children}</div></div>
    <DockResizer side={side}/>
  </div>;
}
