import { useEffect, useSyncExternalStore } from 'react';
export interface EditHistory { label: string; element(): Element | null; canUndo(): boolean; canRedo(): boolean; undo(): void; redo(): void }
const contexts = new Map<string, EditHistory>(), listeners = new Set<() => void>();
let current: string | undefined;
let snapshot = { label: '当前编辑', canUndo: false, canRedo: false };
export function refreshHistory() {
  const c = current && contexts.get(current);
  snapshot = { label: c ? c.label : '当前编辑', canUndo: !!c && c.canUndo(), canRedo: !!c && c.canRedo() };
  listeners.forEach(fn => fn());
}
export function registerHistory(id: string, value: EditHistory) { contexts.set(id, value); refreshHistory(); return () => { contexts.delete(id); if (current === id) current = undefined; refreshHistory(); }; }
export function activateHistory(id: string) { current = id; refreshHistory(); }
export function useEditHistory() {
  useEffect(() => {
    const select = (event: Event) => {
      const target = event.composedPath()[0]; if (!(target instanceof Element)) return;
      if (target.closest('.canvas-toolbar,[data-slot^="dropdown-menu"]')) return;
      const math = event.composedPath().find(node => node instanceof Element && node.matches('math-field')) as (HTMLElement & {readOnly:boolean;canUndo():boolean;canRedo():boolean;executeCommand(command:string):void}) | undefined;
      if (math) { contexts.set('formula', { label:'公式', element:()=>math, canUndo:()=>math.isConnected&&!math.readOnly&&math.canUndo(), canRedo:()=>math.isConnected&&!math.readOnly&&math.canRedo(), undo:()=>{math.executeCommand('undo');}, redo:()=>{math.executeCommand('redo');} }); current='formula'; refreshHistory(); return; }
      let match: [string, EditHistory] | undefined;
      for (const item of contexts) {
        const element = item[1].element();
        if (element?.contains(target) && (!match || match[1].element()?.contains(element))) match = item;
      }
      // Native fields and MathLive own their own histories. Never fall back to the board.
      if (match?.[0] === 'board' && target.closest('input,textarea,select,math-field,[contenteditable=true]')) match = undefined;
      current = match?.[0]; refreshHistory();
    };
    document.addEventListener('undo-state-change', refreshHistory, true);
    document.addEventListener('input', refreshHistory, true);
    document.addEventListener('focusin', select); document.addEventListener('pointerdown', select, true);
    return () => { document.removeEventListener('undo-state-change', refreshHistory, true); document.removeEventListener('input', refreshHistory, true); document.removeEventListener('focusin', select); document.removeEventListener('pointerdown', select, true); };
  }, []);
  const state = useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => snapshot);
  return { ...state, undo: () => { const c = current && contexts.get(current); if (c && c.canUndo()) c.undo(); refreshHistory(); }, redo: () => { const c = current && contexts.get(current); if (c && c.canRedo()) c.redo(); refreshHistory(); } };
}
