import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, AgentTask, AgentMessage, ConversationView, QuestionSnapshot, SubmitQuestion } from '../agent-api';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { Sources } from './sources';
import { transaction, appendEvent } from './save-store';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (value: unknown) => JSON.parse(String(value));
const valid = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200;
const text = (s: unknown, max = 20_000): s is string => typeof s === 'string' && s.length <= max;

export class AgentStore {
  constructor(private db: DatabaseSync, private sources: Sources, private unit: (id: string) => CourseUnit | undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL,
        draft TEXT NOT NULL DEFAULT '', draft_session TEXT NOT NULL DEFAULT '', draft_seq INTEGER NOT NULL DEFAULT 0, thread_id TEXT, draft_context TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS agent_context(id INTEGER PRIMARY KEY CHECK(id=1), conversation_id TEXT REFERENCES agent_conversations(id));
      CREATE TABLE IF NOT EXISTS agent_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),
        attempt_id TEXT NOT NULL REFERENCES cg_attempts(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_deliveries(attempt_id TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(attempt_id,event_id));
      CREATE TABLE IF NOT EXISTS agent_tool_recovery(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES cg_attempts(id),
        purpose TEXT NOT NULL, reference_id TEXT NOT NULL, name TEXT NOT NULL, input TEXT, output TEXT, digest TEXT NOT NULL, refs TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_stop_requests(task_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_executor_receipts(attempt_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT,applied INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL DEFAULT 'active-recovery',reference_id TEXT NOT NULL,PRIMARY KEY(attempt_id,event_id));`);
    if (!db.prepare('PRAGMA table_info(agent_conversations)').all().some(row => row.name === 'draft_context')) db.exec("ALTER TABLE agent_conversations ADD COLUMN draft_context TEXT NOT NULL DEFAULT '{}'");
    this.repair();
    // Process death is not an instruction to regenerate. Preserve actual received text, revoke the old attempt.
    transaction(db, () => {
      for (const row of db.prepare('SELECT payload FROM agent_tasks').all()) {
        const task = parse(row.payload) as AgentTask;
        if (['running','stopping'].includes(task.status)) this.finish(task, 'unknown', '上次执行连接已结束，结果未知；已收到的内容已保留。');
      }
    });
  }
  fence(action: string, operationId: unknown) {
    if (!valid(operationId)) return;
    if (action.startsWith('agent:')) {
      if (this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(operationId) ||
          this.db.prepare('SELECT 1 FROM cg_candidates WHERE id=?').get(operationId) ||
          this.db.prepare('SELECT 1 FROM source_operations WHERE id=?').get(operationId) ||
          this.db.prepare('SELECT 1 FROM source_imports WHERE id=?').get(operationId) ||
          this.db.prepare('SELECT 1 FROM parse_operations WHERE id=?').get(operationId)) throw new Error('操作身份已用于其他课程操作');
    } else if (this.db.prepare('SELECT 1 FROM agent_operations WHERE id=?').get(operationId)) throw new Error('操作身份已用于学习对话');
  }
  private generation() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value); }
  private conversation(id: string) {
    if (!valid(id)) throw new Error('对话身份无效');
    const row = this.db.prepare('SELECT * FROM agent_conversations WHERE id=?').get(id);
    if (!row) throw new Error('学习对话不存在');
    return row;
  }
  private operation<T>(request: any, action: string, run: () => T): T {
    if (!valid(request.operationId)) throw new Error('操作身份无效');
    this.fence(action, request.operationId);
    const { sessionId: _, ...identity } = request, digest = hash([action, identity]);
    return transaction(this.db, () => {
      const old = this.db.prepare('SELECT * FROM agent_operations WHERE id=?').get(request.operationId);
      if (old) {
        if (old.digest !== digest) throw new Error('同一操作不能换用不同内容');
        const receipt = parse(old.receipt);
        return ['agent:submit','agent:continue'].includes(action) ? this.task(receipt.taskId) as T : receipt;
      }
      const result = run();
      this.db.prepare('INSERT INTO agent_operations VALUES(?,?,?)').run(request.operationId, digest, JSON.stringify(['agent:submit','agent:continue'].includes(action) ? { taskId: (result as AgentTask).id } : result));
      return result;
    });
  }
  private changed(conversationId: string, taskId?: string) {
    return appendEvent(this.db, { type: 'agent.changed', conversationId, ...(taskId ? { taskId } : {}) });
  }
  list() {
    return { conversations: this.db.prepare('SELECT id,title,updated_at AS updatedAt FROM agent_conversations ORDER BY updated_at DESC,rowid DESC').all(),
      selectedId: this.db.prepare('SELECT conversation_id FROM agent_context WHERE id=1').get()?.conversation_id ?? null, generation: this.generation() };
  }
  create(request: any) {
    return this.operation(request, 'agent:create', () => {
      const conversation = { id: randomUUID(), title: '新学习对话', updatedAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO agent_conversations(id,title,updated_at) VALUES(?,?,?)').run(conversation.id, conversation.title, conversation.updatedAt);
      this.select(conversation.id); this.changed(conversation.id); return conversation;
    });
  }
  select(id: string) { this.conversation(id); this.db.prepare('INSERT OR REPLACE INTO agent_context VALUES(1,?)').run(id); }
  get(sessionId: string, id: string): ConversationView {
    this.repair();
    const row = this.conversation(id);
    return { id, title: String(row.title), updatedAt: String(row.updated_at),
      toolFacts: this.db.prepare('SELECT r.* FROM agent_tool_recovery r JOIN agent_tasks t ON t.id=r.reference_id WHERE t.conversation_id=? ORDER BY r.rowid').all(id).map(r => ({ taskId: String(r.reference_id), name: String(r.name), purpose: String(r.purpose), referenceId: String(r.reference_id), digest: String(r.digest), references: parse(r.refs), hasRecoveryPayload: r.input !== null || r.output !== null })),
      draft: { text: String(row.draft), seq: row.draft_session === sessionId ? Number(row.draft_seq) : 0, citationIds: [], ...parse(row.draft_context) },
      tasks: this.db.prepare('SELECT payload FROM agent_tasks WHERE conversation_id=? ORDER BY rowid').all(id).map(r => parse(r.payload)),
      messages: this.db.prepare('SELECT m.payload FROM agent_messages m JOIN agent_tasks t ON t.id=m.task_id WHERE t.conversation_id=? ORDER BY m.rowid').all(id).map(r => parse(r.payload)) };
  }
  saveDraft(request: any) {
    if (!text(request.text) || !Number.isSafeInteger(request.seq) || request.seq < 1) throw new Error('输入草稿无效');
    const context = { ...(request.intent ? {intent: request.intent} : {}), ...(request.target ? { target: request.target } : {}), citationIds: request.citationIds ?? [] };
    if (request.intent !== undefined && !['question','modify','add-to-board'].includes(request.intent)) throw new Error('请求意图无效');
    if (!Array.isArray(context.citationIds) || context.citationIds.length > 8 || context.citationIds.some((id: unknown) => !valid(id) || !this.sources.citations().some(c => c.id === id)) ||
      context.target && (!valid(context.target.unitId) || context.target.blockId !== undefined && !valid(context.target.blockId) || context.target.selectedText !== undefined && !text(context.target.selectedText, 10_000))) throw new Error('提问草稿目标或出处无效');
    return transaction(this.db, () => {
      const row = this.conversation(request.conversationId);
      if (row.draft_session === request.sessionId && request.seq <= Number(row.draft_seq)) {
        if (request.seq === row.draft_seq && request.text === row.draft && JSON.stringify(context) === row.draft_context) return { seq: request.seq };
        throw new Error('对话草稿序号已过期或内容不一致');
      }
      this.db.prepare('UPDATE agent_conversations SET draft=?,draft_session=?,draft_seq=?,draft_context=? WHERE id=?').run(request.text, request.sessionId, request.seq, JSON.stringify(context), request.conversationId);
      this.changed(request.conversationId); return { seq: request.seq };
    });
  }
  private selectionText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(v => this.selectionText(v)).join('\n');
    if (value && typeof value === 'object') return Object.values(value).map(v => this.selectionText(v)).join('\n');
    return '';
  }
  submit(request: SubmitQuestion, previous?: AgentTask, operationRequest:unknown=request): AgentTask {
    return this.operation(operationRequest, previous ? 'agent:continue' : 'agent:submit', () => {
      this.conversation(request.conversationId);
      if (request.generation !== this.generation()) throw new Error('课程代际已变化');
      if (request.intent !== undefined && !['question','modify','add-to-board'].includes(request.intent)) throw new Error('请求意图无效');
      if (!text(request.text) || !request.text.trim() || !valid(request.target?.unitId) ||
        (request.model !== undefined && !valid(request.model)) || !Array.isArray(request.citationIds ?? []) || (request.citationIds?.length ?? 0) > 8) throw new Error('问题或目标无效');
      const existing = this.get(request.sessionId, request.conversationId).tasks.find(t => ['running','stopping'].includes(t.status));
      if (existing) throw new Error('当前对话仍在回答，请等待完成或使用另一段对话');
      const unit = this.unit(request.target.unitId);
      if (!unit) throw new Error('请求的课程正文不可读');
      const find = (blocks: ReadingBlock[]): ReadingBlock | undefined => {
        for (const block of blocks) { if (block.id === request.target.blockId) return block; const found = find(block.children ?? []); if (found) return found; }
      };
      const block = request.target.blockId ? find(unit.reading.blocks) : undefined;
      if (request.target.blockId && !block) throw new Error('提问对象不存在');
      if (request.target.selectedText !== undefined && (!text(request.target.selectedText, 10_000) || !request.target.selectedText.trim() ||
        !this.selectionText(block?.payload ?? unit.reading).includes(request.target.selectedText))) throw new Error('选文与提交时正文不一致，请重新选择');
      const revision = this.db.prepare('SELECT revision FROM units WHERE id=?').get(unit.id)?.revision ?? hash(unit);
      const citations = (request.citationIds ?? []).map(id => {
        const citation = this.sources.citations().find(c => c.id === id);
        if (!citation) throw new Error('来源引用不存在');
        return { citation, version: this.sources.version(citation.versionId) };
      });
      const snapshot: QuestionSnapshot = { intent: request.intent ?? 'question', text: request.text, target: { ...request.target, unitName: unit.name, revision: String(revision),
        ...(block ? { blockVersion: Number(this.db.prepare('SELECT version FROM cg_objects WHERE id=?').get(block.id)?.version ?? 1) } : {}) }, citations };
      const id = randomUUID(), attemptId = randomUUID(), createdAt = new Date().toISOString();
      // Same shared qualification table and generation as all producer commits, created atomically with the task.
      this.db.prepare('INSERT INTO cg_attempts VALUES(?,?,?,?)').run(attemptId, id, request.generation, 'running');
      const task: AgentTask = { id, operationId: request.operationId, conversationId: request.conversationId, attemptId, generation: request.generation,
        ...(previous ? {continuesTaskId:previous.id} : {}), snapshot, status: 'running', threadId: null, turnId: null, model: request.model ?? null, error: null, createdAt, cursor: 0 };
      task.cursor = this.changed(request.conversationId, id);
      this.db.prepare('INSERT INTO agent_tasks VALUES(?,?,?,?)').run(id, request.conversationId, attemptId, JSON.stringify(task));
      this.message({ id: `${id}:user`, taskId: id, role: 'user', text: request.text, state: 'complete', itemId: null });
      if (previous) { previous.continuedByTaskId=id; this.db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(previous),previous.id); }
      if (!previous) this.db.prepare('UPDATE agent_conversations SET title=?,updated_at=?,draft=\'\',draft_context=\'{}\' WHERE id=?').run(request.text.trim().slice(0, 40), createdAt, request.conversationId);
      this.select(request.conversationId); return task;
    });
  }
  stop(request: { taskId: string }): AgentTask {
    const task=this.task(request.taskId);
    if (!['running','queued','waiting','stopping'].includes(task.status) && !(task.status==='unknown'&&task.recovery?.state==='active')) return task;
    // Qualification is durable even if the later business-task projection cannot be written.
    transaction(this.db,()=>{
      this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=?").run(task.attemptId);
      this.db.prepare("UPDATE cg_bases SET read_values='[]',domain_basis=NULL WHERE attempt_id=?").run(task.attemptId);
      this.db.prepare('INSERT OR IGNORE INTO agent_stop_requests VALUES(?,?)').run(task.id,task.attemptId);
    });
    this.repair();return this.task(task.id);
  }
  continue(request: {sessionId:string;taskId:string;operationId:string}): AgentTask {
    this.repair();
    const previous=this.task(request.taskId);
    const old=this.db.prepare('SELECT receipt FROM agent_operations WHERE id=?').get(request.operationId);
    if(old)return this.operation(request,'agent:continue',()=>{throw new Error('继续回执不存在');});
    if (previous.continuedByTaskId && !old) throw new Error('此任务已明确继续，请查看新的尝试');
    if (['running','queued','waiting','stopping','completed'].includes(previous.status) || previous.recovery?.state==='active') throw new Error('请先核对原任务停止或中断的真实结果');
    const unit=this.unit(previous.snapshot.target.unitId);
    const contains=(blocks:ReadingBlock[]):boolean=>blocks.some(b=>b.id===previous.snapshot.target.blockId||contains(b.children??[]));
    const target={unitId:previous.snapshot.target.unitId,...(unit && previous.snapshot.target.blockId && contains(unit.reading.blocks)?{blockId:previous.snapshot.target.blockId}:{})};
    return this.submit({sessionId:request.sessionId,operationId:request.operationId,conversationId:previous.conversationId,generation:this.generation(),
      text:previous.snapshot.text,target,intent:previous.snapshot.intent,citationIds:previous.snapshot.citations.map(c=>c.citation.id),...(previous.model?{model:previous.model}:{})},previous,request);
  }
  facts(request: {taskId:string;attemptId:string;generation:number}) {
    const task=this.task(request.taskId);
    if(task.attemptId!==request.attemptId||task.generation!==request.generation)throw new Error('任务尝试身份不一致');
    return task;
  }
  private task(id: string): AgentTask {
    const row = this.db.prepare('SELECT payload FROM agent_tasks WHERE id=?').get(id);
    if (!row) throw new Error('任务不存在'); return parse(row.payload);
  }
  active(request: { taskId: string; attemptId: string; generation: number }) {
    const task = this.task(request.taskId);
    const attempt = this.db.prepare('SELECT status,generation FROM cg_attempts WHERE id=?').get(request.attemptId);
    if (task.status !== 'running' || task.attemptId !== request.attemptId || task.generation !== request.generation ||
      request.generation !== this.generation() || attempt?.status !== 'running' || attempt.generation !== request.generation) throw new Error('任务尝试已停止或失效');
    return task;
  }
  readTarget(request: { taskId: string; attemptId: string; generation: number }) {
    const task = this.active(request), current = this.unit(task.snapshot.target.unitId);
    if (!current) throw new Error('提问对象的课程正文不可读');
    const revision = this.db.prepare('SELECT revision FROM units WHERE id=?').get(current.id)?.revision ?? hash(current);
    return { submittedTarget: task.snapshot.target, currentRevision: String(revision), currentFormalContent: current,
      note: '当前正式内容与版本；提交时的对象、选文和版本在 submittedTarget 中固定。普通问答不修改画板。' };
  }
  private message(message: AgentMessage) { this.db.prepare('INSERT INTO agent_messages VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(message.id, message.taskId, JSON.stringify(message)); }
  private finish(task: AgentTask, status: AgentTask['status'], error?: string) {
    const executorCompleted = status === 'completed';
    if (['completed','failed','interrupted','unknown'].includes(status)) task.executorStatus = status as AgentTask['executorStatus'];
    if (task.snapshot.intent && task.snapshot.intent !== 'question') {
      const committed = task.groups?.some(g => g.status === 'committed' && g.changedObjectIds.length);
      const unfinished = status !== 'completed' || task.mutationFailure || task.groups?.some(g => g.status === 'retained');
      status = committed ? unfinished ? 'partial' : 'completed' : 'pending';
    }
    task.status = task.stopRequested && status !== 'unknown' ? 'stopped' : status; task.error = error ?? task.mutationFailure ?? null;
    for (const row of this.db.prepare('SELECT payload FROM agent_messages WHERE task_id=?').all(task.id)) {
      const message = parse(row.payload) as AgentMessage;
      if (message.role === 'assistant') { message.state = executorCompleted && message.state === 'complete' ? 'complete' : 'partial'; this.message(message); }
    }
    this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE id=?").run(task.attemptId);
    this.db.prepare("UPDATE cg_bases SET read_values='[]',domain_basis=NULL WHERE attempt_id=?").run(task.attemptId);
    // Completed/unknown attempts never need a permanent duplicate of whole tool reads.
    this.db.prepare("UPDATE agent_tool_recovery SET input=NULL,output=NULL,purpose='result-fact' WHERE attempt_id=?").run(task.attemptId);
    task.cursor = this.changed(task.conversationId, task.id);
    this.db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
  }
  /** First persist the actual executor delivery, then publish its local projection.
   * A failed association cannot erase a fact already accepted from the external turn. */
  record(event: AgentEvent) {
    if(!valid(event.eventId)||!['bind','delta','message','tool','finish'].includes(event.kind)||
      event.threadId!==undefined&&!valid(event.threadId)||event.turnId!==undefined&&!valid(event.turnId))throw new Error('执行器事件身份无效');
    if(['delta','message'].includes(event.kind)&&(!valid(event.itemId)||!text(event.text,200_000)))throw new Error('执行器消息无效');
    if(event.kind==='finish'&&(!event.status||!['completed','failed','interrupted','unknown'].includes(event.status)))throw new Error('执行器终态无效');
    if(event.kind==='tool'&&(!event.tool||!valid(event.tool.name)||!Array.isArray(event.tool.references)||event.tool.references.some(id=>!valid(id))))throw new Error('执行器工具事实无效');
    const digest=hash(event),old=this.db.prepare('SELECT digest FROM agent_executor_receipts WHERE attempt_id=? AND event_id=?').get(event.attemptId,event.eventId);
    if(old && old.digest!==digest)throw new Error('执行器事件身份冲突');
    if(!old) {
      const task=this.facts(event);
      const canReconcile=event.reconciliation && ['bind','message','finish'].includes(event.kind);
      const stopped=!!this.db.prepare('SELECT 1 FROM agent_stop_requests WHERE task_id=? AND attempt_id=?').get(task.id,task.attemptId);
      if(task.status!=='running' && !(task.status==='stopping'&&task.stopRequested) && !canReconcile && !(stopped&&!task.stopRequested))throw new Error('任务尝试已停止或失效');
      if(task.status==='running'&&!stopped)this.active(event);
      if(task.threadId&&event.threadId&&task.threadId!==event.threadId||task.turnId&&event.turnId&&task.turnId!==event.turnId)throw new Error('执行器 thread/turn 不匹配');
      if(JSON.stringify(event).length>500_000)throw new Error('执行器事件过大');
      transaction(this.db,()=>this.db.prepare('INSERT INTO agent_executor_receipts(attempt_id,event_id,digest,payload,reference_id) VALUES(?,?,?,?,?)').run(event.attemptId,event.eventId,digest,JSON.stringify(event),task.id));
    }
    this.repair(); return this.task(event.taskId);
  }
  private repair() {
    for(const row of this.db.prepare('SELECT * FROM agent_stop_requests').all()) {
      const task=this.task(String(row.task_id));if(task.stopRequested)continue;
      transaction(this.db,()=>{
        task.stopRequested=true;
        task.status=['running','queued','waiting'].includes(task.status)||task.status==='unknown'&&task.recovery?.state==='active'?'stopping':task.executorStatus==='unknown'?'unknown':'stopped';
        task.cursor=this.changed(task.conversationId,task.id);
        this.db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task),task.id);
      });
    }
    for(const row of this.db.prepare('SELECT * FROM agent_executor_receipts WHERE applied=0 ORDER BY rowid').all()) {
      transaction(this.db,()=>{
        this.applyReceipt(parse(row.payload));
        this.db.prepare("UPDATE agent_executor_receipts SET applied=1 WHERE attempt_id=? AND event_id=?").run(row.attempt_id,row.event_id);
        const task=this.task(String(row.reference_id));
        if(!['running','stopping'].includes(task.status))this.db.prepare("UPDATE agent_executor_receipts SET payload=NULL,purpose='result-fact' WHERE attempt_id=? AND applied=1").run(task.attemptId);
      });
    }
  }
  private applyReceipt(event: AgentEvent) {
    return transaction(this.db, () => {
      if (!valid(event.eventId)) throw new Error('执行器事件身份无效');
      const duplicate = this.db.prepare('SELECT digest FROM agent_deliveries WHERE attempt_id=? AND event_id=?').get(event.attemptId, event.eventId);
      const digest = hash(event);
      if (duplicate) { if (duplicate.digest !== digest) throw new Error('执行器事件身份冲突'); return this.task(event.taskId); }
      const task = this.facts(event);
      if(event.recovery)task.recovery=event.recovery;
      if (task.threadId && event.threadId && task.threadId !== event.threadId || task.turnId && event.turnId && task.turnId !== event.turnId) throw new Error('执行器 thread/turn 不匹配');
      if (event.kind === 'bind') {
        task.threadId = event.threadId ?? task.threadId; task.turnId = event.turnId ?? task.turnId; task.model = event.model ?? task.model;
        this.db.prepare('UPDATE agent_conversations SET thread_id=? WHERE id=?').run(task.threadId, task.conversationId);
      } else if (event.kind === 'delta' || event.kind === 'message') {
        if (!valid(event.itemId) || !text(event.text, 200_000)) throw new Error('执行器消息无效');
        const id = `${task.id}:${event.itemId}`;
        const row = this.db.prepare('SELECT payload FROM agent_messages WHERE id=?').get(id);
        const previous = row ? parse(row.payload) as AgentMessage : undefined;
        if (previous?.state !== 'complete') this.message({ id, taskId: task.id, role: 'assistant', itemId: event.itemId,
          text: event.kind === 'message' ? event.text! : (previous?.text ?? '') + event.text!, state: event.kind === 'message' ? 'complete' : 'streaming' });
      } else if (event.kind === 'tool' && event.tool) {
        if (task.snapshot.intent !== 'question' && (event.tool.output as any)?.error) { task.mutationFailure = String((event.tool.output as any).error).slice(0,2000); task.toolErrors=[...(task.toolErrors??[]),{eventId:event.eventId,name:String(event.tool.name).slice(0,200),error:task.mutationFailure}].slice(-20); }
        this.db.prepare('INSERT INTO agent_tool_recovery VALUES(?,?,?,?,?,?,?,?,?)').run(`${task.attemptId}:${event.eventId}`, task.attemptId,
          'active-recovery', task.id, event.tool.name, JSON.stringify(event.tool.input), JSON.stringify(event.tool.output), hash(event.tool), JSON.stringify(event.tool.references));
      } else if (event.kind === 'finish') {
        if (!event.status || !['completed','failed','interrupted','unknown'].includes(event.status)) throw new Error('执行器终态无效');
        this.finish(task, event.status, event.error);
      } else throw new Error('未知执行器事件');
      if (event.kind !== 'finish') {
        task.cursor = this.changed(task.conversationId, task.id);
        this.db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task), task.id);
      }
      this.db.prepare('INSERT INTO agent_deliveries VALUES(?,?,?)').run(task.attemptId, event.eventId, digest); return task;
    });
  }
  mutationProgress(taskId: string, targetId: string, stage: 'read' | 'committed' | 'retained') {
    return transaction(this.db, () => {
      const task = this.task(taskId);
      task.progress = { targetId, stage, sequence: (task.progress?.sequence ?? 0) + 1 };
      task.cursor = this.changed(task.conversationId,task.id);
      this.db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task),task.id);
    });
  }
  group(result: import('../command-api').GroupResult) {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT id FROM agent_tasks WHERE attempt_id=?').get(result.attemptId);
      if (!row) return;
      const task = this.task(String(row.id));
      task.groups ??= [];
      if (task.groups.some(g => g.operationId === result.operationId)) return;
      task.groups.push(result);
      if(result.status==='committed' && result.changedObjectIds.length)delete task.mutationFailure;
      task.cursor = this.changed(task.conversationId,task.id);
      this.db.prepare('UPDATE agent_tasks SET payload=? WHERE id=?').run(JSON.stringify(task),task.id);
      this.mutationProgress(task.id, result.changedObjectIds.find(id=>!id.includes(':')) ?? task.snapshot.target.blockId ?? task.snapshot.target.unitId, result.status);
    });
  }
  revokeForQuit() {
    const tasks=this.db.prepare('SELECT payload FROM agent_tasks').all().map(r=>parse(r.payload) as AgentTask);
    transaction(this.db,()=>{
      for(const task of tasks)if(['running','queued','waiting','stopping'].includes(task.status))this.db.prepare('INSERT OR IGNORE INTO agent_stop_requests VALUES(?,?)').run(task.id,task.attemptId);
      this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE status='running'").run();
      this.db.prepare("UPDATE cg_bases SET read_values='[]',domain_basis=NULL WHERE attempt_id IN (SELECT id FROM cg_attempts WHERE status='stopped')").run();
    });
  }
  prepareShutdown() {
    this.repair();
    return this.db.prepare('SELECT payload FROM agent_tasks').all().map(r=>parse(r.payload) as AgentTask).filter(t=>t.status==='stopping');
  }
  dispatch(action: string, p: any) {
    if (action === 'agent:list') return this.list();
    if (action === 'agent:create') return this.create(p);
    if (action === 'agent:get') return this.get(p.sessionId, p.conversationId);
    if (action === 'agent:select') return this.select(p.conversationId);
    if (action === 'agent:saveDraft') return this.saveDraft(p);
    if (action === 'agent:submit') return this.submit(p);
    if (action === 'agent:stop') return this.stop(p);
    if (action === 'agent:continue') return this.continue(p);
    if (action === 'agent:facts') return this.facts(p);
    if (action === 'agent:task') { this.repair(); return this.task(p.taskId); }
    if (action === 'agent:record') return this.record(p);
    if (action === 'agent:readTarget') return this.readTarget(p);
    if (action === 'agent:active') return this.active(p);
    throw new Error('未知对话命令');
  }
}
