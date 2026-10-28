import type { CourseUnit } from './shared';
export interface FormatCapabilities {
 courseFormat:number; minimumReader:number; writable:boolean; readableUnits:string[];
 bodyVersions:string[]; extensionInterfaces:string[]; extensionInputs:string[]; extensionStates:string[]; reasons:string[];
}
export function formatClient(invoke:(action:string,payload:any)=>Promise<any>){return {
 inspect:(request:{directory:string}):Promise<FormatCapabilities>=>invoke('format:inspect',request),
 readUnit:(request:{directory:string;unitId:string}):Promise<CourseUnit>=>invoke('format:readUnit',request),
};}
