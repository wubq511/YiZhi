import type { LayoutPlacement } from './layout';
import type { AnnotationSelection } from './annotation-api';
import type { ReadingBlock } from './shared';
export type DrawingKind = 'rectangle' | 'ellipse' | 'arrow' | 'line' | 'wave' | 'highlighter';
export interface DrawingGeometry { x: number; y: number; width: number; height: number }
export type DrawingAnchor = { space: 'board' } | { space: 'object' | 'image'; unitId: string; blockId?: string; block?: ReadingBlock } | { space: 'text'; noteId: string };
export interface DrawingValue { color?:string; kind: DrawingKind; anchor: DrawingAnchor; geometry: DrawingGeometry }
export interface PersonalDrawing { legacy?:{[key:string]:any}; id: string; version: number; value: DrawingValue | null; original: DrawingValue; status: 'attached' | 'orphan' | 'deleted' }
export interface DrawingHistory {
  committedAt: string; actor: 'student'; operationId: string; id: string; before: DrawingValue | null; after: DrawingValue | null; version: number }
export interface DrawingApply { sessionId: string; operationId: string; id: string; expectedVersion: number; value: DrawingValue | null; selection?: AnnotationSelection }
export interface PlacementChange { operationId: string; before: LayoutPlacement; after: LayoutPlacement }
export interface PlacementEdit extends PlacementChange { committedAt: string; actor: 'student' }
export interface DrawingAPI {
  place(request: PlacementChange & { sessionId: string }): Promise<PlacementEdit>;
  queryPlacement(request: { sessionId: string; operationId: string }): Promise<PlacementEdit | null>;
  placements(request: { sessionId: string }): Promise<PlacementEdit[]>;
  list(request: { sessionId: string }): Promise<PersonalDrawing[]>;
  apply(request: DrawingApply): Promise<PersonalDrawing>;
  query(request: { sessionId: string; operationId: string }): Promise<PersonalDrawing | null>;
  history(request: { sessionId: string; id?: string }): Promise<DrawingHistory[]>;
}
export const drawingMethods = ['list', 'apply', 'query', 'history', 'place', 'queryPlacement', 'placements'] as const;
export function drawingClient(invoke: (action: string, request: unknown) => Promise<any>): DrawingAPI {
  return Object.fromEntries(drawingMethods.map(method => [method, (request: unknown) => invoke(`drawings:${method}`, request)])) as unknown as DrawingAPI;
}
