import type { SourceVersion, SourceCommand, SourceSession } from './sources-api';
export type Bounds = [number, number, number, number];
export interface ArtifactResource { sha256: string; byteLength: number; relativePath: string; mediaType: 'application/json' | 'image/png' | 'application/pdf' }
export interface ParseText { id: string; text: string; bounds: Bounds; markedContentId: string | null; font: string; direction: string; transform: number[]; width: number; height: number; corrected?: boolean }
export interface ParseStructure { role: string; id?: string; alt?: string; bounds?: Bounds; children: ParseStructure[] }
export interface ParsedPage {
  schema: 'yizhi-pdf-page-v1'; source: SourceVersion; pdfPageIndex: number; view: Bounds; rotation: number;
  coordinateSpace: 'pdf-user-space'; tool: { name: string; version: string; adapter: string }; config: { version: 1; ocr: 'none'; rasterScale: 1 };
  textStatus: 'text-layer' | 'ocr-needed'; text: ParseText[]; structure: ParseStructure | null;
  images: Array<{ id: string; bounds: Bounds; markedContentId: string | null; representation: 'page-raster-region' }>;
  resources: ArtifactResource[]; limitations: string[];
  correction?: { parentArtifactId: string; note: string; correctedAt: string };
}
export interface ArtifactRef { artifactId: string; taskId: string; attemptId: string; operationId: string; pdfPageIndex: number; digest: string;
  resource: ArtifactResource; resources: ArtifactResource[]; confirmedAt: string; origin: 'parser' | 'student-correction'; parentArtifactId?: string }
export interface ParseAttempt { attemptId: string; generation: number; operationId: string; startedAt: string; finishedAt?: string; failure?: string; pagesStarted: number[]; outputs?: Array<{ pdfPageIndex: number; status: 'confirmed' | 'rejected' | 'failed'; digest?: string; failure?: string }> }
export interface ParseTask { taskId: string; source: SourceVersion; generation: number; operationId: string; attemptId: string;
  tool: ParsedPage['tool']; config: ParsedPage['config']; status: 'running' | 'completed' | 'stopped' | 'interrupted' | 'failed';
  confirmed: ArtifactRef[]; attempts: ParseAttempt[]; failure?: string }
export interface ParsingAPI {
  readResource(request: SourceSession & { artifactId: string; sha256: string; begin: number; end: number }): Promise<{ bytes: Uint8Array; total: number; mediaType: string }>;
  start(request: SourceCommand & { versionId: string }): Promise<ParseTask>;
  continue(request: SourceCommand & { taskId: string }): Promise<ParseTask>;
  stop(request: SourceCommand & { taskId: string; attemptId: string }): Promise<ParseTask>;
  get(request: SourceSession & { taskId: string }): Promise<ParseTask>;
  list(request: SourceSession): Promise<ParseTask[]>;
  artifact(request: SourceSession & { artifactId: string }): Promise<ParsedPage>;
  artifacts(request: SourceSession & { versionId: string }): Promise<ArtifactRef[]>;
  correct(request: SourceCommand & { artifactId: string; textId: string; text: string; note: string }): Promise<ArtifactRef>;
  query(request: SourceSession & { operationId: string }): Promise<unknown | null>;
}
export function parsingClient(invoke: (action: string, payload: any) => Promise<any>): ParsingAPI {
  return Object.fromEntries(['start','continue','stop','get','list','artifact','artifacts','correct','query','readResource'].map(method =>
    [method, (request: unknown) => invoke(`parsing:${method}`, request)])) as unknown as ParsingAPI;
}
/** Host-only deterministic scheduling controls; no renderer surface, no replacement parser/results. */
export interface ParseScheduling { pageIndex: number; beforeCompute?: SharedArrayBuffer; beforeResult?: SharedArrayBuffer }

export type ParsingBridge = Omit<ParsingAPI, 'readResource'>;
export function parsingBridge(invoke: (action: string, payload: any) => Promise<any>): ParsingBridge {
  const { readResource: _, ...bridge } = parsingClient(invoke); return bridge;
}
