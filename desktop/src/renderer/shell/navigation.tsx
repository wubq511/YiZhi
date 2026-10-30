import { BookOpen, Files, Search, StickyNote } from 'lucide-react';
import { useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Button } from '../components/ui/button';
import { usePanels, type LeftPanel } from './panels';
export function NavigationRail({ beforeOpen }: { beforeOpen(id: LeftPanel): void }) {
  const shell = usePanels(), reduced = useReducedMotion();
  const prepared = useRef(false);
  const items = [{ id: 'search', label: '搜索', name: '搜索课程', icon: Search }, { id: 'directory', label: '目录', name: '课程目录', icon: BookOpen }, { id: 'notes', label: '笔记', name: '个人批注', icon: StickyNote }, { id: 'sources', label: '资料', name: '原文资料', icon: Files }] as const;
  return <nav className="shell-rail" aria-label="工作区导航">{items.map(({ id, label, name, icon: Icon }) => <Button key={id} variant="ghost" className="rail-item" aria-label={name} aria-expanded={shell.visibleLeft === id} title={id === 'search' ? '搜索课程 ⌘K' : name} onPointerDown={() => { beforeOpen(id); prepared.current=true; }} onKeyDown={event => { if (['Enter',' '].includes(event.key)) { beforeOpen(id); prepared.current=true; } }} onClick={() => { if(!prepared.current)beforeOpen(id); prepared.current=false; shell.set(id as LeftPanel, shell.visibleLeft !== id); }}>
    {shell.visibleLeft === id && <motion.span className="rail-selection" layoutId="active-panel" transition={{ duration: reduced ? 0 : .18 }}/>}<Icon size={20}/>{id !== 'search' && <span>{label}</span>}
  </Button>)}</nav>;
}
