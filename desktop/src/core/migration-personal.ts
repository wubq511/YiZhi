import { DatabaseSync } from 'node:sqlite';
import { readFileSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { locked,coursePath } from './migration';
import { hashFile } from './immutable-resource';
import { transaction } from './save-store';
/** Import records, never execute their old commands or manufacture selection proofs. */
export async function importPersonal(db:DatabaseSync,sourceDirectory:string) {
 const root=realpathSync(sourceDirectory);return locked(root,async child=>{
  child.stdin!.write(JSON.stringify({action:'hold'})+'\n');return importPersonalRecords(db,root);
 });
}
export function importPersonalRecords(db:DatabaseSync,root:string) {
  const manifest=JSON.parse(readFileSync(join(root,'课程.json'),'utf8')),path=coursePath(root,manifest.state),sourceHash=hashFile(path).sha256;
  if(db.prepare("SELECT value FROM metadata WHERE key='courseId'").get()?.value!==manifest.courseId)throw new Error('个人记录与内容候选课程身份不同');
  const oldReport=db.prepare("SELECT value FROM metadata WHERE key='personal-migration'").get();
  if(oldReport){const report=JSON.parse(String(oldReport.value));if(report.sourceHash!==sourceHash)throw new Error('源个人记录已变化，请重新建立候选');return report;}
  if(db.prepare('SELECT 1 FROM personal_notes LIMIT 1').get())throw new Error('内容候选已有个人记录，拒绝覆盖');
  const source=new DatabaseSync(path,{readOnly:true});
  try {
   const rows=source.prepare("SELECT * FROM documents WHERE namespace='notes' ORDER BY key").all();
   const report={schema:'yizhi-personal-migration-1',sourceDirectory:root,sourceHash,namespaces:{notes:{total:rows.length,imported:0,deleted:0}},gaps:[] as string[]};
   transaction(db,()=>{
    for(const row of rows){
     if(row.deleted){report.namespaces.notes.deleted++;continue;}
     const value=JSON.parse(String(row.value_json)),unitId=value.objectId??value.anchor?.objectId;
     const note={id:String(row.key),text:value.text,version:Number(row.revision),createdAt:value.createdAt??null,updatedAt:value.updatedAt??null,
      original:{unitId,fragments:[]},originalVersions:[],current:{unitId,status:'orphan',fragments:[]},
      legacy:{anchor:value.anchor??{},originalAnchor:value.originalAnchor,relocations:value.relocations,revision:Number(row.revision)}};
     db.prepare('INSERT INTO personal_notes VALUES(?,?)').run(note.id,JSON.stringify({note,lineage:[]}));report.namespaces.notes.imported++;
     report.gaps.push(`${note.id}：旧对象锚点缺少可核对的精确选区，保留原语境待重新关联`);
    }
    db.prepare("INSERT INTO metadata VALUES('personal-migration',?)").run(JSON.stringify(report));
   });return report;
  }finally{source.close();}
}
