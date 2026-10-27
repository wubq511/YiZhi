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
  drafts: RecoverableDraft[];
  eventCursor: number;
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
export interface DesktopBridge extends SaveBridge {
  commands: import('./command-api').CommandAPI;
  open(): Promise<OpenedCourse>;
  save(command: SaveParagraph): Promise<SaveReceipt>;
  onCloseRequested(listener: () => Promise<boolean>): () => void;
}

/** A delta over a named formal revision, not an old whole-unit snapshot. */
export interface TextChange { blockId: string; text: string }
export interface ParagraphSplit { blockId: string; newBlockId: string; offset: number }
export interface DraftInput {
  sessionId: string;
  inputSeq: number;
  baseRevision: number;
  changes: TextChange[];
  splits?: ParagraphSplit[];
  /** False for incomplete editor syntax: retained, never promoted as formal content. */
  complete: boolean;
  /** Explicit takeover after recovering an ended session's draft. */
  replacesDraft?: { sessionId: string; inputSeq: number };
}
export interface DraftReceipt { sessionId: string; inputSeq: number; cursor: number }
export interface RecoverableDraft { input: DraftInput; receipt: DraftReceipt }
export interface EditCommand extends DraftInput { operationId: string }
export interface EditReceipt extends SaveReceipt { blockIds: string[]; cursor: number }
export interface EditHistory {
  receipt: SaveReceipt; before: unknown; after: unknown;
  /** Earlier formats may have no recorded commit time. */
  committedAt: string | null;
}
export type SaveEventData =
  { type: 'draft.saved'; sessionId: string; inputSeq: number } |
  { type: 'content.committed'; receipt: EditReceipt } |
  { type: 'group.committed'; operationId: string; revision: number; changedObjectIds: string[] };
export type SaveEvent = SaveEventData & { cursor: number };
export type EventPage = { kind: 'events'; events: SaveEvent[]; cursor: number; hasMore: boolean } |
  { kind: 'reset'; reason: 'cursor-expired'; cursor: number; snapshot: OpenedCourse };

/** The editor adapter's IPC boundary. No renderer owns the database or durable truth. */
export interface SaveBridge {
  saveDraft(input: DraftInput): Promise<DraftReceipt>;
  commitEdit(command: EditCommand): Promise<EditReceipt>;
  queryOperation(sessionId: string, operationId: string): Promise<SaveReceipt | null>;
  readEvents(sessionId: string, after: number, limit?: number): Promise<EventPage>;
  read(sessionId: string): Promise<OpenedCourse>;
}
