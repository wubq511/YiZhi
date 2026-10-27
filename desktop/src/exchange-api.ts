export const exchangeVersion = 'yizhi-exchange-1' as const;
export const exchangeExcludes = [
  'outside-selected-units',
  'boundary-relations',
  'review-state',
  'layout',
  'reading-state',
  'personal-drawings',
  'drafts',
  'conversations',
  'tasks',
  'history',
  'experiment-runtime',
  'extension-packages',
  'source-citations',
  'question-bank',
] as const;
export interface ExchangeSummary {
  formatVersion: typeof exchangeVersion;
  kind: 'content-exchange';
  unitIds: string[];
  annotations: boolean;
  excludes: string[];
  counts: { units: number; relations: number; sources: number; resources: number; notes: number };
}
export interface ExchangePreview extends ExchangeSummary {
  packageDigest: string;
  basis: string;
}
export interface ExchangeReceipt {
  operationId: string;
  packageDigest: string;
  status: 'committed';
  cursor: number;
  unitIds: string[];
}
type Session = { sessionId: string };
export interface ExportExchange extends Session {
  directory: string;
  unitIds: string[];
  annotations: boolean;
}
export interface ImportExchange extends Session {
  directory: string;
  operationId: string;
  packageDigest: string;
  basis: string;
}
export interface ExchangeAPI {
  available(request: Session): Promise<Array<{ id: string; name: string }>>;
  exportPackage(request: ExportExchange): Promise<ExchangeSummary>;
  inspect(request: Session & { directory: string }): Promise<ExchangePreview>;
  importPackage(request: ImportExchange): Promise<ExchangeReceipt>;
  query(request: Session & { operationId: string }): Promise<ExchangeReceipt | null>;
}
export function exchangeClient(invoke: (action: string, payload: unknown) => Promise<any>): ExchangeAPI {
  return Object.fromEntries(
    ['available', 'exportPackage', 'inspect', 'importPackage', 'query'].map((method) => [
      method,
      (p: unknown) => invoke(`exchange:${method}`, p),
    ]),
  ) as unknown as ExchangeAPI;
}
export interface ExchangeBridge {
  available: ExchangeAPI['available'];
  query: ExchangeAPI['query'];
  chooseExport(request: Omit<ExportExchange, 'directory'>): Promise<ExchangeSummary | null>;
  chooseImport(request: Session): Promise<(ExchangePreview & { selectionId: string }) | null>;
  confirmImport(request: Session & { selectionId: string; operationId: string }): Promise<ExchangeReceipt>;
}
export function exchangeBridge(invoke: (action: string, payload: unknown) => Promise<any>): ExchangeBridge {
  return Object.fromEntries(
    ['available', 'query', 'chooseExport', 'chooseImport', 'confirmImport'].map((method) => [
      method,
      (p: unknown) => invoke(`exchange:${method}`, p),
    ]),
  ) as unknown as ExchangeBridge;
}
