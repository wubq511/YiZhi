import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
export type LeftPanel = 'directory' | 'search' | 'notes' | 'sources';
export type Panel = LeftPanel | 'agent';
const widths: Record<LeftPanel, number> = { directory: 250, search: 330, notes: 330, sources: 440 };
function usePanelState() {
  const activity = useRef(0);
  const [left, setLeft] = useState<LeftPanel | null>('directory');
  const [agent, setAgent] = useState(false);
  const [priority, setPriority] = useState<'left' | 'agent'>('left');
  const [width, setWidth] = useState(window.innerWidth);
  const [leftHost, setLeftHost] = useState<HTMLDivElement | null>(null);
  const [agentHost, setAgentHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { const update = () => setWidth(window.innerWidth); window.addEventListener('resize', update); return () => window.removeEventListener('resize', update); }, []);
  const cramped = !!left && agent && width < 64 + widths[left] + 360 + 480;
  const visibleLeft = cramped && priority === 'agent' ? null : left;
  const visibleAgent = agent && !(cramped && priority === 'left');
  const set = (id: Panel, open: boolean) => {
    activity.current++;
    if (!open && (id === 'agent' ? visibleAgent : visibleLeft === id)) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(id === 'agent' ? 'button[aria-label="学习对话"]' : `.shell-rail button[aria-label="${{directory:'课程目录',search:'搜索课程',notes:'个人批注',sources:'原文资料'}[id]}"]`)?.focus({preventScroll:true}));
    if (id === 'agent') { setAgent(open); if (open) setPriority('agent'); }
    else { setLeft(previous => open ? id : previous === id ? null : previous); if (open) setPriority('left'); }
  };
  return { activity: () => activity.current, capture: () => ({left,agent,priority}), restore: (scene:{left:LeftPanel|null;agent:boolean;priority:'left'|'agent'}) => {setLeft(scene.left);setAgent(scene.agent);setPriority(scene.priority);return ++activity.current;}, left, agent, visibleLeft, visibleAgent, set, leftHost, agentHost, setLeftHost, setAgentHost,
    leftWidth: visibleLeft ? Math.min(width - 64, widths[visibleLeft]) : 0, narrow: width <= 760 };
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
export function PanelDock({ side, children }: { side: 'left' | 'agent'; children?: ReactNode }) {
  const shell = usePanels(), reduced = useReducedMotion();
  const width = side === 'left' ? shell.leftWidth : shell.visibleAgent ? Math.min(window.innerWidth - 64, 360) : 0;
  return <motion.div className={`shell-dock shell-dock-${side}`} data-open={width > 0} initial={false} animate={{ width }} transition={{ duration: reduced ? 0 : .18, ease: [0.22, 1, 0.36, 1] }} inert={!width}>
    <div className="shell-dock-inner" style={{ width: side === 'left' ? shell.leftWidth || 250 : Math.min(window.innerWidth - 64, 360) }} ref={side === 'left' ? shell.setLeftHost : shell.setAgentHost}>{children}</div>
  </motion.div>;
}
