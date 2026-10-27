export interface ReadingBlock {
  id: string;
  kind: string;
  role?: string;
  payload: Record<string, any>;
  children?: ReadingBlock[];
  [key: string]: unknown;
}
export interface CourseUnit {
  id: string;
  name: string;
  outcome: string;
  theme: { id: string; name: string };
  rating: { stars: number };
  reading: { schemaVersion: string; blocks: ReadingBlock[]; [key: string]: unknown };
  [key: string]: unknown;
}
export interface OpenedCourse {
  courseId: string;
  sessionId: string;
  revision: number;
  confirmedInputSeq: number;
  editableBlockId: string;
  unit: CourseUnit;
  runtime: { node: string; electron?: string; sqlite: string;
    pragmas: { journalMode: string; foreignKeys: number; synchronous: number } };
}
export interface SaveParagraph {
  sessionId: string;
  operationId: string;
  inputSeq: number;
  baseRevision: number;
  blockId: string;
  text: string;
}
export interface SaveReceipt {
  operationId: string;
  sessionId: string;
  inputSeq: number;
  revision: number;
  blockId: string;
}
export interface DesktopBridge {
  open(): Promise<OpenedCourse>;
  graph(sessionId: string): Promise<CourseGraph>;
  readUnit(sessionId: string, unitId: string): Promise<CourseUnit>;
  readingState(sessionId: string): Promise<ReadingState | null>;
  setReadingState(sessionId: string, state: ReadingState): Promise<void>;
  save(command: SaveParagraph): Promise<SaveReceipt>;
  onCloseRequested(listener: () => Promise<boolean>): () => void;
}
export interface ReadingState {
  unitId: string;
  expanded: Record<string, boolean>;
  returnStack: Array<{ unitId: string; blockId: string; scrollTop: number; camera?: { x: number; y: number; zoom: number } }>;
  camera?: { x: number; y: number; zoom: number };
  scrollTop: number;
}
export interface CourseGraph {
  nodes: Array<{ id: string; name: string; kind: string; themeId: string; themeName: string; stars: number }>;
  groups: Array<{ id: string; name: string }>;
  edges: Array<{ id: string; fromUnitId: string; toUnitId: string; type: string; view: string; value: string; sourceRefs: Array<{ sourceId: string; pdfPages?: number[]; note?: string }>; requirementGroupId?: string }>;
  requirementGroups: Array<{ id: string; targetUnitId: string; mode: "all" | "any"; unitIds: string[]; relationIds: string[]; value: string }>;
  conditions: Record<string, { required: string[]; groups: string[] }>;
  layout: { nodes: Array<{ unitId: string; x: number; y: number; width: number; height: number }>; groups: Array<any> };
}
