import type { CourseUnit, RecoverableDraft } from './shared';
import type { HistoryChange } from './history-api';
/** Host-only deterministic process-interruption verification; not exposed in preload. */
export interface CourseRestoreScheduling {beforeCommit?:SharedArrayBuffer;afterCommit?:SharedArrayBuffer}
export interface CourseRestoreSelection {atOperationId:string;side:'before'|'after';unitIds:string[];userState:{layout:boolean;review:boolean}}
export interface CourseRestorePermit extends CourseRestoreSelection {token:string;generation:number}
export interface CourseRestorePreview extends CourseRestorePermit {
 affectedUnitIds:string[];changes:HistoryChange[];units:Array<{id:string;name:string;blockCount:number}>;
 preservedDrafts:number;sourceVersions:string[];explanations:string[];
}
export interface CourseRestoreResult {domain:'course-restore';operationId:string;status:'committed';generation:number;sessionId:string;cursor:number;unitIds:string[];changedObjectIds:string[];preservedDrafts:number}
export interface PreservedDraft extends RecoverableDraft {restoreOperationId:string;generation:number}
export interface CourseRestoreAPI {
 preview(request:CourseRestoreSelection&{sessionId:string}):Promise<CourseRestorePreview>;
 apply(request:{sessionId:string;operationId:string;preview:CourseRestorePermit}):Promise<CourseRestoreResult>;
 query(request:{sessionId:string;operationId:string}):Promise<CourseRestoreResult|null>;
 drafts(request:{sessionId:string}):Promise<PreservedDraft[]>;
}
export function courseRestoreClient(invoke:(action:string,payload:unknown)=>Promise<any>):CourseRestoreAPI {
 return {preview:p=>invoke('courseRestore:preview',p),apply:p=>invoke('courseRestore:apply',p),query:p=>invoke('courseRestore:query',p),drafts:p=>invoke('courseRestore:drafts',p)};
}
