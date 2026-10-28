import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { FormatCapabilities } from '../format-api';
import type { CourseUnit } from '../shared';
import { EXTENSION_VERSIONS } from '../extensions-api';

export const CURRENT_COURSE_FORMAT=2,READER_CAPABILITY=2;
const bodyVersions=new Set(['review-reading-1','1']); // Both are already emitted by delivered T24/T30 producers.
const kinds=new Set(['paragraph','formula','table','callout','example','steps','exercise','knowledge-reference','figure','interactive']);
function payloadVersions(blocks:any[]):string[]{return blocks.flatMap(b=>[...([b?.schemaVersion,b?.payload?.schemaVersion].filter(v=>v!==undefined).map(String)),...(Array.isArray(b?.children)?payloadVersions(b.children):[])]);}
export function readableUnit(unit:CourseUnit){
 if(!bodyVersions.has(unit.reading?.schemaVersion)||!Array.isArray(unit.reading.blocks))return false;
 if(payloadVersions(unit.reading.blocks).some(v=>!bodyVersions.has(v)))return false;
 const walk=(blocks:any[]):boolean=>blocks.every(b=>{
  if(!b||typeof b.id!=='string'||!kinds.has(b.kind)||!b.payload)return false;
  const p=b.payload;if(['title','text','latex','problem','hint','answer','caption','alt','intent'].some(k=>p[k]!==undefined&&typeof p[k]!=='string'))return false;
  if(['paragraph','callout'].includes(b.kind)&&typeof p.text!=='string'||b.kind==='formula'&&typeof p.latex!=='string')return false;
  if(b.kind==='steps'&&(!Array.isArray(p.items)||p.items.some((v:unknown)=>typeof v!=='string')))return false;
  if(b.kind==='table'&&(!Array.isArray(p.columns)||p.columns.some((v:unknown)=>typeof v!=='string')||!Array.isArray(p.rows)||p.rows.some((r:unknown)=>!Array.isArray(r)||r.some(v=>typeof v!=='string'&&typeof v!=='number'))))return false;
  return !b.children||Array.isArray(b.children)&&walk(b.children);
 });
 return walk(unit.reading.blocks);
}
/** Inspection uses a read-only connection before ownership/schema/PRAGMA writes. Unknown bytes stay intact. */
export function inspectFormat(directory:string,connection?:DatabaseSync):FormatCapabilities{
 const db=connection??new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});
 if(!connection)db.exec('BEGIN');
 try{
  const has=(table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const metadata=(key:string)=>has('metadata')?db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value:undefined;
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version),minimumReader=Number(metadata('minimum-reader')??1);
  const result:FormatCapabilities={courseFormat:version,minimumReader,writable:true,readableUnits:[],unitNames:{},bodyVersions:[],extensionInterfaces:[],extensionInputs:[],extensionStates:[],reasons:[]};
  if(![1,2].includes(version))result.reasons.push('不支持的课程格式版本，拒绝写入');
  if(!Number.isSafeInteger(minimumReader)||minimumReader<1||minimumReader>READER_CAPABILITY)result.reasons.push('课程最低读取能力版本不受支持，拒绝写入');
  if(has('units'))for(const row of db.prepare('SELECT id,payload FROM units').all()){
   const unit=JSON.parse(String(row.payload));result.unitNames![String(row.id)]=String(unit.name??row.id);result.bodyVersions.push(String(unit.reading?.schemaVersion));
   if(readableUnit(unit))result.readableUnits.push(String(row.id));
   // Legacy reading-v1 explicitly permits opaque block data. Existing patch writers preserve it
   // and only edit supported block kinds; it is excluded from claims of complete read/export.
   if(!bodyVersions.has(unit.reading?.schemaVersion))result.reasons.push('正文载荷版本无法完整解释: '+String(row.id));
   if(!Array.isArray(unit.reading?.blocks))result.reasons.push('正文载荷结构无法完整解释: '+String(row.id));
   else for(const version of payloadVersions(unit.reading.blocks)){result.bodyVersions.push(version);if(!bodyVersions.has(version))result.reasons.push('正文块载荷版本无法完整解释: '+String(row.id));}
  }
  const checkExtension=(m:any)=>{
   if(!m||typeof m!=='object'){result.reasons.push('实验定义版本声明不完整');return;}
   result.extensionInterfaces.push(String(m.interfaceVersion));result.extensionInputs.push(String(m.inputVersion));result.extensionStates.push(String(m.stateVersion));
   if(m.interfaceVersion!=='extension-api-1')result.reasons.push('实验运行接口版本不受支持');
   if(!['bits-3-v1','bits-4-v1'].includes(m.inputVersion))result.reasons.push('实验输入版本不受支持');
   if(!['parity-state-1','parity-state-2','parity-state-3'].includes(m.stateVersion))result.reasons.push('实验现场版本不受支持');
   if(!EXTENSION_VERSIONS.includes(m.packageVersion))result.reasons.push('实验资源包版本不受支持');
   const expected:Record<string,string[]>= {'1.0.0':['bits-3-v1','parity-state-1'],'1.1.0':['bits-3-v1','parity-state-2'],'2.0.0':['bits-4-v1','parity-state-3']};
   if(expected[m.packageVersion]&&JSON.stringify(expected[m.packageVersion])!==JSON.stringify([m.inputVersion,m.stateVersion]))result.reasons.push('实验输入／现场版本与资源包声明不匹配');
  };
  if(has('extension_packages'))for(const row of db.prepare('SELECT manifest FROM extension_packages').all())checkExtension(JSON.parse(String(row.manifest)));
  if(has('extension_scene'))for(const row of db.prepare('SELECT payload FROM extension_scene').all()){
   const scene=JSON.parse(String(row.payload));checkExtension(scene.definition);if(scene.pending)checkExtension(scene.pending);
  }
  result.writable=result.reasons.length===0;
  if(![1,2].includes(version)||minimumReader<1||minimumReader>READER_CAPABILITY||!Number.isSafeInteger(minimumReader))result.readableUnits=[];
  if(result.reasons.some(r=>r.startsWith('实验')))result.readableUnits=result.readableUnits.filter(id=>id!=='KU-001');
  for(const key of ['bodyVersions','extensionInterfaces','extensionInputs','extensionStates'] as const)result[key]=[...new Set(result[key])];
  return result;
 }finally{if(!connection)db.close();}
}
export function readUnderstoodUnit(directory:string,unitId:string):CourseUnit{
 const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});
 try{
  db.exec('BEGIN');const capabilities=inspectFormat(directory,db);
  if(!capabilities.readableUnits.includes(unitId))throw new Error('该范围的格式或正文版本无法完整解释，拒绝读取／导出');
  return JSON.parse(String(db.prepare('SELECT payload FROM units WHERE id=?').get(unitId)!.payload));
 }finally{db.close();}
}
export function assertWritableFormat(directory:string){const c=inspectFormat(directory);if(!c.writable)throw new Error(c.reasons.join('；'));return c;}
