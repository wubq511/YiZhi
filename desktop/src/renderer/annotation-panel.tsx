import type { SearchHit } from '../search-api';
import { paintFrame, waitForSearchElement } from './search-location';
import { createPortal } from 'react-dom';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AnnotationSelection, PersonalNote } from '../annotation-api';
import './annotation-panel.css';
export interface AnnotationScene { open: boolean; active?: string; scrollTop: number }
export interface AnnotationPanelHandle { capture(): AnnotationScene; restore(scene: AnnotationScene): Promise<void>; openSearch(hit: SearchHit): Promise<void>; create(selection: AnnotationSelection): Promise<void>; flush(): Promise<boolean> }
export const AnnotationPanel = forwardRef<AnnotationPanelHandle, { sessionId: string; narrow: boolean; prepare(): Promise<boolean>; onOpenChange(open: boolean): void; locate(note: PersonalNote): Promise<void> }>(function AnnotationPanel({ sessionId, narrow, prepare, onOpenChange, locate }, ref) {
  const [searchHit, setSearchHit] = useState<SearchHit>();
  const [open, setOpen] = useState(false), [notes, setNotes] = useState<PersonalNote[]>([]);
  const [locating, setLocating] = useState(false), [creating, setCreating] = useState(false);
  const [active, setActive] = useState<string>(), [status, setStatus] = useState('已保存'), [error, setError] = useState<string>();
  const reassociation = useRef<AnnotationSelection | undefined>(undefined);
  const values = useRef(new Map<string, string>()), histories = useRef(new Map<string, { undo: string[]; redo: string[] }>());
  const cache = useRef(new Map<string, PersonalNote>()), dirty = useRef(new Set<string>());
  const creation = useRef<Parameters<typeof window.yizhi.annotations.create>[0] | undefined>(undefined);
  const pending = useRef<Parameters<typeof window.yizhi.annotations.update>[0] | undefined>(undefined);
  const work = useRef<Promise<boolean> | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), composing = useRef(false);
  const opener = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const publish = () => setNotes([...cache.current.values()]);
  const show = (value: boolean) => { setOpen(value); onOpenChange(value); if (!value) requestAnimationFrame(() => opener.current?.focus()); };
  const refresh = async () => {
    const current = await window.yizhi.annotations.list({ sessionId });
    for (const note of current) {
      const local = cache.current.get(note.id);
      if (!local || note.version >= local.version) cache.current.set(note.id, note);
      if (!dirty.current.has(note.id) && pending.current?.id !== note.id) values.current.set(note.id, note.text);
    }
    publish(); setActive(previous => previous ?? current[0]?.id);
  };
  const flush = (): Promise<boolean> => {
    clearTimeout(timer.current); clearTimeout(maxTimer.current); timer.current = maxTimer.current = undefined;
    if (composing.current) { setStatus('未保存'); setError('请先完成笔记输入，再关闭窗口。'); return Promise.resolve(false); }
    if (work.current) return work.current;
    const run = async () => {
      try {
        while (creation.current || pending.current || dirty.current.size) {
          if (creation.current) {
            const request = creation.current;
            const note = await window.yizhi.annotations.query({ sessionId, operationId: request.operationId }) ?? await window.yizhi.annotations.create(request);
            creation.current = undefined; cache.current.set(note.id, note); setCreating(false);
            if (!values.current.has(note.id)) values.current.set(note.id, note.text);
            publish(); setActive(note.id); requestAnimationFrame(() => input.current?.focus());
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
    async restore(scene) { setSearchHit(undefined); if (!await flush()) throw new Error('笔记输入尚未保存'); show(scene.open); setActive(scene.active); await paintFrame(); if (panel.current) panel.current.scrollTop = scene.scrollTop; },
    async openSearch(hit) {
      if (!await flush()) throw new Error('笔记输入尚未保存');
      await refresh(); const note = cache.current.get(hit.noteId!);
      if (!note || String(note.version) !== hit.version || note.text !== hit.text) throw new Error('笔记版本已变化，请重新搜索');
      setSearchHit(hit); show(true); setActive(note.id); await paintFrame();
      const textarea = await waitForSearchElement(() => input.current?.dataset.noteId === note.id ? input.current : null) as HTMLTextAreaElement;
      textarea.focus({ preventScroll: true }); textarea.dataset.searchCurrent = 'true';
      textarea.setSelectionRange(Array.from(hit.text).slice(0, hit.start).join('').length, Array.from(hit.text).slice(0, hit.end).join('').length);
    }, async create(selection) {
    show(true); setCreating(true); setError(undefined);
    try {
      if (!await prepare()) { setCreating(false); setError('正文输入尚未保存，请先重试正文保存，再添加批注。'); return; }
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
    return () => { stopped = true; clearInterval(interval); clearTimeout(timer.current); clearTimeout(maxTimer.current); };
  }, [sessionId, open]);
  useEffect(() => { if (open && narrow) panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [open, narrow]);
  const edit = (text: string, record = true) => {
    if (!active) return;
    const history = histories.current.get(active) ?? { undo: [], redo: [] };
    if (record) { history.undo.push(values.current.get(active) ?? ''); history.redo = []; }
    histories.current.set(active, history); values.current.set(active, text); dirty.current.add(active); publish(); setStatus('待保存');
    clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 250);
    maxTimer.current ??= setTimeout(() => void flush(), 1000);
  };
  const undo = (redo = false) => {
    if (!active) return; const history = histories.current.get(active); if (!history) return;
    const source = redo ? history.redo : history.undo, destination = redo ? history.undo : history.redo;
    const text = source.pop(); if (text === undefined) return;
    destination.push(values.current.get(active) ?? ''); edit(text, false);
  };
  const close = async () => { if (await flush()) show(false); };
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
  return <>
    <button ref={opener} onClick={() => { if (open) void close(); else show(true); }} aria-expanded={open}>个人批注</button>
    {open && createPortal(<section ref={panel} className="annotation-panel" role={narrow ? 'dialog' : 'region'} aria-modal={narrow || undefined} aria-label="个人批注" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); void close(); }
      if (narrow && event.key === 'Tab') {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,summary')];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <div className="annotation-heading"><h2>个人批注</h2><button onClick={() => void close()}>关闭批注</button></div>
      {!notes.length && <p>选择正文文字或公式片段后添加批注。原引用会随笔记保留。</p>}
      {notes.length > 1 && <nav aria-label="批注列表">{notes.map((n, i) => <button key={n.id} aria-current={n.id === active ? 'true' : undefined} onClick={() => setActive(n.id)}>{n.text.slice(0, 20) || `批注 ${i + 1}`} · {n.current.status === 'orphan' ? '待重新关联' : '已关联'}</button>)}</nav>}
      {creating && <p role="status">{error ? '批注尚未建立，请重试后继续填写。' : '正在建立批注…'}</p>}
      {current && !creating && <>
        <p className="annotation-association">{current.current.status === 'orphan' ? '待重新关联 · 原引用与笔记已保留' : `已关联 · ${current.current.fragments.length} 个有序片段`}</p>
        <blockquote>{current.original.fragments.map(f => f.quote).join('\n')}</blockquote>
        <label className="annotation-label">批注内容<textarea ref={input} data-note-id={current.id} data-search-current={searchHit?.noteId === current.id ? "true" : undefined} aria-label="批注内容" value={values.current.get(current.id) ?? current.text}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; void flush(); }}
          onChange={e => edit(e.target.value)} onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); undo(event.shiftKey || event.key.toLowerCase() === 'y'); }
          }} /></label>
        <div className="annotation-actions"><button onClick={() => undo()}>撤销笔记</button><button onClick={() => undo(true)}>重做笔记</button>
          <button disabled={locating || current.current.status !== 'attached'} onClick={() => { setLocating(true); setError(undefined); void locate(current).catch(e => setError(e.message)).finally(() => setLocating(false)); }}>{locating ? '正在定位…' : '定位当前选段'}</button>
          <button onPointerDown={() => { reassociation.current = (document.querySelector('[data-reading-active="true"] [aria-label="连续编辑正文"]') as any)?.editor?.storage.courseSelection.captureAnnotation(); }} onMouseDown={e => e.preventDefault()} onClick={() => void reassociate()}>关联到当前选段</button></div>
        <details><summary>书写时的原引用与语境</summary>{current.original.fragments.map((f, i) => <div key={i} className="annotation-context"><p>{f.blockId} · 正文版本 {f.formalRevision} · {f.source === 'formal' ? '正式内容' : '学生草稿'}</p>
          <pre>{String(f.block.payload[f.field])}</pre><p>原选段：{f.quote}</p></div>)}</details>
      </>}
      <p role="status" aria-label="批注同步状态">{status}</p>
      {error && <div role="alert"><p>{error}</p><button onClick={() => void flush()}>重试保存批注</button></div>}
    </section>, document.body)}
  </>;
});
