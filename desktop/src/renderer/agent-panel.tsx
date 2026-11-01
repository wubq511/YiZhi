import { PanelPortal, useDockPanel } from './shell/panels';
import { useSaveReport } from './shell/save-status';
import { ArrowDown, Check, ChevronDown, Clock, Plus, Send, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { Checkbox } from './components/ui/checkbox';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Marker, MarkerContent, MarkerIcon } from './components/ui/marker';
import { Message, MessageContent, MessageFooter, MessageHeader } from './components/ui/message';
import { Bubble, BubbleContent } from './components/ui/bubble';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from './components/ui/message-scroller';
import type { AgentIntent } from '../agent-mutation-api';
import type { SearchHit } from '../search-api';
import { paintFrame, highlightSearch, waitForSearchElement } from './search-location';

import { AgentProse } from './agent-prose';
import { AgentTrace } from './agent-trace';
import { TraceDescription, TraceIcon, TraceLine, TraceTitle } from './components/ui/trace';
import { AgentCitations } from './agent-citation';
import { readMessageMode, subscribeMessageMode } from './message-mode';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import type { AgentTask, Conversation, ConversationView, ExecutorStatus, QuestionTarget, SubmitQuestion } from '../agent-api';
import type { SourceCitation } from '../sources-api';
import { GenerationTask } from './generation-task';
import { GenerationSource, type GenerationSourceChoice } from './generation-source';
import './agent-panel.css';
export interface AgentScene { open: boolean; conversationId: string | null; scrollTop: number }
export interface AgentPanelHandle { askSelection(target: QuestionTarget, intent: 'question' | 'modify'): void;  capture(): AgentScene; restore(scene: AgentScene, restoreVisibility?: boolean): Promise<void>; openSearch(hit: SearchHit): Promise<void>; flush(): Promise<boolean>; attachCitation(citation: SourceCitation): void }
const taskLabel: Record<AgentTask['status'], string> = { queued: '已排队 · 等待当前处理结束', waiting: '等待整合 · 任务尚未完成', stopping: '正在停止 · 已撤销后续提交资格', stopped: '已停止 · 已提交部分保留', running: '正在回答', completed: '回答已完成', failed: '回答失败', interrupted: '回答已中断', unknown: '执行结果未知', partial: '部分完成 · 已提交组保留', pending: '待处理 · 候选尚未正式保存' };
const liveStatus: AgentTask['status'][] = ['running', 'queued', 'waiting', 'stopping'];
const resumableStatus: AgentTask['status'][] = ['stopped', 'unknown', 'interrupted', 'partial', 'pending', 'failed'];
/** A board copy needs the answer, not the question; the mutation thread cannot see the question thread it came from. */
const boardRequest = (answer: string) => `请把下面这段讲解整理成画板上的补充材料，保留其中的定义与例子：\n\n${answer.slice(0, 6000)}`;
/** The executor's effort keys are English; the control speaks the product's language and passes an unknown key through unchanged. */
const effortLabel: Record<string, string> = { minimal: '最少', low: '较低', medium: '中等', high: '较高', xhigh: '很高', max: '最高' };

