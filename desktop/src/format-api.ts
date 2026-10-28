import type { CourseUnit } from './shared';
export interface FormatCapabilities {
 courseFormat:number; minimumReader:number; writable:boolean; readableUnits:string[];
 bodyVersions:string[]; extensionInterfaces:string[]; extensionInputs:string[]; extensionStates:string[]; reasons:string[];
 unitNames?:Record<string,string>;
}
export function formatClient(invoke:(action:string,payload:any)=>Promise<any>){return {
 inspect:(request:{directory:string}):Promise<FormatCapabilities>=>invoke('format:inspect',request),
 readUnit:(request:{directory:string;unitId:string}):Promise<CourseUnit>=>invoke('format:readUnit',request),
 validate:(request:{directory:string}):Promise<{courseId:string;generation:number;units:number;resources:number;capabilities:FormatCapabilities}>=>invoke('format:validate',request),
};}
export interface ReadonlyCourseBridge {
 inspect():Promise<FormatCapabilities>;
 readUnit(request:{unitId:string}):Promise<CourseUnit>;
 exportText(request:{unitId:string}):Promise<boolean>;
}
/** Explicitly a text/formula extraction, never a complete course or lossless content exchange. */
export function understoodText(unit:CourseUnit,includeTitle=true):string{
 const walk=(blocks:CourseUnit['reading']['blocks']):string=>blocks.map(b=>{
  const p=b.payload,parts:string[]=[];
  for(const key of ['title','text','latex','problem','hint','answer','caption','alt','intent'])if(typeof p[key]==='string')parts.push(p[key]);
  if(b.kind==='steps'&&Array.isArray(p.items))parts.push(...p.items.filter((v:unknown)=>typeof v==='string'));
  if(b.kind==='table'&&Array.isArray(p.columns)&&Array.isArray(p.rows))parts.push(p.columns.join('\t'),...p.rows.map((r:unknown[])=>r.join('\t')));
  if(b.kind==='interactive')parts.push('（实验现场不运行；本导出只包含文本与公式）');
  if(b.kind==='figure')parts.push('（图片与图形资源不在本导出范围）');
  if(b.children)parts.push(walk(b.children));return parts.join('\n');
 }).join('\n\n');
 return [...(includeTitle?[unit.name]:[]),unit.outcome,'只读文本与公式；图片、实验现场及其他个人记录不在本导出范围。',walk(unit.reading.blocks)].filter(Boolean).join('\n\n');
}
