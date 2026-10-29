import type { DirectoryDecision,DirectoryStatus } from './core/directory-authority';
export interface UpgradeRequest {sessionId:string;directory:string;backupDirectory:string;upgradeId:string;automatic?:boolean;saveBarrier?:{viewId:string;confirmedAt:string}}
export interface UpgradeScheduling {afterBackup?:SharedArrayBuffer;beforeValidation?:SharedArrayBuffer}
export interface UpgradePublish {sessionId?:string;sourceDirectory?:string;upgradeId:string}
export interface UpgradePreparation extends DirectoryDecision {kind:'format-upgrade';report:{backupDirectory:string;backupId:string;fromVersion:1;toVersion:2;validation:{courseId:string;generation:number;units:number;resources:number}}}
export interface UpgradeBridge {
 info(request:{sessionId:string}):Promise<{courseFormat:number;directory:string;decision:DirectoryDecision|null}>;
 choose(request:{sessionId:string}):Promise<DirectoryDecision|null>;
 chooseRecover():Promise<boolean>;
}
export function upgradeClient(invoke:(action:string,payload:any)=>Promise<any>){return {
 prepare:(r:UpgradeRequest):Promise<UpgradePreparation>=>invoke('upgrade:prepare',r),
 cancel:(r:{sessionId:string;upgradeId:string}):Promise<DirectoryDecision|null>=>invoke('upgrade:cancel',r),
 publish:(r:UpgradePublish):Promise<DirectoryDecision>=>invoke('upgrade:publish',r),
 recover:(r:{directory:string}):Promise<{directory:string;decision:DirectoryDecision|null}>=>invoke('upgrade:recover',r),
 status:(r:{directory:string}):Promise<DirectoryStatus>=>invoke('upgrade:status',r),
};}
