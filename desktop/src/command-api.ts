/** Public course boundary for controlled producers and future executor adapters. */
export interface AttemptRequest { sessionId: string; taskId: string; resume?: boolean }
export interface Attempt { taskId: string; attemptId: string; generation: number; status: 'running' | 'stopped' | 'interrupted' }
export interface CommandObject { id: string; kind: 'block' | 'structure' | 'reference' | 'dependency'; version: number; value: Record<string, any> }
export interface CommandRead { sessionId: string; attemptId: string; objectIds: string[] }
export interface CommandBasis { basisId: string; generation: number; objects: CommandObject[] }
export interface ObjectChange { objectId: string; value: Record<string, any> }
export interface GroupCommand { sessionId: string; attemptId: string; operationId: string; basisId: string; changes: ObjectChange[] }
export interface GroupResult {
  operationId: string; attemptId: string; status: 'committed' | 'retained';
  revision?: number; changedObjectIds: string[]; reason?: string;
}
export interface GroupHistory {
  operationId: string; attemptId: string; taskId: string; generation: number; revision: number; committedAt: string;
  changes: { objectId: string; before: Record<string, any> | null; after: Record<string, any>; beforeVersion: number; afterVersion: number }[];
}
export interface RetainedCandidate { command: GroupCommand; result: GroupResult }
export interface CommandAPI {
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
    startAttempt: payload => request('commands:startAttempt', payload),
    read: payload => request('commands:read', payload),
    commit: payload => request('commands:commit', payload),
    stop: payload => request('commands:stop', payload),
    query: payload => request('commands:query', payload),
    candidates: payload => request('commands:candidates', payload),
    history: payload => request('commands:history', payload),
  };
}
