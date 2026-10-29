import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { assertWritableFormat } from './course-format';
import { declaredResourceRoots } from './retention-resources';
import { fileDigest } from './backup';

/** Offline verification for a checked work copy. Never acquires writable course admission. */
export async function validateCourseCopy(directory:string){
 const capabilities=assertWritableFormat(directory),db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true});
 try{
  if(db.prepare('PRAGMA integrity_check').get()!.integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('工作副本数据库结构或外键核对失败');
  const meta=(key:string)=>db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
  const courseId=String(meta('courseId')??'');if(!courseId)throw new Error('工作副本缺少课程身份');
  const units=db.prepare('SELECT id,payload FROM units').all().map(r=>JSON.parse(String(r.payload))),ids=new Set(units.map(u=>u.id)),blocks=new Set<string>();
  const raw=meta('course-graph'),graph=raw?JSON.parse(String(raw)):undefined;
  if(graph){
   const graphIds=new Set(graph.nodes.map((n:any)=>n.id)),themes=new Set(graph.groups.map((g:any)=>g.id));
   if(graphIds.size!==graph.nodes.length||graph.nodes.some((n:any)=>!ids.has(n.id)||!themes.has(n.themeId)))throw new Error('工作副本结构含缺失单元／主题引用');
   if(graph.edges.some((e:any)=>!graphIds.has(e.fromUnitId)||!graphIds.has(e.toUnitId)))throw new Error('工作副本关系目标不存在');
   if(graph.layout.nodes.length!==graphIds.size||new Set(graph.layout.nodes.map((n:any)=>n.unitId)).size!==graphIds.size||graph.layout.nodes.some((n:any)=>!graphIds.has(n.unitId)))throw new Error('工作副本布局引用不完整');
   for(const group of graph.requirementGroups??[])if(!graphIds.has(group.targetUnitId)||group.unitIds.some((id:string)=>!graphIds.has(id))||group.relationIds.some((id:string)=>!graph.edges.some((e:any)=>e.id===id)))throw new Error('工作副本前置组引用不完整');
  }
  const has=(table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const versions=new Set(has('source_versions')?db.prepare('SELECT id FROM source_versions').all().map(r=>String(r.id)):[]);
  const walk=(list:any[])=>{for(const block of list){
   if(!block.id||blocks.has(block.id)||!block.payload)throw new Error('工作副本正文身份重复或载荷不完整');blocks.add(block.id);
   if(graph&&block.kind==='knowledge-reference'&&!ids.has(block.payload.targetUnitId))throw new Error('工作副本知识引用目标不存在');
   if(graph)for(const ref of block.sourceRefs??[])if(ref.versionId&&!versions.has(ref.versionId))throw new Error('工作副本固定来源版本引用不存在');
   walk(block.children??[]);
  }};
  for(const unit of units){if(!Array.isArray(unit.reading?.blocks))throw new Error('工作副本正文结构无效');walk(unit.reading.blocks);}
  if(has('parse_artifacts'))for(const row of db.prepare('SELECT payload FROM parse_artifacts').all()){
   const ref=JSON.parse(String(row.payload));if(!ref.resource||!Array.isArray(ref.resources))throw new Error('解析产物引用结构无效');
  }
  const refs=declaredResourceRoots(db);
  for(const ref of refs){const actual=await fileDigest(join(directory,ref.path));if(actual.sha256!==ref.sha256||ref.byteLength!==null&&ref.byteLength!==actual.byteLength)throw new Error('工作副本资源摘要或长度不符: '+ref.path);}
  return {courseId,generation:Number(meta('generation')??1),units:units.length,resources:refs.length,capabilities};
 }finally{db.close();}
}
