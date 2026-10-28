export interface RetentionStatus {
 days:number;cutoff:string;removedBefore:string|null;oldestAvailable:string|null;pendingGroups:number;notice:string;blocked?:string;
}
export interface RetentionScheduling {clock?:SharedArrayBuffer;manual?:boolean;beforeCommit?:SharedArrayBuffer;afterCommit?:SharedArrayBuffer}
export interface ResourceLease {id:string;purpose:string;state:'active'|'released';createdAt:string;releasedAt:string|null}
export interface RetentionSpace {categories:Array<{id:string;label:string;bytes:number;rows:number;kind:'logical'|'files'}>;databaseBytes:number;reusableBytes:number;notice:string}
export interface RetentionAPI {
 get(request:{sessionId:string}):Promise<RetentionStatus>;
 set(request:{sessionId:string;days:number}):Promise<RetentionStatus>;
 run(request:{sessionId:string;limit?:number}):Promise<{pending:boolean;removed:number;phase:string;blocked?:string}>;
 /** Host-only T26 seam, intentionally omitted from preload. Acquire before SQLite backup. */
 resourceLease(request:{sessionId:string;id:string;action:'acquire'|'release'}):Promise<ResourceLease>;
 resourceLeases(request:{sessionId:string}):Promise<ResourceLease[]>;
 space(request:{sessionId:string}):Promise<RetentionSpace>;
 clearCache(request:{sessionId:string;limit?:number}):Promise<{pending:boolean;removed:number}>;
}
export function retentionClient(invoke:(action:string,payload:unknown)=>Promise<any>):RetentionAPI {
 return {get:p=>invoke('retention:get',p),set:p=>invoke('retention:set',p),run:p=>invoke('retention:run',p),resourceLease:p=>invoke('retention:resourceLease',p),resourceLeases:p=>invoke('retention:resourceLeases',p),space:p=>invoke('retention:space',p),clearCache:p=>invoke('retention:clearCache',p)};
}