export const AgentPanel = forwardRef<AgentPanelHandle, {
  sessionId: string; narrow: boolean; target: QuestionTarget; targetName: string; anchorUnitId:string; sourceOpen: boolean;
  prepareMutation(): Promise<void>; onMutation(task: AgentTask, phase: 'start' | 'progress' | 'finish' | 'view'): Promise<void>;
  openCitation(citation: SourceCitation): void;
}>(function AgentPanel({ sessionId, narrow, target, targetName, anchorUnitId, sourceOpen, openCitation, prepareMutation, onMutation }, ref) {
  const api = window.yizhi.agent;
  const { open, setOpen } = useDockPanel('agent');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [view, setView] = useState<ConversationView>(), [executor, setExecutor] = useState<ExecutorStatus>();
  const [intent, setIntent] = useState<AgentIntent>('question');
  const [messageMode, setMessageMode] = useState(readMessageMode);
  const intentRef = useRef<AgentIntent>('question'), tracked = useRef(new Map<string,{conversationId:string;sequence:number;started:boolean}>());
  const callbacks = useRef({onMutation}); callbacks.current = {onMutation};
  const [model, setModel] = useState(''), [effort, setEffort] = useState(''), [generation, setGeneration] = useState(1);
  const [attachments, setAttachments] = useState<SourceCitation[]>([]), [selection, setSelection] = useState<QuestionTarget>();
  const [generationSource,setGenerationSource]=useState<GenerationSourceChoice|null>(null);
  const [fixedTargetName, setFixedTargetName] = useState('');
  const targetId = selection?.unitId ?? attachments.at(-1)?.target?.unitId ?? target.unitId;
  useEffect(() => { let live=true; setFixedTargetName(''); void window.yizhi.readUnit(sessionId,targetId).then(unit=>{if(live)setFixedTargetName(unit.name);}).catch(()=>{}); return()=>{live=false;}; }, [sessionId,targetId]);
  const [generatedTarget,setGeneratedTarget]=useState<{unitId:string;themeId:string;themeName:string;sourceId:string}|null>(null);
  const [updateGenerated,setUpdateGenerated]=useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [draftState, setDraftState] = useState('草稿已保存');
  const panel = useRef<HTMLElement>(null), composer = useRef<HTMLTextAreaElement>(null), messages = useRef<HTMLDivElement>(null);
  const chosenTarget = useRef<QuestionTarget | undefined>(undefined), chosenCitations = useRef<SourceCitation[]>([]);
  const current = useRef<string | null>(null), draft = useRef(''), seq = useRef(0), composing = useRef(false);
  const writes = useRef(Promise.resolve()), failed = useRef(false), dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retrySubmit = useRef<SubmitQuestion | null>(null), active = useRef(true);
  const list = async () => { const state = await api.list({ sessionId }); if (active.current) { setConversations(state.conversations); setGeneration(state.generation); } return state; };
  const refresh = async () => {
    const id = current.current;
    if (id) { const latest = await api.get({ sessionId, conversationId: id }); if (current.current === id && active.current) { setView(latest); for (const task of latest.tasks) if (task.guidedFrom && task.snapshot.intent !== 'question' && ['running','queued','waiting'].includes(task.status) && !tracked.current.has(task.id)) tracked.current.set(task.id,{conversationId:id,sequence:0,started:false}); } }
    await list();
    const status = await api.status(); if (active.current) setExecutor(status);
  };
  const flush = async () => {
    clearTimeout(timer.current); clearTimeout(deadline.current); deadline.current = undefined;
    if (composing.current) { setError('请先完成中文候选输入，再离开对话。'); return false; }
    if (dirty.current && current.current && !failed.current) {
      const id = current.current, text = draft.current, target = chosenTarget.current, citationIds = chosenCitations.current.map(c => c.id), savedIntent = intentRef.current, inputSeq = ++seq.current; dirty.current = false;
      writes.current = writes.current.then(async () => {
        try { await api.saveDraft({ sessionId, conversationId: id, seq: inputSeq, text, target, citationIds, intent: savedIntent }); if (id === current.current && !dirty.current) setDraftState('草稿已保存'); }
        catch (error) { failed.current = true; dirty.current = true; setDraftState('草稿未保存'); setError((error as Error).message); }
      });
    }
    await writes.current; return !failed.current && !composing.current;
  };
  const markDirty = () => {
    dirty.current = true; setDraftState('草稿待保存'); clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 250);
    if (!deadline.current) deadline.current = setTimeout(() => void flush(), 1000);
  };
  const loadConversation = async (id: string) => {
    if (!await flush()) return;
    const next = await api.get({ sessionId, conversationId: id }); await api.select({ sessionId, conversationId: id });
    const citations = next.draft.citationIds.length ? await window.yizhi.sources.citations({ sessionId }) : [];
    chosenTarget.current = next.draft.target; chosenCitations.current = citations.filter(c => next.draft.citationIds.includes(c.id));
    intentRef.current = next.draft.intent ?? 'question'; setIntent(intentRef.current);
    current.current = id; draft.current = next.draft.text; seq.current = next.draft.seq; dirty.current = false; retrySubmit.current = null;
    if (composer.current) composer.current.value = next.draft.text;
    setView(next); setAttachments(chosenCitations.current); setSelection(chosenTarget.current); setError(''); setDraftState('草稿已保存');
  };
  const create = async () => { if (!await flush()) return; const next = await api.create({ sessionId, operationId: crypto.randomUUID() }); await loadConversation(next.id); await list(); };
  useEffect(() => {
    active.current = true;
    void list().then(state => state.selectedId ? loadConversation(state.selectedId) : state.conversations[0] ? loadConversation(state.conversations[0].id) : create()).catch(error => setError(error.message));
    return () => { active.current = false; clearTimeout(timer.current); clearTimeout(deadline.current); };
  }, [sessionId]);
  useEffect(() => {
    let working = false, stopped = false;
    const interval = setInterval(async () => {
      if (working || !tracked.current.size) return; working = true;
      try { for (const [taskId, seen] of tracked.current) {
        const latest = await api.get({sessionId,conversationId:seen.conversationId}), task = latest.tasks.find(t=>t.id===taskId);
        if (!task || stopped) continue;
        if (task.status === 'running' && !seen.started) { seen.started = true; await callbacks.current.onMutation(task,'start'); }
        if ((task.progress?.sequence ?? 0) > seen.sequence) { seen.sequence = task.progress!.sequence; await callbacks.current.onMutation(task,'progress'); }
        if (!['running','stopping','queued','waiting'].includes(task.status)) { tracked.current.delete(task.id); await callbacks.current.onMutation(task,'finish'); }
      } } catch(error) { if(!stopped) setError((error as Error).message); } finally {working=false;}
    },200);
    return ()=>{stopped=true;clearInterval(interval);};
  },[sessionId]);
  useEffect(() => { if (!open) return; let cancelled = false;
    void api.status().then(status => { if (cancelled) return; setExecutor(status); setModel(old => old || status.models.find(m => m.isDefault)?.model || status.models[0]?.model || ''); });
    // The host nudges as each executor event lands; the slow poll only backstops a missed nudge.
    const stopNudge = window.yizhi.onAgentChanged(() => void refresh().catch(error => setError(error.message)));
    const interval = setInterval(() => void refresh().catch(error => setError(error.message)), 1200);
    requestAnimationFrame(() => composer.current?.focus());
    return () => { cancelled = true; stopNudge(); clearInterval(interval); };
  }, [open, sessionId]);
  useEffect(() => subscribeMessageMode(() => setMessageMode(readMessageMode())), []);
  // Effort follows the model: each entry advertises its own range, and the catalog default is what the executor would use anyway.
  useEffect(() => {
    const entry = executor?.models.find(m => m.model === model);
    setEffort(entry?.supportedReasoningEfforts?.some(option => option.effort === effort) ? effort : entry?.defaultReasoningEffort ?? '');
  }, [executor, model]);
  useEffect(()=>{setGeneratedTarget(null);setUpdateGenerated(false);setGenerationSource(null);},[sessionId,target.unitId]);
  useEffect(()=>{
    if(intent!=='generate')return;
    let active=true;
    void window.yizhi.readUnit(sessionId,target.unitId).then(unit=>{
      if(!active)return;
      const origin=unit.generationOrigin as {sourceId?:string}|undefined;
      setGeneratedTarget(origin?.sourceId?{unitId:unit.id,themeId:unit.theme.id,themeName:unit.theme.name,sourceId:origin.sourceId}:null);
    }).catch(()=>{if(active)setGeneratedTarget(null);});
    return()=>{active=false;};
  },[intent,sessionId,target.unitId]);
  useEffect(() => { if (open && narrow && !sourceOpen) composer.current?.focus(); }, [sourceOpen, narrow]);
  useEffect(() => {
    const capture = (event: Event) => {
      const range = window.getSelection(); if (!range?.rangeCount || range.isCollapsed || !range.toString().trim()) return;
      const node = range.anchorNode?.parentElement, article = node?.closest<HTMLElement>('article[data-agent-unit]');
      // A retained/programmatic reading selection is not a new question target when clicking elsewhere.
      if (!article || !(event.target instanceof Element) || event.target.closest('article[data-agent-unit]') !== article) return;
      const block = node?.closest<HTMLElement>('[data-agent-block], [data-block-id]');
      const next = { unitId: article.dataset.agentUnit!, ...((block?.dataset.agentBlock ?? block?.dataset.blockId) ? { blockId: block!.dataset.agentBlock ?? block!.dataset.blockId } : {}), selectedText: range.toString() };
      chosenTarget.current = next; setSelection(next); markDirty();
    };
    document.addEventListener('mouseup', capture); document.addEventListener('keyup', capture);
    return () => { document.removeEventListener('mouseup', capture); document.removeEventListener('keyup', capture); };
  }, []);
  useImperativeHandle(ref, () => ({ flush, askSelection(next, action) { chosenTarget.current = next; setSelection(next); intentRef.current = action; setIntent(action); markDirty(); setOpen(true); requestAnimationFrame(() => composer.current?.focus()); },
    capture: () => ({ open, conversationId: current.current, scrollTop: messages.current?.scrollTop ?? 0 }),
    async restore(scene, restoreVisibility = true) { if (!await flush()) throw new Error('对话草稿尚未保存'); if (scene.conversationId) await loadConversation(scene.conversationId); if (restoreVisibility) setOpen(scene.open); await paintFrame(); if (messages.current) messages.current.scrollTop = scene.scrollTop; },
    async openSearch(hit) {
      if (!await flush()) throw new Error('对话草稿尚未保存');
      const latest = await api.get({ sessionId, conversationId: hit.conversationId! });
      if (latest.messages.find(m => m.id === hit.messageId)?.text !== hit.text) throw new Error('消息版本已变化，请重新搜索');
      await loadConversation(hit.conversationId!); setOpen(true); await paintFrame();
      const element = await waitForSearchElement(() => messages.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(hit.messageId!)}"]`));
      if (!element) throw new Error('消息阅读位置暂不可用');
      highlightSearch(element, hit); element.scrollIntoView({ block: 'center' });
    }, attachCitation(citation) { chosenCitations.current = chosenCitations.current.some(c => c.id === citation.id) ? chosenCitations.current : [...chosenCitations.current, citation].slice(-8); setAttachments(chosenCitations.current); markDirty(); setOpen(true); } }));
  const close = async () => { if (!await flush()) return; setOpen(false); };
  const guard = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } };
  /** Anything the executor may still be doing must be followed by the board camera, whoever submitted it. */
  const watch = (task: AgentTask) => {
    if (task.snapshot.intent && task.snapshot.intent !== 'question' && ['running','queued','waiting'].includes(task.status) && !tracked.current.has(task.id)) {
      tracked.current.set(task.id,{conversationId:task.conversationId,sequence:0,started:task.status === 'running'});
      if (task.status === 'running') return onMutation(task,'start');
    }
    return Promise.resolve();
  };
  const send = async () => {
    if (!await flush() || !current.current || composing.current) return;
    if(!retrySubmit.current&&intentRef.current==='generate'&&!generationSource)throw new Error('请先选择已确认解析的 PDF 表格页。');
    if(!retrySubmit.current&&intentRef.current==='generate'&&updateGenerated&&!generatedTarget)throw new Error('当前单元不是可核对的已生成主题。');
    const topicId=crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
    const generationIdentity=updateGenerated&&generatedTarget?{unitId:generatedTarget.unitId,themeId:generatedTarget.themeId,themeName:generatedTarget.themeName}:
      {unitId:`KU-GEN-${topicId}`,themeId:`TH-GEN-${topicId}`,themeName:'四选一数据选择'};
    const generationSpec=generationSource?{...generationIdentity,...generationSource}:undefined;
    const request = retrySubmit.current ?? { sessionId, conversationId: current.current, operationId: crypto.randomUUID(), generation,
      intent: intentRef.current, mode: intentRef.current==='generate'?'queue':messageMode, text: draft.current,
      target: intentRef.current==='generate'?{unitId:updateGenerated?anchorUnitId:target.unitId}:selection ?? attachments.at(-1)?.target ?? target,
      citationIds: intentRef.current==='generate'?[]:attachments.map(c => c.id), ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}),
      ...(intentRef.current==='generate'?{generationSpec}:{}), };
    retrySubmit.current = request;
    if (request.intent && request.intent !== 'question') await prepareMutation();
    const submitted = await api.submit(request); retrySubmit.current = null;
    await watch(submitted);
    draft.current = ''; if (composer.current) composer.current.value = ''; dirty.current = false;
    chosenTarget.current = undefined; chosenCitations.current = []; setAttachments([]); setSelection(undefined); await refresh();
  };
  useSaveReport('agent-draft', { label: '对话草稿', status: draftState === '草稿未保存' ? 'error' : draftState === '草稿已保存' ? 'saved' : 'pending', detail: error, retry: () => { failed.current = false; return flush(); } });
  useSaveReport('agent-request', {label:'对话请求',status:busy?'saving':retrySubmit.current&&error?'error':'saved',detail:error,retry:()=>guard(send)});
  const working = view?.tasks.some(t => ['running','waiting','queued'].includes(t.status));
  // A submitted turn exists as a question before the model has anything to say; that row still owns its status and actions.
  const pending = view ? view.tasks.filter(task => !view.messages.some(m => m.taskId === task.id && m.role === 'assistant')) : [];
  const effortOptions = executor?.models.find(m => m.model === model)?.supportedReasoningEfforts ?? [];
  const showEffort = !!executor?.supportsReasoning && effortOptions.length > 1;
  /** Only what is broken or still owed a decision may break the fold; everything already settled belongs to the process layer. */
  const receipts = (task: AgentTask) => {
    const rows: ReactNode[] = [];
    if (task.guidedFrom) rows.push(<TraceLine key="guided"><TraceIcon><Send/></TraceIcon><TraceTitle>由引导安排的独立事项</TraceTitle><TraceDescription>{task.snapshot.target.unitName}</TraceDescription></TraceLine>);
    for (const delivery of task.deliveries?.filter(item => item.state === 'accepted') ?? []) rows.push(<TraceLine key={delivery.id}><TraceIcon><Check/></TraceIcon><TraceTitle>{delivery.kind === 'student-change' ? '学生同时修改' : '工作中引导'}</TraceTitle><TraceDescription>{delivery.reviewedBasisId ? '已重新读取正文' : '已送达'}</TraceDescription></TraceLine>);
    if (task.waitingReason) rows.push(<TraceLine key="wait"><TraceIcon><Clock/></TraceIcon><TraceTitle>{task.waitingReason}</TraceTitle></TraceLine>);
    if (task.recovery?.state === 'resolved') rows.push(<TraceLine key="recovery"><TraceIcon><Check/></TraceIcon><TraceTitle>{task.recovery.detail}</TraceTitle></TraceLine>);
    return rows.length ? <>{rows}</> : null;
  };
  const note = (task: AgentTask) => <>
    {task.groups?.filter(group => group.status !== 'committed').map(group => <Marker className="agent-note" key={group.operationId}><MarkerContent>草稿候选等待处理 · {group.reason ?? '原因未记录'}</MarkerContent></Marker>)}
    {task.deliveries?.filter(delivery => delivery.state !== 'accepted').map(delivery => <Marker className="agent-note" role="status" aria-label="消息送达状态" key={delivery.id}><MarkerContent>
      {delivery.kind === 'student-change' ? '学生同时修改' : '工作中引导'} · {delivery.state === 'failed' ? '引导未送达' : delivery.state === 'unknown' ? '送达结果未知 · 原记录已保留' : '等待送达'}
      {delivery.error ? `：${delivery.error}` : ''}{delivery.handledTaskId ? ' · 已安排独立事项，等待当前工作结束' : ''}
      {delivery.state === 'failed' && ['running','waiting'].includes(task.status) && <Button variant="link" size="xs" disabled={busy} onClick={()=>void guard(async()=>{await api.retryDelivery({sessionId,taskId:task.id,deliveryId:delivery.id});await refresh();})}>重试原引导</Button>}
    </MarkerContent></Marker>)}
    {task.recovery && task.recovery.state !== 'resolved' && <Marker className="agent-note"><MarkerContent>{task.recovery.detail}</MarkerContent></Marker>}
    {task.error && <Marker className="agent-note agent-note-error"><MarkerIcon><X/></MarkerIcon><MarkerContent>{task.error}</MarkerContent></Marker>}
    {task.status === 'completed' && view!.messages.some(m => m.taskId === task.id && m.state === 'partial') && <Marker className="agent-note"><MarkerContent>有部分内容未确认收到</MarkerContent></Marker>}
  </>;
  /** The thesis row: what actually landed, and the one way to go look at it. */
  const changedCount = (task: AgentTask) => (task.groups ?? []).reduce((total, group) => total + (group.status === 'committed' ? group.changedObjectIds.length : 0), 0);
  const statusLine = (task: AgentTask) => {
    // A finished answer is its own signal; only work that is unfinished or went wrong keeps a line in the stream.
    const intent = task.snapshot.intent, mutation = !!intent && intent !== 'question', generating = intent === 'generate';
    if (task.status === 'running') return generating ? '正在生成并校验' : mutation ? '正在修改' : '正在回答';
    if (task.status === 'stopping') return '正在停止';
    if (task.status === 'completed') return null;
    return taskLabel[task.status];
  };
  const actions = (task: AgentTask, answer?: string) => <MessageFooter className="agent-actions">
    {changedCount(task) > 0 && <MarkerContent className="agent-focal">已改 {changedCount(task)} 处</MarkerContent>}
    {changedCount(task) > 0 && <Button variant="link" size="xs" onClick={() => void guard(()=>onMutation(task,'view'))}>查看实际修改</Button>}
    {(['running','queued','waiting'].includes(task.status)||task.status==='unknown'&&task.recovery?.state==='active') && <Button variant="outline" size="xs" disabled={busy} onClick={()=>void guard(async()=>{await api.stop({sessionId,taskId:task.id});await refresh();})}>停止任务</Button>}
    {['stopping',...resumableStatus].includes(task.status) && <Button variant="outline" size="xs" disabled={busy} onClick={()=>void guard(async()=>{await api.reconcile({sessionId,taskId:task.id});await refresh();})}>核对原任务结果</Button>}
    {!task.continuedByTaskId && !view!.tasks.some(t=>liveStatus.includes(t.status)) && resumableStatus.includes(task.status) && <Button variant="outline" size="xs" disabled={busy||!executor?.available||task.recovery?.state==='active'} onClick={()=>void guard(async()=>{
      if(!await flush())return;
      if(task.snapshot.intent && task.snapshot.intent!=='question')await prepareMutation();
      const next=await api.continue({sessionId,taskId:task.id,operationId:crypto.randomUUID()});
      await watch(next); await refresh();
    })}>继续剩余工作</Button>}
    {answer && task.status === 'completed' && (!task.snapshot.intent || task.snapshot.intent === 'question') && <Button variant="link" size="xs" disabled={busy||!executor?.available} title="把这条回答整理为画板上的补充材料" onClick={()=>void guard(async()=>{
      if(!current.current||!await flush())return;
      await prepareMutation();
      const next=await api.submit({sessionId,conversationId:current.current,operationId:crypto.randomUUID(),generation,
        intent:'add-to-board',mode:'queue',text:boardRequest(answer),target:task.snapshot.target,...(model?{model}:{})});
      await watch(next); await refresh();
    })}><Plus data-icon="inline-start"/>加入画板</Button>}
  </MessageFooter>;
  return <PanelPortal id="agent"><aside ref={panel} className="agent-panel" role={narrow ? 'dialog' : 'complementary'} aria-modal={narrow || undefined} aria-label="Agent 学习对话" onKeyDown={event => {
      // Let native textarea Undo edit only the composer. No board/editor command receives it.
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase()) && event.target === composer.current) event.stopPropagation();
      // Portalled menus also bubble through the React tree, so only a key pressed inside the panel itself may dismiss it.
      if (event.key === 'Escape' && panel.current?.contains(event.target as Node)) { event.preventDefault(); void close(); }
      if (narrow && event.key === 'Tab') {
        const items = [...panel.current!.querySelectorAll<HTMLElement>('button,select,textarea,input')].filter(e => !e.matches(':disabled'));
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <div className="agent-heading">
        <h2>学习对话</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="xs" className="agent-switcher" disabled={busy} aria-label="学习对话列表"><span>{view?.title ?? '选择对话'}</span><ChevronDown data-icon="inline-end"/></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="agent-switcher-menu">
            <DropdownMenuLabel>我的对话</DropdownMenuLabel>
            {conversations.map(c => <DropdownMenuItem key={c.id} data-active={c.id === view?.id || undefined} disabled={busy} onClick={() => void guard(() => loadConversation(c.id))}>{c.title}</DropdownMenuItem>)}
            <DropdownMenuSeparator/>
            <DropdownMenuItem disabled={busy} onClick={() => void guard(create)}><Plus/>新对话</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" className="panel-close" aria-label="收起对话" onClick={() => void close()}><X size={18}/></Button>
      </div>
      <MessageScrollerProvider autoScroll={!!working} defaultScrollPosition="end" scrollPreviousItemPeek={0} scrollMargin={0}>
        <MessageScroller className="agent-messages">
          <MessageScrollerViewport ref={messages} aria-label="对话消息">
            <MessageScrollerContent>
              {!view?.messages.length && <p className="agent-empty">{intent==='generate'?'从已解析原件建立完整小主题；候选与正式回执会在这里保留。':'带上当前单元或原文选段提问。课程依据与补充解释会分别呈现，回答随课程保留。'}</p>}
              {view?.messages.map((message, index) => { const task = view.tasks.find(t => t.id === message.taskId), snapshot = task?.deliveries?.find(d => d.id === message.deliveryId)?.snapshot ?? task?.snapshot;
                const status = task ? statusLine(task) : message.state === 'streaming' ? '实际接收中' : message.state === 'partial' ? '回答未完整收到' : null;
                // A turn can deliver more than one answer row; the process belongs to the one the student is reading now.
                const current = !!task && view.messages.filter(m => m.taskId === task.id && m.role === 'assistant').at(-1)?.id === message.id;
                return <MessageScrollerItem key={message.id} messageId={message.id} data-message-id={message.id} scrollAnchor>

                  {message.role === 'user'
                    ? <Message align="end"><MessageContent>
                      <Bubble variant="secondary" align="end"><BubbleContent className="whitespace-pre-wrap">{message.text}</BubbleContent></Bubble>
                      {snapshot?.target.selectedText && <p className="agent-quote">「{snapshot.target.selectedText}」</p>}
                    </MessageContent></Message>
                    : <Message align="start"><MessageContent>
                      {status && (!task || current) && <MessageHeader role="status" aria-label="回答状态">{status}</MessageHeader>}
                      {current && <AgentTrace task={task!} reasonings={view.reasonings.filter(r => r.taskId === task!.id)} facts={view.toolFacts.filter(f => f.taskId === task!.id)} live={liveStatus.includes(task!.status)} receipts={receipts(task!)}/>}
                      <AgentProse text={message.text}/>
                      {task?.snapshot.intent === 'generate' && current && <GenerationTask sessionId={sessionId} task={task}/>}
                      {current && task?.snapshot.citations.length ? <AgentCitations references={task!.snapshot.citations} open={openCitation}/> : null}
                      {current && note(task!)}
                      {current && actions(task!, message.text)}
                    </MessageContent></Message>}
                </MessageScrollerItem>; })}
              {pending.map((task, index) => <MessageScrollerItem key={task.id} scrollAnchor>

                <Message align="start"><MessageContent>
                  {statusLine(task) && <MessageHeader role="status" aria-label="回答状态">{statusLine(task)}</MessageHeader>}
                  <AgentTrace task={task} reasonings={view!.reasonings.filter(r => r.taskId === task.id)} facts={view!.toolFacts.filter(f => f.taskId === task.id)} live={liveStatus.includes(task.status)} receipts={receipts(task)}/>
                  {task.snapshot.intent==='generate'&&<GenerationTask sessionId={sessionId} task={task}/>}
                  {note(task)}
                  {actions(task)}
                </MessageContent></Message>
              </MessageScrollerItem>)}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" aria-label="回到最新回答"><ArrowDown size={16}/><span className="sr-only">回到最新回答</span></MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="agent-composer">
        <p className="agent-target">{intent==='generate'?updateGenerated?'更新目标：':'画板锚点：': '提问目标：'}{intent==='generate'?targetName:selection?.selectedText ? `${fixedTargetName || '当前单元'} · 已选正文` : attachments.at(-1)?.target ? `${fixedTargetName || '来源关联单元'}` : targetName}</p>
        {selection?.selectedText && <div className="agent-attachment"><blockquote>{selection.selectedText}</blockquote><Button variant="ghost" size="icon-sm" className="attachment-remove" aria-label="移除正文选文" title="移除正文选文" onClick={() => { chosenTarget.current = undefined; setSelection(undefined); markDirty(); }}><X size={16}/></Button></div>}
        {attachments.map(c => <div className="agent-attachment" key={c.id}>{c.quote ? <blockquote>{c.quote}</blockquote> : <p>原页／选区 · 无精确选文</p>}<span>PDF 第 {c.pdfPageIndex + 1} 页 · 固定版本</span><Button variant="ghost" size="icon-sm" className="attachment-remove" aria-label="移除出处" title="移除出处" onClick={() => { chosenCitations.current = chosenCitations.current.filter(item => item.id !== c.id); setAttachments(chosenCitations.current); markDirty(); }}><X size={16}/></Button></div>)}
        <ToggleGroup aria-label="Agent 请求方式" type="single" size="sm" variant="outline" spacing={0} value={intent}
          onValueChange={value => { if (!value || value === intent) return; const next = value as AgentIntent; intentRef.current = next; setIntent(next); markDirty(); }}>
          <ToggleGroupItem value="question">提问</ToggleGroupItem>
          <ToggleGroupItem value="modify">修改</ToggleGroupItem>
          <ToggleGroupItem value="generate">生成主题</ToggleGroupItem>
        </ToggleGroup>
        {intent==='generate'&&<div className="agent-generation-flow">
          {generatedTarget&&<label className="agent-generation-update"><Checkbox checked={updateGenerated} disabled={busy} onCheckedChange={checked=>{setUpdateGenerated(checked===true);setGenerationSource(null);}}/>更新当前已生成小主题，保留单元与批注身份</label>}
          <GenerationSource sessionId={sessionId} value={generationSource} sourceIdFilter={updateGenerated?generatedTarget?.sourceId:undefined} onChange={setGenerationSource}/>
        </div>}
        <label className="sr-only" htmlFor="agent-composer">{intent === 'question' ? '只读提问' : intent==='generate'?'小主题范围与学习目标':'明确修改请求'}</label><Textarea id="agent-composer" ref={composer} aria-label="学习对话草稿" defaultValue={draft.current} disabled={busy} placeholder={intent==='generate'?'说明你要从这页建立的小主题、例题与练习范围。':'哪里还没理解？'} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; if (dirty.current) void flush(); }} onInput={event => {
          draft.current = event.currentTarget.value; markDirty();
        }} />
        <div className="agent-send">
          <NativeSelect className="agent-model" aria-label="问答模型" title={model || undefined} value={model} onChange={e => setModel(e.target.value)} disabled={!executor?.available || busy}>{executor?.models.map(m => <NativeSelectOption key={m.model} value={m.model}>{m.displayName || m.model}</NativeSelectOption>)}</NativeSelect>
          {showEffort && <label className="agent-effort"><span>思考强度</span><NativeSelect aria-label="思考强度" value={effort} disabled={!executor?.available || busy} onChange={e => setEffort(e.target.value)}>{effortOptions.map(o => <NativeSelectOption key={o.effort} value={o.effort} title={o.description}>{effortLabel[o.effort] ?? o.effort}</NativeSelectOption>)}</NativeSelect></label>}
          <Button variant="default" size="default" disabled={busy || !executor?.available} onClick={() => void guard(async () => { if (!current.current) await create(); await send(); })}>{intent==='generate'?updateGenerated?'更新小主题':'生成小主题':working ? messageMode === 'queue' ? '排队发送' : '发送引导' : intent === 'question' ? '发送问题' : '发送修改请求'}</Button>
        </div>
        {draftState === '草稿未保存' && <p role="status" aria-label="对话草稿保存">草稿未保存</p>}
        {!executor ? <p role="status" aria-label="Agent 连接状态">正在检测本机 Agent…</p> : !executor.available ? <p role="status" aria-label="Agent 连接状态">Agent 暂不可用：{executor.error} 已保存的对话仍可阅读。</p> : null}
        {error && <div role="alert" className="agent-error"><p>{error}</p>{failed.current && <Button variant="outline" size="sm" onClick={() => { failed.current = false; void flush(); }}>重试保存对话草稿</Button>}{retrySubmit.current && <Button variant="outline" size="sm" onClick={() => void guard(send)}>核对并重试原问题</Button>}</div>}
      </div>
    </aside></PanelPortal>
  ;
});
