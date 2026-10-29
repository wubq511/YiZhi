import type { ReadingBlock } from './shared';
export interface ModelCell { latex: string; depth: number }
export interface FormulaModel { version: 1; encoding: 'mathlive-model'; latex: string; cells: ModelCell[] }
export interface AnnotationFragment {
  blockId: string; field: 'text' | 'latex'; block: ReadingBlock; formalRevision: number;
  contentVersion?: number; source: 'formal' | 'student-draft';
  projection: { version: 1; encoding: 'unicode-code-points'; text: string } | FormulaModel;
  from: number; to: number; quote: string;
}
export interface AnnotationSelection { unitId: string; fragments: AnnotationFragment[] }
export interface AnchorLocation { blockId: string; version: string; field: 'text' | 'latex'; from: number; to: number; quote: string;
  model?: FormulaModel; status: 'attached' | 'orphan'; reason?: string }
export interface PersonalNote { legacy?:{anchor:Record<string,any>;revision:number;[key:string]:unknown}; id: string; text: string; version: number; original: AnnotationSelection; originalVersions: string[];
  current: { unitId?: string; status: 'attached' | 'orphan'; fragments: AnchorLocation[] }; createdAt: string|null; updatedAt: string|null }
type Session = { sessionId: string };
type Write = Session & { operationId: string };
export interface AnnotationAPI {
  list(request: Session): Promise<PersonalNote[]>;
  create(request: Write & { selection: AnnotationSelection; text: string }): Promise<PersonalNote>;
  update(request: Write & { id: string; expectedVersion: number; text: string }): Promise<PersonalNote>;
  reassociate(request: Write & { id: string; expectedVersion: number; selection: AnnotationSelection }): Promise<PersonalNote>;
  query(request: Session & { operationId: string }): Promise<PersonalNote | null>;
}
export const annotationMethods = ['list', 'create', 'update', 'reassociate', 'query'] as const;
export function annotationClient(invoke: (action: string, request: unknown) => Promise<any>): AnnotationAPI {
  return Object.fromEntries(annotationMethods.map(method => [method, (request: unknown) => invoke(`annotations:${method}`, request)])) as unknown as AnnotationAPI;
}
/** Explicit conversion; reject offsets in a surrogate pair rather than cutting a character. */
export function codePointOffset(text: string, utf16: number): number {
  if (!Number.isSafeInteger(utf16) || utf16 < 0 || utf16 > text.length ||
    (utf16 > 0 && utf16 < text.length && /[\uD800-\uDBFF]/.test(text[utf16 - 1]) && /[\uDC00-\uDFFF]/.test(text[utf16]))) throw new Error('选区切开了 Unicode 字符');
  return Array.from(text.slice(0, utf16)).length;
}
export function utf16Offset(text: string, points: number): number {
  if (!Number.isSafeInteger(points) || points < 0 || points > Array.from(text).length) throw new Error('选区超出文字范围');
  return Array.from(text).slice(0, points).join('').length;
}
export interface TextEditProof { blockId: string; before: string; after: string; from: number; to: number; inserted: string }
export interface FormulaEditProof { blockId: string; before: FormulaModel; after: FormulaModel; from: number; to: number; inserted: number }
