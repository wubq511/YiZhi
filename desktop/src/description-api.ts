import type { ExecutorStatus } from './agent-api';
import type { SearchHit, SearchResults, SearchScope } from './search-api';
export interface DescriptionRequest { sessionId: string; id: string; description: string; scopes: SearchScope[]; model?: string }
export interface DescriptionQuery extends Omit<SearchResults, 'hits' | 'directChecked'> {
  id: string; query: string; callId: string; hitIds: string[]; scopes: SearchScope[];
}
export interface DescriptionBasis { queryId: string; query: string; callId: string; originalRank: number }
export interface DescribedHit { id: string; hit: SearchHit; rank: number; basis: DescriptionBasis[] }
export interface DescriptionRun {
  id: string; description: string; scopes: SearchScope[]; state: 'running' | 'completed' | 'failed' | 'cancelled';
  outcome?: 'hits' | 'no-hit' | 'no-selection'; error?: string;
  executor?: { version: string; model: string }; threadId?: string; turnId?: string;
  queries: DescriptionQuery[]; hits: DescribedHit[];
  ranking?: { callId: string; hitIds: string[] };
  rejected: Array<{ id: string; reason: string }>;
  toolErrors: Array<{ callId: string; tool: string; reason: string }>;
}
/** Explicit search planning only; no chat/composer or filesystem interface. */
export interface DescriptionAPI {
  status(): Promise<ExecutorStatus>;
  start(request: DescriptionRequest): Promise<DescriptionRun>;
  get(request: { sessionId: string; id: string }): Promise<DescriptionRun>;
  cancel(request: { sessionId: string; id: string }): Promise<DescriptionRun>;
}
export const descriptionMethods = ['status', 'start', 'get', 'cancel'] as const;
export function descriptionClient(invoke: (action: string, payload?: any) => Promise<any>): DescriptionAPI {
  return Object.fromEntries(descriptionMethods.map(method => [method, (p?: any) => invoke(`description:${method}`, p)])) as unknown as DescriptionAPI;
}
