import { importRecordHistory } from './migration-history';
import { migrateAgent } from './migration-agent';
import { initializeMigrationRecords,migrateNativeState,origin } from './migration-state';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { locked,coursePath,legacySaveBarrier } from './migration';
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
  const candidate=db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
  if(!candidate)throw new Error('缺少T24内容候选的来源证明');
  const content=JSON.parse(String(candidate.value));
  for(const [file,hash] of Object.entries(content.report.sourceHashes))if(hashFile(coursePath(root,file)).sha256!==hash)throw new Error('内容候选与当前源内容摘要不符，请重新转换');
  const oldReport=db.prepare("SELECT value FROM metadata WHERE key='personal-migration'").get();
  if(oldReport){const report=JSON.parse(String(oldReport.value));if(report.sourceHash!==sourceHash)throw new Error('源个人记录已变化，请重新建立候选');return report;}
  if(db.prepare('SELECT 1 FROM personal_notes LIMIT 1').get())throw new Error('内容候选已有个人记录，拒绝覆盖');
  const source=new DatabaseSync(path,{readOnly:true});
  try {
   const all=source.prepare("SELECT * FROM documents ORDER BY namespace,key").all() as any[];
   const rows=all.filter(r=>r.namespace==='notes');initializeMigrationRecords(db);
   const report={schema:'yizhi-personal-migration-1',sourceDirectory:root,sourceHash,namespaces:{notes:{total:rows.length,imported:0,deleted:0}},gaps:[] as string[]};
   for(const r of all){const entries=report.namespaces as any;entries[r.namespace]??={total:0,imported:0,deleted:0};if(r.namespace!=='notes')entries[r.namespace].total++;}
   transaction(db,()=>{
    for(const r of all)origin(db,r,JSON.parse(r.value_json));
    for(const row of rows){
     if(row.deleted){report.namespaces.notes.deleted++;continue;}
     const value=JSON.parse(String(row.value_json)),unitId=value.objectId??value.anchor?.objectId;
     const note={id:String(row.key),text:value.text,version:Number(row.revision),createdAt:value.createdAt??null,updatedAt:value.updatedAt??null,
      original:{unitId,fragments:[]},originalVersions:[],current:{unitId,status:'orphan',fragments:[]},
      legacy:{anchor:value.anchor??{},originalAnchor:value.originalAnchor,relocations:value.relocations,revision:Number(row.revision)}};
     db.prepare('INSERT INTO personal_notes VALUES(?,?)').run(note.id,JSON.stringify({note,lineage:[]}));report.namespaces.notes.imported++;
     report.gaps.push(`${note.id}：旧对象锚点缺少可核对的精确选区，保留原语境待重新关联`);
    }
    const metadata=source.prepare('SELECT * FROM course_metadata').get()!;
    const generation=Math.max(Number(metadata.generation),Number(db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value));
    db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(String(generation));
    const seq=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='save_events'").get(),cursor=Math.max(Number(metadata.sequence),Number(seq?.seq??0));
    if(seq)db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='save_events'").run(cursor);else db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('save_events',?)").run(cursor);
    const saveBarrier=legacySaveBarrier(root,manifest.courseId,Number(metadata.generation),Number(metadata.sequence));if(!saveBarrier?.validForVersion)report.gaps.push('此停止副本没有覆盖当前版本的旧窗口保存屏障证明；仅迁入实际已持久内容，未确认尾部不宣称已找回');
    Object.assign(report,{saveBarrier,sourceGeneration:Number(metadata.generation),sourceSequence:Number(metadata.sequence),generation,cursor,retention:{days:140,origin:'new-default',gap:'旧版没有课程保留期限设置协议，采用新版默认140天，不冒充旧设置'}});
    migrateNativeState(db,all,report);migrateAgent(db,all,report);importRecordHistory(db,source,report);
    for(const [ns,counts] of Object.entries(report.namespaces) as Array<[string,any]>){counts.origins=all.filter(r=>r.namespace===ns).length;counts.deleted=all.filter(r=>r.namespace===ns&&r.deleted).length;counts.mapping=counts.imported?'native-and-origin':ns==='knowledge'?'T24-current-content-and-origin-digest':'current-origin';}
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_pending'").get())for(const row of db.prepare("SELECT id,payload FROM migration_pending WHERE state='unresolved'").all()){const v=JSON.parse(String(row.payload)),id=v.operationId??v.draft?.operationId;if(id&&source.prepare('SELECT 1 FROM operations WHERE operation_id=?').get(id))db.prepare("UPDATE migration_pending SET state='confirmed' WHERE id=?").run(row.id!);}
    db.prepare("INSERT INTO metadata VALUES('personal-migration',?)").run(JSON.stringify(report));
   });return report;
  }finally{source.close();}
}
