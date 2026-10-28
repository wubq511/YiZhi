import type { SourceCitation, SourceVersion } from './sources-api';
export interface AgentSession { sessionId: string }
export interface QuestionTarget { unitId: string; blockId?: string; selectedText?: string }
export interface SubmitQuestion extends AgentSession {
  conversationId: string; operationId: string; generation: number; text: string;
  target: QuestionTarget; citationIds?: string[]; model?: string; intent?: import('./agent-mutation-api').AgentIntent;
  mode?: 'steer' | 'queue';
  generationSpec?: import('./generation-api').GenerationSpec;
}
export interface QuestionSnapshot {
  intent?: import('./agent-mutation-api').AgentIntent;
  text: string; target: QuestionTarget & { unitName: string; revision: string; blockVersion?: number };
  citations: Array<{ citation: SourceCitation; version: SourceVersion }>;
  generationSpec?: import('./generation-api').GenerationSpec;
}
export type AgentTaskStatus = 'running' | 'queued' | 'waiting' | 'stopping' | 'stopped' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'partial' | 'pending';
export interface AgentTaskRequest extends AgentSession { taskId: string }
export interface AgentDelivery {
  id: string; operationId: string; kind: 'steer' | 'student-change';
  state: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown';
  target?: QuestionTarget; threadId?: string; turnId?: string; error?: string;
  snapshot?: QuestionSnapshot; model?: string | null; handledTaskId?: string;
  reviewedBasisId?: string;
  integratedOperationIds?: string[];
  change?: { operationId: string; unitId: string; revision: number; objectIds: string[] };
}
export type AgentWorkRequest = AgentSession & { taskId: string; attemptId: string; generation: number } & (
  { action: 'activate' } |
  { action: 'inspect' } | { action: 'integrate' } |
  { action: 'delivery'; deliveryId: string; state: AgentDelivery['state']; threadId?: string; turnId?: string; error?: string }
);
export interface AgentTask {
  id: string; operationId: string; conversationId: string; attemptId: string; generation: number;
  blockedBy?: string[];
  guidedFrom?: { taskId: string; deliveryId: string };
  deliveries?: AgentDelivery[];
  integrationChecks?: import('./command-api').CandidateCheck[];
  waitingReason?: string;
  integrationRounds?: number;
  turnHistory?: Array<{ threadId: string; turnId: string; status: AgentTask['executorStatus'] }>;
  toolErrors?: Array<{eventId:string;name:string;error:string}>;
  executorStatus?: 'completed'|'failed'|'interrupted'|'unknown';
  groups?: import('./command-api').GroupResult[]; mutationFailure?: string;
  progress?: { targetId: string; stage: 'read' | 'committed' | 'retained'; sequence: number };
  generationProgress?: {completedStages:Array<'lesson'|'practice'>;pendingStages:Array<'lesson'|'practice'>};
  snapshot: QuestionSnapshot; status: AgentTaskStatus; threadId: string | null; turnId: string | null;
  model: string | null; error: string | null; createdAt: string; cursor: number;
  stopRequested?: boolean; continuesTaskId?: string; continuedByTaskId?: string;
  recovery?: { state: 'active' | 'resolved' | 'unknown'; checkedAt: string; detail: string };
}
export interface Conversation { id: string; title: string; updatedAt: string }
export interface AgentMessage {
  id: string; taskId: string; role: 'user' | 'assistant'; text: string;
  state: 'streaming' | 'partial' | 'complete'; itemId: string | null;
  deliveryId?: string;
}
export interface ConversationView extends Conversation {
  toolFacts: Array<{ taskId: string; name: string; purpose: string; referenceId: string; digest: string; references: string[]; hasRecoveryPayload: boolean }>;
  draft: { intent?: import('./agent-mutation-api').AgentIntent; text: string; seq: number; target?: QuestionTarget; citationIds: string[] }; messages: AgentMessage[]; tasks: AgentTask[];
}
export interface AgentAPI {
  list(request: AgentSession): Promise<{ conversations: Conversation[]; selectedId: string | null; generation: number }>;
  create(request: AgentSession & { operationId: string }): Promise<Conversation>;
  get(request: AgentSession & { conversationId: string }): Promise<ConversationView>;
  select(request: AgentSession & { conversationId: string }): Promise<void>;
  saveDraft(request: AgentSession & { conversationId: string; seq: number; text: string; intent?: import('./agent-mutation-api').AgentIntent; target?: QuestionTarget; citationIds?: string[] }): Promise<{ seq: number }>;
  submit(request: SubmitQuestion): Promise<AgentTask>;
  stop(request: AgentTaskRequest): Promise<AgentTask>;
  continue(request: AgentTaskRequest & { operationId: string }): Promise<AgentTask>;
}
export interface ExecutorStatus {
  available: boolean; path?: string; version?: string; error?: string;
  models: Array<{ id: string; model: string; displayName: string; isDefault: boolean; defaultReasoningEffort?: string }>;
}
export type AgentBridge = AgentAPI & { status(): Promise<ExecutorStatus>; reconcile(request: AgentTaskRequest): Promise<AgentTask>; retryDelivery(request: AgentSession & { taskId: string; deliveryId: string }): Promise<AgentTask>;
  generationCandidates(request:AgentTaskRequest):Promise<import('./generation-api').GenerationCandidateView[]> };
export function agentClient(invoke: (method: string, request?: any) => Promise<any>): AgentAPI {
  return {
    list: r => invoke('agent:list', r), create: r => invoke('agent:create', r), get: r => invoke('agent:get', r),
    select: r => invoke('agent:select', r), saveDraft: r => invoke('agent:saveDraft', r), submit: r => invoke('agent:submit', r),
    stop: r => invoke('agent:stop', r), continue: r => invoke('agent:continue', r),
  };
}
/** Host-only worker commands. No renderer may manufacture executor events or tool results. */
export interface AgentEvent extends AgentSession {
  taskId: string; attemptId: string; generation: number; eventId: string;
  threadId?: string; turnId?: string;
  kind: 'bind' | 'delta' | 'message' | 'finish' | 'tool'; itemId?: string; text?: string;
  status?: AgentTaskStatus; model?: string; error?: string;
  tool?: { name: string; input: unknown; output: unknown; references: string[] };
  /** Host reconciliation only: original turn facts; never grants commit qualification. */
  reconciliation?: boolean; recovery?: AgentTask['recovery'];
}
