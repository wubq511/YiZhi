/** Public course boundary for controlled producers and future executor adapters. */
export interface AttemptRequest { sessionId: string; taskId: string; resume?: boolean }
export interface Attempt { taskId: string; attemptId: string; generation: number; status: 'running' | 'stopped' | 'interrupted' }
export interface CommandObject { id: string; kind: 'block' | 'structure' | 'reference' | 'dependency'; version: number; value: Record<string, any> }
export interface CommandRead { context?: boolean; unitId?: string; sessionId: string; attemptId: string; objectIds: string[] }
export interface CommandBasis { context?: import('./consistency-api').ConsistencyContext; basisId: string; generation: number; objects: CommandObject[] }
export interface ObjectChange { objectId: string; value: Record<string, any> }
export interface GroupCommand { bundle?: import('./consistency-api').ConsistencyEdits; patch?: import('./editor-api').ContentPatch; unitId?: string; sessionId: string; attemptId: string; operationId: string; basisId: string; changes: ObjectChange[];
  resolves?: string[];
  semanticImpact?: { version: 1; unitId: string; conclusionOrMethodChanged: boolean } }
export interface GroupResult {
  basisId?: string; resolvedCandidateIds?: string[];
  operationId: string; attemptId: string; status: 'committed' | 'retained';
  unitId?: string; related?: import('./consistency-api').ConsistencyReceipt; revision?: number; cursor?: number; changedObjectIds: string[]; reason?: string;
  reviewPrompt?: import('./shared').ReviewPrompt;
}
export interface GroupHistory {
  operationId: string; attemptId?: string; taskId?: string; domain?: 'formal-relation'; actor?: 'agent' | 'student'; generation: number; revision: number; committedAt: string;
  changes: { objectId: string; before: Record<string, any> | null; after: Record<string, any> | null; beforeVersion: number; afterVersion: number }[];
}
export interface RetainedCandidate { command: GroupCommand; result: GroupResult }
export interface EditorProtection { sessionId: string; unitId?: string; editorId: string; sequence: number; blockIds: string[];
  mode: 'editing' | 'selection'; inputSeq: number }
export interface CandidateCheck { candidateId: string; status: 'committed' | 'waiting' | 'needs-reread' | 'conflict' | 'ineligible';
  reason?: string; objectIds: string[]; receipt?: GroupResult;
  parts?: Array<{ objectId: string; current: Record<string, any>; incoming: Record<string, any> }> }
export interface InputResolution { sessionId: string; operationId: string; draftSessionId: string; inputSeq: number;
  unitId?: string;
  basisRevision: number; blockIds: string[]; choice: 'student' | 'external' }
export interface CommandAPI {
  protect(request: EditorProtection): Promise<void>;
  releaseView(request: { sessionId: string }): Promise<void>;
  recheck(request: { sessionId: string; attemptId?: string }): Promise<CandidateCheck[]>;
  resolveInput(request: InputResolution): Promise<import('./shared').EditReceipt>;
  resolveCandidate(request: { sessionId: string; candidateId: string; basisRevision: number; choice: 'current' | 'incoming' }): Promise<GroupResult | null>;
  startAttempt(request: AttemptRequest): Promise<Attempt>;
  read(request: CommandRead): Promise<CommandBasis>;
  commit(command: GroupCommand): Promise<GroupResult>;
  stop(request: { sessionId: string; attemptId: string }): Promise<Attempt>;
  query(request: { sessionId: string; operationId: string }): Promise<GroupResult | null>;
  candidates(request: { sessionId: string; attemptId?: string; limit?: number }): Promise<RetainedCandidate[]>;
  history(request: { sessionId: string; limit?: number }): Promise<GroupHistory[]>;
}
export function commandClient(request: (action: string, payload: unknown) => Promise<any>): CommandAPI {
  return {
    protect: payload => request('commands:protect', payload),
    releaseView: payload => request('commands:releaseView', payload),
    recheck: payload => request('commands:recheck', payload),
    resolveInput: payload => request('commands:resolveInput', payload),
    resolveCandidate: payload => request('commands:resolveCandidate', payload),
    startAttempt: payload => request('commands:startAttempt', payload),
    read: payload => request('commands:read', payload),
    commit: payload => request('commands:commit', payload),
    stop: payload => request('commands:stop', payload),
    query: payload => request('commands:query', payload),
    candidates: payload => request('commands:candidates', payload),
    history: payload => request('commands:history', payload),
  };
}
