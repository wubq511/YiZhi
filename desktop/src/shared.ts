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
  save(command: SaveParagraph): Promise<SaveReceipt>;
  onCloseRequested(listener: () => Promise<boolean>): () => void;
}
export interface CourseGraph {
  nodes: Array<{ id: string; name: string; kind: string; themeId: string; themeName: string; stars: number }>;
  groups: Array<{ id: string; name: string }>;
  edges: Array<{ id: string; fromUnitId: string; toUnitId: string; type: string; view: string; value: string; sourceRefs: unknown[] }>;
  layout: { nodes: Array<{ unitId: string; x: number; y: number; width: number; height: number }>; groups: Array<any> };
}
