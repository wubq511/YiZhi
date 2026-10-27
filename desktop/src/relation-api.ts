import type { CourseGraph } from './shared';
export type FormalRelation = CourseGraph['edges'][number];
export type RequirementGroup = CourseGraph['requirementGroups'][number];
export interface RelationSource { id: string; title: string; versions: { id: string; totalPages?: number }[] }
export interface RelationRead { sessionId: string; attemptId?: string }
/** Whole-graph basis fences membership, route semantics and requires-cycle decisions together. */
export interface RelationBasis { basisId: string; generation: number; revision: number; graph: CourseGraph;
  sources: RelationSource[]; retiredUnitIds: string[] }
export interface RelationCommand extends RelationRead { operationId: string; basisId: string; generation: number;
  changes: { id: string; value: FormalRelation | null }[];
  groupChanges?: { id: string; value: RequirementGroup | null }[] }
export interface RelationReceipt { domain: 'formal-relation'; operationId: string; status: 'committed'; generation: number; revision: number;
  cursor: number; changedObjectIds: string[] }
export interface RelationAPI {
  prerequisites(request: { sessionId: string; unitId: string }): Promise<Pick<CourseGraph, 'nodes' | 'edges' | 'conditions' | 'requirementGroups'>>;
  read(request: RelationRead): Promise<RelationBasis>;
  commit(command: RelationCommand): Promise<RelationReceipt>;
  query(request: { sessionId: string; operationId: string }): Promise<RelationReceipt | null>;
}
export function relationClient(request: (action: string, payload: unknown) => Promise<any>): RelationAPI {
  return { prerequisites: payload => request('relations:prerequisites', payload), read: payload => request('relations:read', payload), commit: payload => request('relations:commit', payload),
    query: payload => request('relations:query', payload) };
}
