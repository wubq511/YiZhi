export interface SourceSession { sessionId: string }
export interface SourceCommand extends SourceSession { operationId: string; generation: number }
export interface SourceVersion {
  sourceId: string; versionId: string; sha256: string; byteLength: number;
  mediaType: 'application/pdf' | 'image/png' | 'image/jpeg'; originalName: string;
  title: string; pdfPages: number; importedAt: string;
}
/** Host-only: paths never cross the renderer's public bridge. */
export interface ImportSource extends SourceCommand { path: string; title: string; sourceId?: string }
export interface SourceReceipt { operationId: string; generation: number; cursor: number; version: SourceVersion }
export interface ResourceRange extends SourceSession { versionId: string; begin: number; end: number }
export interface SourceList { generation: number; versions: SourceVersion[]; intents: UpdateIntent[]; readingSeq: number }
export interface SourcePageRequest extends SourceSession { versionId: string; pdfPageIndex: number }
export interface PrintedPage { id: string; versionId: string; pdfPageIndex: number; label: string; verifiedBy: 'student'; verifiedAt: string }
export interface SourcePage {
  versionId: string; pdfPageIndex: number; view: number[]; rotation: number;
  printedPage: PrintedPage | null;
  projection: { id: string; convention: 'pdfjs-text-items-eol/codepoint-v1'; extractor: string;
    text: string; items: Array<{ text: string; start: number; end: number }> };
}
export interface CiteSource extends SourceCommand {
  versionId: string; pdfPageIndex: number; projectionId?: string; start?: number; end?: number;
  region?: { x0: number; y0: number; x1: number; y1: number };
  target?: { unitId: string; blockId?: string };
}
export interface SourceCitation {
  id: string; versionId: string; sourceId: string; sha256: string; pdfPageIndex: number;
  printedPage: PrintedPage | null; projection: Pick<SourcePage['projection'], 'id' | 'convention' | 'extractor'>;
  quote: string | null; start: number | null; end: number | null;
  textStatus: 'selected-text' | 'page-or-region' | 'no-text-layer';
  region: CiteSource['region'] | null; coordinateSpace: 'pdf-user-space' | 'image-pixels-top-left';
  createdAt: string;
  target?: CiteSource['target'];
}
export interface UpdateIntent { id: string; versionId: string; decision: 'update' | 'defer'; createdAt: string; generation: number }
export interface SourceReadingContext { open: boolean; versionId: string; pdfPageIndex: number; scrollTop: number; scrollLeft: number; scale: number; target?: CiteSource['target'] }
export interface SourcesAPI {
  importFile(command: ImportSource): Promise<SourceReceipt>;
  repairFile(command: SourceCommand & { versionId: string; path: string }): Promise<SourceVersion>;
  list(request: SourceSession): Promise<SourceList>;
  getVersion(request: SourceSession & { versionId: string }): Promise<SourceVersion>;
  page(request: SourcePageRequest): Promise<SourcePage>;
  mapPrintedPage(request: SourceCommand & { versionId: string; pdfPageIndex: number; printedPage: string }): Promise<PrintedPage>;
  locatePrintedPage(request: SourceSession & { versionId: string; printedPage: string }): Promise<PrintedPage[]>;
  cite(request: CiteSource): Promise<SourceCitation>;
  citations(request: SourceSession): Promise<SourceCitation[]>;
  setUpdateIntent(request: SourceCommand & { versionId: string; decision: 'update' | 'defer' }): Promise<UpdateIntent>;
  query(request: SourceSession & { operationId: string }): Promise<unknown | null>;
  context(request: SourceSession): Promise<SourceReadingContext | null>;
  saveContext(request: SourceSession & { generation: number; seq: number; state: SourceReadingContext }): Promise<void>;
  readResource(request: ResourceRange): Promise<{ bytes: Uint8Array; total: number; mediaType: SourceVersion['mediaType'] }>;
}
export function sourcesClient(invoke: (action: string, payload: any) => Promise<any>): SourcesAPI {
  return {
    importFile: request => invoke('sources:importFile', request),
    repairFile: request => invoke('sources:repairFile', request),
    list: request => invoke('sources:list', request),
    getVersion: request => invoke('sources:getVersion', request),
    page: request => invoke('sources:page', request),
    mapPrintedPage: request => invoke('sources:mapPrintedPage', request),
    locatePrintedPage: request => invoke('sources:locatePrintedPage', request),
    cite: request => invoke('sources:cite', request),
    citations: request => invoke('sources:citations', request),
    setUpdateIntent: request => invoke('sources:setUpdateIntent', request),
    query: request => invoke('sources:query', request),
    context: request => invoke('sources:context', request),
    saveContext: request => invoke('sources:saveContext', request),
    readResource: request => invoke('sources:readResource', request),
  };
}

/** Deliberately excludes host-only file import/repair and resource-range IPC. */
export type SourceBridge = Omit<SourcesAPI, 'importFile' | 'repairFile' | 'readResource'> & {
  chooseImport(request: SourceCommand & { sourceId?: string }): Promise<SourceReceipt | null>;
  chooseRepair(request: SourceCommand & { versionId: string }): Promise<SourceVersion | null>;
};
export function sourceBridge(invoke: (action: string, payload: any) => Promise<any>): SourceBridge {
  const { importFile: _, repairFile: _repair, readResource: _range, ...publicAPI } = sourcesClient(invoke);
  return { ...publicAPI, chooseImport: request => invoke('sources:chooseImport', request), chooseRepair: request => invoke('sources:chooseRepair', request) };
}

/** Host-only scheduling seam; validates real bytes before holding publication. */
export interface SourceScheduling { beforePublish?: SharedArrayBuffer }
