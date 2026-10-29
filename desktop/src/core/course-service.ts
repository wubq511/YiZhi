import { historyClient } from '../history-api';
import { backupClient } from '../backup-api';
import { formatClient } from '../format-api';
import { upgradeClient } from '../upgrade-api';
import { retentionClient } from '../retention-api';
import { courseRestoreClient } from '../course-restore-api';
import { exchangeClient } from '../exchange-api';
import { searchClient } from '../search-api';
import { migrationClient } from '../migration-api';
import { drawingClient } from '../drawing-api';
import { annotationClient } from '../annotation-api';
import { extensionsClient } from '../extensions-api';
import { experimentsClient } from '../experiments-api';
import { agentClient, type AgentEvent, type AgentTask } from '../agent-api';
import { relationClient } from '../relation-api';
import { Worker } from 'node:worker_threads';
import { commandClient } from '../command-api';
import { parsingClient, type ParseScheduling } from '../parsing-api';
import { sourcesClient } from '../sources-api';
import type { CourseGraph, CourseUnit, ReadingState, OpenedCourse, SaveParagraph, SaveReceipt, DraftInput, DraftReceipt, EditCommand, EditReceipt, EditHistory, EventPage, ReviewSnapshot, ReviewStatus, ReviewPromptResult } from '../shared';

