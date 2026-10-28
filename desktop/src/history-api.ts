import type { CourseUnit } from './shared';
import type { GroupHistory } from './command-api';
export type HistoryChange = GroupHistory['changes'][number];
export interface HistoryGroup {
  operationId: string; activityId: string; taskId?: string; actor: 'agent' | 'student';
  committedAt: string; explanation: string; unitIds: string[]; changes: HistoryChange[];
  order: string; source: 'group' | 'student' | 'placement';
}
export interface HistoryActivity {
  id: string; actor: 'agent' | 'student'; taskId?: string; committedAt: string; explanation: string;
  unitIds: string[]; operationIds: string[]; affectedObjectIds: string[]; order: string;
}
export type HistorySelection = { kind: 'operations'; operationIds: string[] } | { kind: 'task'; taskId: string };
export interface HistoryPreview {
  token: string; retentionPin?: string; kind: 'undo' | 'restore'; selection?: HistorySelection; unitId?: string; atOperationId?: string; side?: 'before' | 'after'; includeLayout?: boolean;
  unit?: CourseUnit; groups: HistoryGroup[]; affectedObjectIds: string[]; unitIds: string[];
  sourceVersions: string[]; runningTaskIds: string[]; drafts: number; explanations: string[];
}
export interface HistoryResult {
  operationId: string; status: 'committed' | 'partial' | 'conflict'; applied: string[];
  conflicts: Array<{operationId:string;objectIds:string[];reason:string}>; changedObjectIds: string[]; cursor: number;
}
export interface HistoryAPI {
  release(request:{sessionId:string;pinId:string}):Promise<void>;
  list(request:{sessionId:string;unitId?:string;limit?:number;before?:string}):Promise<{activities:HistoryActivity[];next?:string}>;
  detail(request:{sessionId:string;operationId:string}):Promise<HistoryGroup>;
  preview(request:{sessionId:string;selection:HistorySelection} | {sessionId:string;unitId:string;atOperationId:string;side:'before'|'after';includeLayout?:boolean}):Promise<HistoryPreview>;
  apply(request:{sessionId:string;operationId:string;preview:HistoryPreview}):Promise<HistoryResult>;
  query(request:{sessionId:string;operationId:string}):Promise<HistoryResult|null>;
}
export function historyClient(request:(action:string,payload:unknown)=>Promise<any>):HistoryAPI {
  return {release:p=>request('formalHistory:release',p),list:p=>request('formalHistory:list',p),detail:p=>request('formalHistory:detail',p),preview:p=>request('formalHistory:preview',p),apply:p=>request('formalHistory:apply',p),query:p=>request('formalHistory:query',p)};
}
