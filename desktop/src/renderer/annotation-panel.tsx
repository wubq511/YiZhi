import { registerHistory, refreshHistory } from './shell/edit-history';
import { PanelPortal, useDockPanel } from './shell/panels';
import { useSaveReport } from './shell/save-status';
import { X } from 'lucide-react';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import type { SearchHit } from '../search-api';
import { paintFrame, waitForSearchElement } from './search-location';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import type { AnnotationSelection, PersonalNote } from '../annotation-api';
import './annotation-panel.css';
export interface AnnotationScene { open: boolean; active?: string; scrollTop: number }
export interface AnnotationPanelHandle { capture(): AnnotationScene; restore(scene: AnnotationScene, restoreVisibility?: boolean): Promise<void>; openSearch(hit: SearchHit): Promise<void>; create(selection: AnnotationSelection): Promise<void>; flush(): Promise<boolean> }

// Keep the initial value stable for this note: a render must not write into the
// native editor between the browser's insertion and React receiving input.
function NoteTextarea({ defaultValue, ...props }: ComponentProps<typeof Textarea>) {
  const initialValue = useRef(defaultValue);
  return <Textarea {...props} defaultValue={initialValue.current} />;
}

export const AnnotationPanel = forwardRef<AnnotationPanelHandle, { sessionId: string; narrow: boolean; prepare(): Promise<boolean>; locate(note: PersonalNote): Promise<void> }>(function AnnotationPanel({ sessionId, narrow, prepare, locate }, ref) {
  const [searchHit, setSearchHit] = useState<SearchHit>();
  const { open, setOpen } = useDockPanel('notes');
  const [notes, setNotes] = useState<PersonalNote[]>([]);
  const [locating, setLocating] = useState(false), [creating, setCreating] = useState(false);
  const [active, setActive] = useState<string>(), [status, setStatus] = useState('已保存'), [error, setError] = useState<string>();
  const reassociation = useRef<AnnotationSelection | undefined>(undefined);
  const values = useRef(new Map<string, string>()), histories = useRef(new Map<string, { undo: string[]; redo: string[] }>());
  const cache = useRef(new Map<string, PersonalNote>()), dirty = useRef(new Set<string>());
  const creation = useRef<Parameters<typeof window.yizhi.annotations.create>[0] | undefined>(undefined);
  const pending = useRef<Parameters<typeof window.yizhi.annotations.update>[0] | undefined>(undefined);
  const work = useRef<Promise<boolean> | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const preparing = useRef<Promise<boolean> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), composing = useRef(false);
  const panel = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const focusAfterCreate = useRef<{ id: string; previous: Element | null } | undefined>(undefined);
  const createFocusOrigin = useRef<Element | null>(null);
  const publish = () => setNotes([...cache.current.values()]);
  const show = (value: boolean) => { setOpen(value); };
  const refresh = async () => {
    const current = await window.yizhi.annotations.list({ sessionId });
    for (const note of current) {
      const local = cache.current.get(note.id);
      const editor = input.current?.dataset.noteId === note.id ? input.current : null;
      const previous = values.current.get(note.id) ?? local?.text ?? note.text;
      const editing = dirty.current.has(note.id) || pending.current?.id === note.id ||
        !!editor && (document.activeElement === editor || editor.value !== previous);
      // Do not advance the write basis past another text edit while this note is being edited.
      if (local && note.version > local.version && note.text !== local.text && editing) continue;
      if (!local || note.version >= local.version) {
        cache.current.set(note.id, note);
        if (!dirty.current.has(note.id) && pending.current?.id !== note.id) {
          // A focused editor, or a DOM value not yet observed by onChange, belongs to the student.
          if (!editor || (document.activeElement !== editor && editor.value === previous)) {
            values.current.set(note.id, note.text);
            if (editor && editor.value !== note.text) editor.value = note.text;
          }
        }
      }
    }
    publish(); setActive(previous => previous ?? current[0]?.id);
  };
  const captureInput = () => {
    const editor = input.current, editorId = editor?.dataset.noteId;
    if (editor && editorId && editor.value !== values.current.get(editorId)) edit(editor.value, true, editorId);
  };
  const flush = (): Promise<boolean> => {
    captureInput();
    clearTimeout(timer.current); clearTimeout(maxTimer.current); timer.current = maxTimer.current = undefined;
    if (composing.current) { setStatus('未保存'); setError('请先完成笔记输入，再关闭窗口。'); return Promise.resolve(false); }
    if (preparing.current) return preparing.current.then(ok => ok ? flush() : false, () => false);
    if (work.current) return work.current.then(ok => ok && (creation.current || pending.current || dirty.current.size ? flush() : true));
    const run = async () => {
      try {
        while (creation.current || pending.current || dirty.current.size) {
          if (creation.current) {
            const request = creation.current;
            const note = await window.yizhi.annotations.query({ sessionId, operationId: request.operationId }) ?? await window.yizhi.annotations.create(request);
            creation.current = undefined; cache.current.set(note.id, note); setCreating(false);
            if (!values.current.has(note.id)) values.current.set(note.id, note.text);
            focusAfterCreate.current = { id: note.id, previous: createFocusOrigin.current };
            publish(); setActive(note.id);
            continue;
          }
          const id = pending.current?.id ?? [...dirty.current][0], note = cache.current.get(id)!;
          const request = pending.current ?? { sessionId, operationId: `note-${crypto.randomUUID()}`, id, expectedVersion: note.version, text: values.current.get(id) ?? note.text };
          pending.current = request; setStatus('正在保存…');
          const receipt = await window.yizhi.annotations.query({ sessionId, operationId: request.operationId }) ?? await window.yizhi.annotations.update(request);
          cache.current.set(id, receipt); pending.current = undefined;
          if (values.current.get(id) === receipt.text) dirty.current.delete(id);
          publish();
        }
        setStatus('已保存'); setError(undefined); return true;
      } catch (e) { setStatus('未保存'); setError((e as Error).message); return false; }
      finally { work.current = undefined; }
    };
    work.current = Promise.resolve().then(run); return work.current;
  };
  useImperativeHandle(ref, () => ({ flush,
    capture: () => ({ open, active, scrollTop: panel.current?.scrollTop ?? 0 }),
    async restore(scene, restoreVisibility = true) { setSearchHit(undefined); if (!await flush()) throw new Error('笔记输入尚未保存'); if (restoreVisibility) show(scene.open); setActive(scene.active); await paintFrame(); if (panel.current) panel.current.scrollTop = scene.scrollTop; },
    async openSearch(hit) {
      if (!await flush()) throw new Error('笔记输入尚未保存');
      await refresh(); const note = cache.current.get(hit.noteId!);
      if (!note || String(note.version) !== hit.version || note.text !== hit.text) throw new Error('笔记版本已变化，请重新搜索');
      setSearchHit(hit); show(true); setActive(note.id); await paintFrame();
      const textarea = await waitForSearchElement(() => input.current?.dataset.noteId === note.id ? input.current : null) as HTMLTextAreaElement;
      if (dirty.current.has(note.id) || pending.current?.id === note.id || textarea.value !== (values.current.get(note.id) ?? note.text)) throw new Error('笔记输入已变化，请保存后重新搜索');
      values.current.set(note.id, note.text);
      if (textarea.value !== note.text) textarea.value = note.text;
      textarea.focus({ preventScroll: true }); textarea.dataset.searchCurrent = 'true';
      textarea.setSelectionRange(Array.from(hit.text).slice(0, hit.start).join('').length, Array.from(hit.text).slice(0, hit.end).join('').length);
    }, async create(selection) {
    captureInput();
    if (composing.current) { setStatus('未保存'); setError('请先完成笔记输入，再添加批注。'); return; }
    createFocusOrigin.current = document.activeElement;
    show(true); setCreating(true); setError(undefined);
    try {
      const preparation = prepare(); preparing.current = preparation;
      let prepared: boolean;
      try { prepared = await preparation; } finally { if (preparing.current === preparation) preparing.current = undefined; }
      if (!prepared) { setCreating(false); setError('正文输入尚未保存，请先重试正文保存，再添加批注。'); return; }
      if (creation.current && !await flush()) return;
      setCreating(true);
      creation.current = { sessionId, operationId: `note-create-${crypto.randomUUID()}`, selection, text: '' };
      await flush();
    } catch (e) { setCreating(false); setError((e as Error).message); }
  } }));
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    const poll = () => { if (!stopped) void refresh().catch(e => { if (!stopped) setError((e as Error).message); }); };
    poll(); const interval = setInterval(poll, 400);
    return () => { stopped = true; clearInterval(interval); };
  }, [sessionId, open]);
  useLayoutEffect(() => {
    const focus = focusAfterCreate.current;
    if (!focus || focus.id !== active || creating || !input.current) return;
    focusAfterCreate.current = undefined;
    if (open && (document.activeElement === focus.previous || document.activeElement === document.body)) input.current.focus();
  }, [active, creating, notes, open]);
  useEffect(() => { if (open && narrow && !panel.current?.contains(document.activeElement)) panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [open, narrow]);
  const edit = (text: string, record = true, id = active) => {
    if (!id || text === values.current.get(id)) return;
    const history = histories.current.get(id) ?? { undo: [], redo: [] };
    if (record) { history.undo.push(values.current.get(id) ?? ''); history.redo = []; }
    histories.current.set(id, history); values.current.set(id, text); dirty.current.add(id); publish(); setStatus('待保存');
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 250);
    maxTimer.current ??= setTimeout(() => void flush(), 1000);
  };
  const undo = (redo = false) => {
    if (!active) return; const history = histories.current.get(active); if (!history) return;
    const source = redo ? history.redo : history.undo, destination = redo ? history.undo : history.redo;
    const text = source.pop(); if (text === undefined) return;
    destination.push(values.current.get(active) ?? '');
    if (input.current?.dataset.noteId === active) input.current.value = text;
    edit(text, false);
  };
  const historyActions = useRef({undo}); historyActions.current = {undo};
  useEffect(() => registerHistory('notes', { label: '笔记', element: () => input.current, canUndo: () => !!active && !!histories.current.get(active)?.undo.length, canRedo: () => !!active && !!histories.current.get(active)?.redo.length, undo: () => historyActions.current.undo(), redo: () => historyActions.current.undo(true) }), [active]);
  useEffect(() => { refreshHistory(); }, [notes]);
  const close = async () => { if (await flush()) show(false); };
  useSaveReport('notes', { label: '笔记', status: status === '未保存' ? 'error' : status === '已保存' ? 'saved' : 'pending', detail: error, retry: flush });
  const current = notes.find(n => n.id === active);
  const reassociate = async () => {
    setError(undefined);
    // Capture synchronously while the editor still owns the shown selection.
    const capture = reassociation.current ?? (document.querySelector('[data-reading-active="true"] [aria-label="连续编辑正文"]') as any)?.editor?.storage.courseSelection.captureAnnotation();
    reassociation.current = undefined;
    if (!capture?.fragments.length || !current) { setError('请先在正文或公式中选择新的关联片段。'); return; }
    if (!await flush()) return;
    try {
      const latest = cache.current.get(current.id)!;
      const note = await window.yizhi.annotations.reassociate({ sessionId, operationId: `note-reassociate-${crypto.randomUUID()}`, id: current.id, expectedVersion: latest.version, selection: capture });
      cache.current.set(note.id, note); publish();
    } catch (e) { setError((e as Error).message); }
  };
  return <PanelPortal id="notes"><section ref={panel} className="annotation-panel" role={narrow ? 'dialog' : 'region'} aria-modal={narrow || undefined} aria-label="个人批注" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); void close(); }
      if (narrow && event.key === 'Tab') {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,summary')];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <div className="annotation-heading"><h2>个人批注</h2><Button variant="ghost" size="icon-sm" className="panel-close" aria-label="关闭批注" onClick={() => void close()}><X size={18}/></Button></div>
      {!notes.length && <p>选择正文文字或公式片段后添加批注。原引用会随笔记保留。</p>}
      {notes.length > 1 && <nav aria-label="批注列表">{notes.map((n, i) => <Button variant="outline" size="sm" key={n.id} aria-current={n.id === active ? 'true' : undefined} onClick={() => { captureInput(); if (!composing.current) setActive(n.id); else { setStatus('未保存'); setError('请先完成笔记输入，再切换批注。'); } }}>{n.text.slice(0, 20) || `批注 ${i + 1}`} · {n.current.status === 'orphan' ? '待重新关联' : '已关联'}</Button>)}</nav>}
      {creating && <p role="status">{error ? '批注尚未建立，请重试后继续填写。' : '正在建立批注…'}</p>}
      {current && !creating && <>
        <p className="annotation-association">{current.current.status === 'orphan' ? '待重新关联 · 原引用与笔记已保留' : `已关联 · ${current.current.fragments.length} 个有序片段`}</p>
        <blockquote>{current.original.fragments.map(f => f.quote).join('\n')}</blockquote>
        <label className="annotation-label">批注内容<NoteTextarea key={current.id} ref={input} data-note-id={current.id} data-search-current={searchHit?.noteId === current.id ? "true" : undefined} aria-label="批注内容" defaultValue={values.current.get(current.id) ?? current.text}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; void flush(); }}
          onChange={e => edit(e.target.value, true, current.id)} onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); undo(event.shiftKey || event.key.toLowerCase() === 'y'); }
          }} /></label>
        <div className="annotation-actions"><Button variant="outline" size="sm" onClick={() => undo()}>撤销笔记</Button><Button variant="outline" size="sm" onClick={() => undo(true)}>重做笔记</Button>
          <Button variant="outline" size="sm" disabled={locating || current.current.status !== 'attached'} onClick={() => { setLocating(true); setError(undefined); void locate(current).catch(e => setError(e.message)).finally(() => setLocating(false)); }}>{locating ? '正在定位…' : '定位当前选段'}</Button>
          <Button variant="outline" size="sm" onPointerDown={() => { reassociation.current = (document.querySelector('[data-reading-active="true"] [aria-label="连续编辑正文"]') as any)?.editor?.storage.courseSelection.captureAnnotation(); }} onMouseDown={e => e.preventDefault()} onClick={() => void reassociate()}>关联到当前选段</Button></div>
        <details><summary>书写时的原引用与语境</summary>{current.original.fragments.map((f, i) => <div key={i} className="annotation-context"><p>{f.blockId} · 正文版本 {f.formalRevision} · {f.source === 'formal' ? '正式内容' : '学生草稿'}</p>
          <pre>{String(f.block.payload[f.field])}</pre><p>原选段：{f.quote}</p></div>)}</details>
      </>}
      <p role="status" aria-label="批注同步状态">{status}</p>
      {error && <div role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={() => void flush()}>重试保存批注</Button></div>}
    </section></PanelPortal>
  ;
});
