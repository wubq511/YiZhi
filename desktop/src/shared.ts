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
  blockVersions?: Record<string, number>;
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
  /** Exact original input basis, even when the core integrated independent intervening edits. */
  basedOnRevision?: number;
}
export interface DesktopBridge extends SaveBridge {
  annotations: import('./annotation-api').AnnotationAPI;
  extensions: Omit<import('./extensions-api').ExtensionsAPI, 'resource'>;
  experiments: import('./experiments-api').ExperimentsAPI;
  agent: import('./agent-api').AgentBridge;
  parsing: import('./parsing-api').ParsingBridge;
  sources: import('./sources-api').SourceBridge;
  commands: import('./command-api').CommandAPI;
  relations: import('./relation-api').RelationAPI;
  open(): Promise<OpenedCourse>;
  graph(sessionId: string): Promise<CourseGraph>;
  readUnit(sessionId: string, unitId: string): Promise<CourseUnit>;
  setLayout(sessionId: string, updates: import('./layout').LayoutPlacement[]): Promise<void>;
  projectLayout(sessionId: string, sizes: import('./layout').LayoutSizes, fixed?: import('./layout').LayoutPlacement): Promise<import('./layout').LayoutNode[]>;
  readingState(sessionId: string): Promise<ReadingState | null>;
  setReadingState(sessionId: string, state: ReadingState): Promise<void>;
  reviewStates(sessionId: string): Promise<ReviewSnapshot>;
  setReviewStatus(sessionId: string, unitId: string, status: ReviewStatus): Promise<ReviewSnapshot>;
  confirmReviewPrompt(sessionId: string, promptId: string, adjust: boolean): Promise<ReviewPromptResult>;
  save(command: SaveParagraph): Promise<SaveReceipt>;
  onCloseRequested(listener: () => Promise<boolean>): () => void;
}
export type ReviewStatus = 'pending' | 'weak' | 'mastered';
export interface ReviewSnapshot {
  units: Record<string, { status: ReviewStatus; version: number }>;
  themes: Record<string, { pending: number; weak: number; mastered: number }>;
  prompts: ReviewPrompt[];
}
export interface ReviewPrompt { id: string; unitId: string; contentRevision: number; stateVersion: number; semanticVersion: 1 }
export type ReviewPromptResult = 'adjusted' | 'kept' | 'stale';
export interface ReadingState {
  pinnedUnitId?: 'KU-001';
  modification?: { targetId: string; ended: boolean };
  unitId: string;
  expanded: Record<string, boolean>;
  returnStack: Array<{ unitId: string; blockId: string; scrollTop: number; camera?: { x: number; y: number; zoom: number } }>;
  camera?: { x: number; y: number; zoom: number };
  scrollTop: number;
}
export interface CourseGraph {
  nodes: Array<{ id: string; name: string; kind: string; themeId: string; themeName: string; stars: number }>;
  groups: Array<{ id: string; name: string }>;
  edges: Array<{ id: string; fromUnitId: string; toUnitId: string; type: string; directed: boolean; view: string; value: string; sourceRefs: Array<{ sourceId: string; versionId?: string; section?: string; pdfPages?: number[]; note?: string }>; requirementGroupId?: string }>;
  requirementGroups: Array<{ id: string; targetUnitId: string; mode: "all" | "any"; unitIds: string[]; relationIds: string[]; value: string; sourceRefs?: Array<{ sourceId: string; versionId?: string; pdfPages?: number[]; section?: string }> }>;
  counts?: { units: number; themes: number; relations: number };
  themeEdges?: Array<{ fromThemeId: string; toThemeId: string; type: string; relationIds: string[]; count: number }>;
  conditions: Record<string, { required: string[]; groups: string[] }>;
  layout: { nodes: Array<{ unitId: string; x: number; y: number; width: number; height: number }>; groups: Array<any> };
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
  patch?: import('./editor-api').ContentPatch;
  formulaDrafts?: import('./editor-api').FormulaDraft[];
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
  { type: 'annotation.changed'; noteId: string } |
  { type: 'agent.changed'; conversationId: string; taskId?: string } |
  { type: 'parse.changed'; taskId: string; attemptId: string; kind: string; artifactId?: string } |
  { type: 'draft.saved'; sessionId: string; inputSeq: number } |
  { type: 'content.committed'; receipt: EditReceipt } |
  { type: 'relations.committed'; operationId: string; revision: number; changedObjectIds: string[] } |
  { type: 'group.committed'; operationId: string; revision: number; changedObjectIds: string[] } |
  { type: 'extension.changed'; instanceId: string; definitionVersion: string } |
  { type: 'experiment.changed'; instanceId: string; definitionRevision: number } |
  { type: 'source.registered'; versionId: string; sourceId: string } |
  { type: 'source.changed'; kind: string; operationId: string };
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
