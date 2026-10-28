export interface BackupRequest { sessionId:string; directory:string; backupId:string }
export interface BackupResource { sha256:string; byteLength:number|null; path:string; declaredBy:string[] }
export interface FileDigest { sha256:string; byteLength:number }
export interface BackupManifest {
 schema:'yizhi-full-backup-1'; backupId:string; courseId:string; sourceDirectory:string; createdAt:string;
 phase:'snapshotting'|'copying'|'unfinished'|'complete'; diagnostic?:string;
 snapshot?:FileDigest; rootsExtracted?:true; database?:FileDigest; resources:BackupResource[];
 runtime:{node:string;electron?:string;sqlite:string};
}
export interface BackupAPI {
 create(request:BackupRequest):Promise<BackupManifest>;
 resume(request:BackupRequest):Promise<BackupManifest>;
 status(request:{directory:string}):Promise<BackupManifest>;
 verify(request:{directory:string}):Promise<BackupManifest>;
}
export interface BackupScheduling { afterSnapshot?:SharedArrayBuffer; beforeCopy?:SharedArrayBuffer; beforeMarker?:SharedArrayBuffer }
export function backupClient(invoke:(action:string,payload:any)=>Promise<any>):BackupAPI {
 return Object.fromEntries(['create','resume','status','verify'].map(m=>[m,(r:unknown)=>invoke('backup:'+m,r)])) as unknown as BackupAPI;
}
export interface BackupBridge {
 chooseCreate(request:{sessionId:string}):Promise<BackupManifest|null>;
 chooseResume(request:{sessionId:string}):Promise<BackupManifest|null>;
}
export function backupBridge(invoke:(action:string,payload:any)=>Promise<any>):BackupBridge{return {
 chooseCreate:r=>invoke('backup:chooseCreate',r),chooseResume:r=>invoke('backup:chooseResume',r),
};}
