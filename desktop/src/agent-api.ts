import type { SourceCitation, SourceVersion } from './sources-api';
export interface AgentSession { sessionId: string }
export interface QuestionTarget { unitId: string; blockId?: string; selectedText?: string }
export interface SubmitQuestion extends AgentSession {
  conversationId: string; operationId: string; generation: number; text: string;
  target: QuestionTarget; citationIds?: string[]; model?: string; intent?: import('./agent-mutation-api').AgentIntent;
}
export interface QuestionSnapshot {
  intent?: import('./agent-mutation-api').AgentIntent;
  text: string; target: QuestionTarget & { unitName: string; revision: string; blockVersion?: number };
  citations: Array<{ citation: SourceCitation; version: SourceVersion }>;
}
export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'partial' | 'pending';
export interface AgentTask {
  id: string; operationId: string; conversationId: string; attemptId: string; generation: number;
  groups?: import('./command-api').GroupResult[]; mutationFailure?: string;
  progress?: { targetId: string; stage: 'read' | 'committed' | 'retained'; sequence: number };
  snapshot: QuestionSnapshot; status: AgentTaskStatus; threadId: string | null; turnId: string | null;
  model: string | null; error: string | null; createdAt: string; cursor: number;
}
export interface Conversation { id: string; title: string; updatedAt: string }
export interface AgentMessage {
  id: string; taskId: string; role: 'user' | 'assistant'; text: string;
  state: 'streaming' | 'partial' | 'complete'; itemId: string | null;
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
}
export interface ExecutorStatus {
  available: boolean; path?: string; version?: string; error?: string;
  models: Array<{ id: string; model: string; displayName: string; isDefault: boolean; defaultReasoningEffort?: string }>;
}
export type AgentBridge = AgentAPI & { status(): Promise<ExecutorStatus> };
export function agentClient(invoke: (method: string, request?: any) => Promise<any>): AgentAPI {
  return {
    list: r => invoke('agent:list', r), create: r => invoke('agent:create', r), get: r => invoke('agent:get', r),
    select: r => invoke('agent:select', r), saveDraft: r => invoke('agent:saveDraft', r), submit: r => invoke('agent:submit', r),
  };
}
/** Host-only worker commands. No renderer may manufacture executor events or tool results. */
export interface AgentEvent extends AgentSession {
  taskId: string; attemptId: string; generation: number; eventId: string;
  threadId?: string; turnId?: string;
  kind: 'bind' | 'delta' | 'message' | 'finish' | 'tool'; itemId?: string; text?: string;
  status?: AgentTaskStatus; model?: string; error?: string;
  tool?: { name: string; input: unknown; output: unknown; references: string[] };
}