/** One instance belongs to the application host, shared by all its windows/courses. */
export class CourseService {
  readonly upgrade=upgradeClient((action,payload)=>this.request(action,payload));
  readonly backup=backupClient((action,payload)=>this.request(action,payload));
  readonly format=formatClient((action,payload)=>this.request(action,payload));
  readonly retention=retentionClient((action,payload)=>this.request(action,payload));
  readonly courseRestore=courseRestoreClient((action,payload)=>this.request(action,payload));
  readonly formalHistory = historyClient((action,payload)=>this.request(action,payload));
  readonly exchange = exchangeClient((action, payload) => this.request(action, payload));
  readonly search = searchClient((action, payload) => this.request(action, payload));
  readonly migration = migrationClient((action, payload) => this.request(action, payload));
  readonly drawings = drawingClient((action, payload) => this.request(action, payload));
  readonly annotations = annotationClient((action, payload) => this.request(action, payload));
  readonly extensions = extensionsClient((action, payload) => this.request(action, payload));
  readonly experiments = experimentsClient((action, payload) => this.request(action, payload));
  readonly agent = agentClient((action, payload) => this.request(action, payload));
  readAgentTarget(request: { sessionId: string; taskId: string; attemptId: string; generation: number }): Promise<unknown> { return this.request('agent:readTarget', request); }
  readAgentMutation(request: import('../agent-mutation-api').AgentIdentity): Promise<import('../agent-mutation-api').AgentMutationContext> { return this.request('agentMutation:read',request); }
  applyAgentMutation(request: import('../agent-mutation-api').AgentIdentity & {input: import('../agent-mutation-api').AgentMutation}): Promise<import('../command-api').GroupResult> { return this.request('agentMutation:apply',request); }
  queryAgentMutation(request: import('../agent-mutation-api').AgentIdentity & {operationId:string}): Promise<import('../command-api').GroupResult|null> { return this.request('agentMutation:query',request); }
  readAgentGeneration(request: import('../agent-mutation-api').AgentIdentity): Promise<import('../generation-api').GenerationContext> { return this.request('generation:read',request); }
  publishAgentGeneration(request: import('../generation-api').GenerationRequest): Promise<import('../generation-api').GenerationResult> { return this.request('generation:publish',request); }
  queryAgentGeneration(request: import('../agent-mutation-api').AgentIdentity & {operationId:string}): Promise<import('../generation-api').GenerationResult|null> { return this.request('generation:query',request); }
  generationCandidates(request: {sessionId:string;taskId:string}): Promise<import('../generation-api').GenerationCandidateView[]> { return this.request('generation:candidates',request); }
  recordAgent(event: AgentEvent): Promise<AgentTask> { return this.request('agent:record', event); }
  agentTask(request: {sessionId:string;taskId:string}): Promise<AgentTask> { return this.request('agent:task',request); }
  prepareAgentShutdown(): Promise<Array<{sessionId:string;task:AgentTask}>> { return this.request('agentShutdown'); }
  activeAgent(request: { sessionId: string; taskId: string; attemptId: string; generation: number }): Promise<AgentTask> { return this.request('agent:active', request); }
  updateAgentWork(request: import('../agent-api').AgentWorkRequest): Promise<AgentTask> { return this.request('agent:work', request); }
  queueAgentGuidance(request: import('../agent-mutation-api').AgentIdentity & { deliveryId: string }): Promise<AgentTask> { return this.request('agent:queueGuidance', request); }
  readonly relations = relationClient((action, payload) => this.request(action, payload));
  readonly commands = commandClient((action, payload) => this.request(action, payload));
  readonly parsing = parsingClient((action, payload) => this.request(action, payload));
  readonly sources = sourcesClient((action, payload) => this.request(action, payload));
  private readonly worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private stopped = false;
  private closing?: Promise<void>;
  private failure?: Error;
  constructor(workerPath: string, options?: { observe?: boolean; sourceScheduling?:import('../sources-api').SourceScheduling; upgradeScheduling?:import('../upgrade-api').UpgradeScheduling; cutoverScheduling?:import('./directory-authority').CutoverScheduling; backupScheduling?:import('../backup-api').BackupScheduling; retentionScheduling?:import('../retention-api').RetentionScheduling; parseScheduling?: ParseScheduling; migrationScheduling?: import('../migration-api').MigrationScheduling; restoreScheduling?:import('../course-restore-api').CourseRestoreScheduling }) {
    this.worker = new Worker(workerPath, { workerData: options });
    this.worker.on('message', message => {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error));
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
    this.worker.on('error', fail);
    this.worker.on('exit', code => { this.stopped = true; fail(new Error(`课程核心已停止 (${code})`)); });
  }
  private request<T>(action: string, payload?: unknown): Promise<T> {
    if (this.stopped || this.failure || this.closing) return Promise.reject(this.failure ?? new Error('课程核心正在退出'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, action, payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  /** Host-only failure recovery; never exposed to generated frames or the preload. */
  observe(): Promise<import('../acceptance-observation').CoreObservation> { return this.request('acceptance:observe'); }
  recoverExtensionRenderers(sessionId?:string): Promise<void> {return this.request('extensions:recoverRenderers',{sessionId});}
  open(directory: string): Promise<OpenedCourse> { return this.request('open', { directory }); }
  openLearningView(request:{sessionId:string;viewId:string}):Promise<{unconfirmedTail:boolean;detail:string}> {return this.request('learningView:open',request);}
  confirmLearningView(request:{sessionId:string;viewId:string}):Promise<void> {return this.request('learningView:confirm',request);}
  releaseLearningView(request:{sessionId:string;viewId:string;saved:boolean}):Promise<void> {return this.request('learningView:release',request);}
  read(sessionId: string, unitId?: string): Promise<OpenedCourse> { return this.request('read', { sessionId, unitId }); }
  graph(sessionId: string): Promise<CourseGraph> { return this.request('graph', { sessionId }); }
  readUnit(sessionId: string, unitId: string): Promise<CourseUnit> { return this.request('readUnit', { sessionId, unitId }); }
  setLayout(sessionId: string, updates: import('../layout').LayoutPlacement[]): Promise<void> { return this.request('setLayout', { sessionId, updates }); }
  projectLayout(sessionId: string, sizes: import('../layout').LayoutSizes, fixed?: import('../layout').LayoutPlacement): Promise<import('../layout').LayoutNode[]> { return this.request('projectLayout', { sessionId, sizes, fixed }); }
  readingState(sessionId: string): Promise<ReadingState | null> { return this.request('readingState', { sessionId }); }
  setReadingState(sessionId: string, state: ReadingState): Promise<void> { return this.request('setReadingState', { sessionId, state }); }
  reviewStates(sessionId: string): Promise<ReviewSnapshot> { return this.request('reviewStates', { sessionId }); }
  setReviewStatus(sessionId: string, unitId: string, status: ReviewStatus): Promise<ReviewSnapshot> { return this.request('setReviewStatus', { sessionId, unitId, status }); }
  confirmReviewPrompt(sessionId: string, promptId: string, adjust: boolean): Promise<ReviewPromptResult> { return this.request('confirmReviewPrompt', { sessionId, promptId, adjust }); }
  save(command: SaveParagraph): Promise<SaveReceipt> { return this.request('save', command); }
  saveDraft(input: DraftInput): Promise<DraftReceipt> { return this.request('saveDraft', input); }
  commitEdit(command: EditCommand): Promise<EditReceipt> { return this.request('commitEdit', command); }
  queryOperation(sessionId: string, operationId: string): Promise<SaveReceipt | null> { return this.request('queryOperation', { sessionId, operationId }); }
  history(sessionId: string): Promise<EditHistory[]> { return this.request('history', { sessionId }); }
  readEvents(sessionId: string, after: number, limit = 64): Promise<EventPage> { return this.request('readEvents', { sessionId, after, limit }); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.stopped) return Promise.resolve();
    const drained = this.request<void>('close');
    this.closing = drained.finally(async () => { await this.worker.terminate(); });
    return this.closing;
  }
}
