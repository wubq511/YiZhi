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
  commands: import('./command-api').CommandAPI;
  open(): Promise<OpenedCourse>;
  save(command: SaveParagraph): Promise<SaveReceipt>;
  onCloseRequested(listener: () => Promise<boolean>): () => void;
}
