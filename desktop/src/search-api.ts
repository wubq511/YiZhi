export type SearchScope = 'knowledge' | 'notes' | 'messages' | 'sources';
export const searchScopes: SearchScope[] = ['knowledge', 'notes', 'messages', 'sources'];
export interface SearchLocation {
  scope: SearchScope; entityId: string; version: string; title: string; field: string;
  unitId?: string; blockId?: string; disclosure: string[];
  noteId?: string; conversationId?: string; messageId?: string;
  sourceId?: string; versionId?: string; pdfPageIndex?: number;
  projectionId?: string; convention?: string; extractor?: string;
}
/** Offsets refer to exact text, in Unicode code points; never formula-model offsets. */
export interface SearchHit extends SearchLocation { text: string; start: number; end: number; quote: string; excerpt: string }
export interface SearchProblem { scope: SearchScope; entityId: string; title: string; reason: string }
export interface SearchStatus {
  pending: number; indexed: number; indexErrors: SearchProblem[]; unreadable: SearchProblem[]; noText: SearchProblem[];
  unavailable: number; // Catalog knowledge bodies without a delivered readable authority.
}
export interface SearchResults {
  hits: SearchHit[]; status: SearchStatus; mode: 'trigram' | 'literal';
  incomplete: boolean; directChecked: number; truncated: boolean;
}
export interface SearchAPI {
  query(request: { sessionId: string; query: string; scopes?: SearchScope[]; limit?: number }): Promise<SearchResults>;
  status(request: { sessionId: string }): Promise<SearchStatus>;
  rebuild(request: { sessionId: string; batchSize?: number; reset?: boolean; retryErrors?: boolean }): Promise<SearchStatus>;
  locate(request: { sessionId: string; hit: SearchHit }): Promise<SearchHit>;
}
export const searchMethods = ['query', 'status', 'rebuild', 'locate'] as const;
export function searchClient(invoke: (action: string, payload: any) => Promise<any>): SearchAPI {
  return Object.fromEntries(searchMethods.map(method => [method, (p: any) => invoke(`search:${method}`, p)])) as unknown as SearchAPI;
}
