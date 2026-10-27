import { AgentProse } from './agent-prose';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentTask, Conversation, ConversationView, ExecutorStatus, QuestionTarget, SubmitQuestion } from '../agent-api';
import type { SourceCitation } from '../sources-api';
import './agent-panel.css';
export interface AgentPanelHandle { flush(): Promise<boolean>; attachCitation(citation: SourceCitation): void }
const taskLabel: Record<AgentTask['status'], string> = { running: '正在回答', completed: '回答已完成', failed: '回答失败', interrupted: '回答已中断', unknown: '执行结果未知' };
export const AgentPanel = forwardRef<AgentPanelHandle, {
  sessionId: string; narrow: boolean; target: QuestionTarget; targetName: string; sourceOpen: boolean;
  onOpenChange(open: boolean): void; openCitation(citation: SourceCitation): void;
}>(function AgentPanel({ sessionId, narrow, target, targetName, sourceOpen, onOpenChange, openCitation }, ref) {
  const api = window.yizhi.agent;
  const [open, setOpen] = useState(false), [conversations, setConversations] = useState<Conversation[]>([]);
  const [view, setView] = useState<ConversationView>(), [executor, setExecutor] = useState<ExecutorStatus>();
  const [model, setModel] = useState(''), [generation, setGeneration] = useState(1);
  const [attachments, setAttachments] = useState<SourceCitation[]>([]), [selection, setSelection] = useState<QuestionTarget>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [draftState, setDraftState] = useState('草稿已保存');
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  const current = useRef<string | null>(null), draft = useRef(''), seq = useRef(0), composing = useRef(false);
  const writes = useRef(Promise.resolve()), failed = useRef(false), dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retrySubmit = useRef<SubmitQuestion | null>(null), active = useRef(true);
  const list = async () => { const state = await api.list({ sessionId }); if (active.current) { setConversations(state.conversations); setGeneration(state.generation); } return state; };
  const refresh = async () => {
    const id = current.current;
    if (id) { const latest = await api.get({ sessionId, conversationId: id }); if (current.current === id && active.current) setView(latest); }
    await list();
    const status = await api.status(); if (active.current) setExecutor(status);
  };
  const flush = async () => {
    clearTimeout(timer.current); clearTimeout(deadline.current); deadline.current = undefined;
    if (composing.current) { setError('请先完成中文候选输入，再离开对话。'); return false; }
    if (dirty.current && current.current && !failed.current) {
      const id = current.current, text = draft.current, inputSeq = ++seq.current; dirty.current = false;
      writes.current = writes.current.then(async () => {
        try { await api.saveDraft({ sessionId, conversationId: id, seq: inputSeq, text }); if (id === current.current && !dirty.current) setDraftState('草稿已保存'); }
        catch (error) { failed.current = true; dirty.current = true; setDraftState('草稿未保存'); setError((error as Error).message); }
      });
    }
    await writes.current; return !failed.current && !composing.current;
  };
  const loadConversation = async (id: string) => {
    if (!await flush()) return;
    const next = await api.get({ sessionId, conversationId: id }); await api.select({ sessionId, conversationId: id });
    current.current = id; draft.current = next.draft.text; seq.current = next.draft.seq; dirty.current = false; retrySubmit.current = null;
    if (composer.current) composer.current.value = next.draft.text;
    setView(next); setAttachments([]); setSelection(undefined); setError(''); setDraftState('草稿已保存');
  };
  const create = async () => { if (!await flush()) return; const next = await api.create({ sessionId, operationId: crypto.randomUUID() }); await loadConversation(next.id); await list(); };
  useEffect(() => {
    active.current = true;
    void list().then(state => state.selectedId ? loadConversation(state.selectedId) : state.conversations[0] ? loadConversation(state.conversations[0].id) : create()).catch(error => setError(error.message));
    return () => { active.current = false; clearTimeout(timer.current); clearTimeout(deadline.current); };
  }, [sessionId]);
  useEffect(() => { if (!open) return; let cancelled = false;
    void api.status().then(status => { if (cancelled) return; setExecutor(status); setModel(old => old || status.models.find(m => m.isDefault)?.model || status.models[0]?.model || ''); });
    const interval = setInterval(() => void refresh().catch(error => setError(error.message)), 350);
    requestAnimationFrame(() => composer.current?.focus());
    return () => { cancelled = true; clearInterval(interval); };
  }, [open, sessionId]);
  useEffect(() => { onOpenChange(open); }, [open]);
  useEffect(() => { if (open && narrow && !sourceOpen) composer.current?.focus(); }, [sourceOpen, narrow]);
  useEffect(() => {
    const capture = () => {
      const range = window.getSelection(); if (!range?.rangeCount || range.isCollapsed || !range.toString().trim()) return;
      const node = range.anchorNode?.parentElement, article = node?.closest<HTMLElement>('article[data-agent-unit]');
      if (!article) return;
      const block = node?.closest<HTMLElement>('[data-agent-block]');
      setSelection({ unitId: article.dataset.agentUnit!, ...(block?.dataset.agentBlock ? { blockId: block.dataset.agentBlock } : {}), selectedText: range.toString() });
    };
    document.addEventListener('mouseup', capture); document.addEventListener('keyup', capture);
    return () => { document.removeEventListener('mouseup', capture); document.removeEventListener('keyup', capture); };
  }, []);
  useImperativeHandle(ref, () => ({ flush, attachCitation(citation) { setAttachments(old => old.some(c => c.id === citation.id) ? old : [...old, citation].slice(-8)); setOpen(true); } }));
  const close = async () => { if (!await flush()) return; setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); };
  const guard = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  const send = async () => {
    if (!await flush() || !current.current || composing.current) return;
    const request = retrySubmit.current ?? { sessionId, conversationId: current.current, operationId: crypto.randomUUID(), generation,
      text: draft.current, target: selection ?? target, citationIds: attachments.map(c => c.id), ...(model ? { model } : {}) };
    retrySubmit.current = request;
    await api.submit(request); retrySubmit.current = null;
    draft.current = ''; if (composer.current) composer.current.value = ''; dirty.current = false;
    setAttachments([]); setSelection(undefined); await refresh();
  };
  return <><button ref={trigger} className="agent-entry" aria-expanded={open} onClick={() => setOpen(true)}>Agent · 学习对话</button>
    {open && createPortal(<aside ref={panel} className={`agent-panel${sourceOpen && !narrow ? ' beside-source' : ''}`} role={narrow ? 'dialog' : 'complementary'} inert={narrow && sourceOpen} aria-modal={narrow || undefined} aria-label="Agent 学习对话" onKeyDown={event => {
      // Let native textarea Undo edit only the composer. No board/editor command receives it.
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase()) && event.target === composer.current) event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); void close(); }
      if (narrow && event.key === 'Tab') {
        const items = [...panel.current!.querySelectorAll<HTMLElement>('button,select,textarea,input')].filter(e => !e.matches(':disabled'));
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <div className="agent-heading"><h2>学习对话</h2><button onClick={() => void close()}>收起对话</button></div>
      <div className="agent-conversations"><label>对话 <select aria-label="学习对话列表" value={view?.id ?? ''} disabled={busy} onChange={event => void guard(() => loadConversation(event.target.value))}>
        {!view && <option value="">选择对话</option>}{conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label><button disabled={busy} onClick={() => void guard(create)}>新对话</button></div>
      <div className="agent-messages" aria-label="对话消息">
        {!view?.messages.length && <p className="agent-empty">带上当前单元或原文选段提问。课程依据与补充解释会分别呈现，回答随课程保留。</p>}
        {view?.messages.map(message => { const task = view.tasks.find(t => t.id === message.taskId)!; return <section key={message.id} className={`agent-message ${message.role}`} data-message-id={message.id}>
          <p className="agent-message-label">{message.role === 'user' ? '你' : message.state === 'streaming' ? '实际接收中 · 部分内容已保存' : message.state === 'partial' ? '未完成回答 · 已收到部分已保存' : 'Agent · 消息已保存'}</p>
          {message.role === 'user' && <details className="agent-request"><summary>{task.snapshot.target.unitName} · 提交时目标</summary><p>{task.snapshot.target.unitId} · 正文版本 {task.snapshot.target.revision}</p>{task.snapshot.target.selectedText && <blockquote>{task.snapshot.target.selectedText}</blockquote>}</details>}
          <AgentProse text={message.text} />
          {message.role === 'assistant' && view.messages.filter(m => m.taskId === message.taskId && m.role === 'assistant').at(-1)?.id === message.id && task.snapshot.citations.length > 0 && <div className="agent-evidence" aria-label="固定课程出处"><strong>课程原文出处</strong>{task.snapshot.citations.map(({ citation, version }) => <section key={citation.id}>
            {citation.quote ? <blockquote>{citation.quote}</blockquote> : <p>{citation.textStatus === 'no-text-layer' ? '无可靠文字层，仅携带原页／选区，未做 OCR' : '原页／选区出处'}</p>}
            <button onClick={() => openCitation(citation)}>{version.title} · PDF 第 {citation.pdfPageIndex + 1} 页 · 印刷页 {citation.printedPage?.label ?? '未核对'}</button>
          </section>)}</div>}
        </section>; })}
        {view?.tasks.map(task => <div className="agent-task" role="status" aria-label="回答状态" key={task.id}>{taskLabel[task.status]}{task.error && <p>{task.error}</p>}</div>)}
      </div>
      <div className="agent-composer">
        <p className="agent-target">提问目标：{selection ? `${selection.unitId} · 已选正文` : targetName}</p>
        {selection && <div className="agent-attachment"><blockquote>{selection.selectedText}</blockquote><button onClick={() => setSelection(undefined)}>移除正文选文</button></div>}
        {attachments.map(c => <div className="agent-attachment" key={c.id}>{c.quote ? <blockquote>{c.quote}</blockquote> : <p>原页／选区 · 无精确选文</p>}<span>PDF 第 {c.pdfPageIndex + 1} 页 · 固定版本</span><button onClick={() => setAttachments(old => old.filter(item => item.id !== c.id))}>移除出处</button></div>)}
        <label htmlFor="agent-composer">只读提问</label><textarea id="agent-composer" ref={composer} aria-label="学习对话草稿" defaultValue={draft.current} disabled={busy} placeholder="哪里还没理解？" onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; if (dirty.current) void flush(); }} onInput={event => {
          draft.current = event.currentTarget.value; dirty.current = true; setDraftState('草稿待保存');
          clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 250);
          if (!deadline.current) deadline.current = setTimeout(() => void flush(), 1000);
        }} />
        <div className="agent-send"><label>模型 <select aria-label="问答模型" value={model} onChange={e => setModel(e.target.value)} disabled={!executor?.available || busy}>{executor?.models.map(m => <option key={m.model} value={m.model}>{m.displayName || m.model}</option>)}</select></label>
          <button className="primary" disabled={busy || !executor?.available || view?.tasks.some(t => t.status === 'running')} onClick={() => void guard(async () => { if (!current.current) await create(); await send(); })}>发送问题</button></div>
        <p role="status" aria-label="对话草稿保存">{draftState}</p>
        {!executor ? <p role="status">正在检测本机执行器…</p> : !executor.available ? <p role="status">生成暂不可用：{executor.error} 已保存对话仍可阅读。</p> : <details className="executor-details"><summary>本机 Codex CLI · 已连接</summary><p>{executor.version}</p><p>{executor.path}</p></details>}
        {error && <div role="alert" className="agent-error"><p>{error}</p>{failed.current && <button onClick={() => { failed.current = false; void flush(); }}>重试保存对话草稿</button>}{retrySubmit.current && <button onClick={() => void guard(send)}>核对并重试原问题</button>}</div>}
      </div>
    </aside>, document.body)}
  </>;
});
