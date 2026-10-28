import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { FormatCapabilities } from '../format-api';
import type { CourseUnit } from '../shared';
import { EXTENSION_VERSIONS } from '../extensions-api';

export const CURRENT_COURSE_FORMAT=2,READER_CAPABILITY=2;
const bodyVersions=new Set(['review-reading-1','1']); // Both are already emitted by delivered T24/T30 producers.
const kinds=new Set(['paragraph','formula','table','callout','example','steps','exercise','knowledge-reference','figure','interactive']);
export function readableUnit(unit:CourseUnit){
 if(!bodyVersions.has(unit.reading?.schemaVersion)||!Array.isArray(unit.reading.blocks))return false;
 const walk=(blocks:any[]):boolean=>blocks.every(b=>b&&typeof b.id==='string'&&kinds.has(b.kind)&&b.payload&&(!b.children||Array.isArray(b.children)&&walk(b.children)));
 return walk(unit.reading.blocks);
}
/** Inspection uses a read-only connection before ownership/schema/PRAGMA writes. Unknown bytes stay intact. */
export function inspectFormat(directory:string):FormatCapabilities{
 const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});
 try{
  const has=(table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const metadata=(key:string)=>has('metadata')?db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value:undefined;
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),minimumReader=Number(metadata('minimum-reader')??1);
  const result:FormatCapabilities={courseFormat:version,minimumReader,writable:true,readableUnits:[],bodyVersions:[],extensionInterfaces:[],extensionInputs:[],extensionStates:[],reasons:[]};
  if(![1,2].includes(version))result.reasons.push('不支持的课程格式版本，拒绝写入');
  if(!Number.isSafeInteger(minimumReader)||minimumReader<1||minimumReader>READER_CAPABILITY)result.reasons.push('课程最低读取能力版本不受支持，拒绝写入');
  if(has('units'))for(const row of db.prepare('SELECT id,payload FROM units').all()){
   const unit=JSON.parse(String(row.payload));result.bodyVersions.push(String(unit.reading?.schemaVersion));
   if(readableUnit(unit))result.readableUnits.push(String(row.id));
   // Legacy reading-v1 explicitly permits opaque block data. Existing patch writers preserve it
   // and only edit supported block kinds; it is excluded from claims of complete read/export.
   if(!bodyVersions.has(unit.reading?.schemaVersion))result.reasons.push('正文载荷版本无法完整解释: '+String(row.id));
  }
  if(has('extension_packages'))for(const row of db.prepare('SELECT manifest FROM extension_packages').all()){
   const m=JSON.parse(String(row.manifest));
   result.extensionInterfaces.push(String(m.interfaceVersion));result.extensionInputs.push(String(m.inputVersion));result.extensionStates.push(String(m.stateVersion));
   if(m.interfaceVersion!=='extension-api-1')result.reasons.push('实验运行接口版本不受支持');
   if(!['bits-3-v1','bits-4-v1'].includes(m.inputVersion))result.reasons.push('实验输入版本不受支持');
   if(!['parity-state-1','parity-state-2','parity-state-3'].includes(m.stateVersion))result.reasons.push('实验现场版本不受支持');
   if(!EXTENSION_VERSIONS.includes(m.packageVersion))result.reasons.push('实验资源包版本不受支持');
  }
  result.writable=result.reasons.length===0;
  if(![1,2].includes(version)||minimumReader<1||minimumReader>READER_CAPABILITY||!Number.isSafeInteger(minimumReader))result.readableUnits=[];
  if(result.reasons.some(r=>r.startsWith('实验')))result.readableUnits=result.readableUnits.filter(id=>id!=='KU-001');
  for(const key of ['bodyVersions','extensionInterfaces','extensionInputs','extensionStates'] as const)result[key]=[...new Set(result[key])];
  return result;
 }finally{db.close();}
}
export function readUnderstoodUnit(directory:string,unitId:string):CourseUnit{
 const capabilities=inspectFormat(directory);
 if(!capabilities.readableUnits.includes(unitId))throw new Error('该范围的格式或正文版本无法完整解释，拒绝读取／导出');
 const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});try{return JSON.parse(String(db.prepare('SELECT payload FROM units WHERE id=?').get(unitId)!.payload));}finally{db.close();}
}
export function assertWritableFormat(directory:string){const c=inspectFormat(directory);if(!c.writable)throw new Error(c.reasons.join('；'));return c;}
