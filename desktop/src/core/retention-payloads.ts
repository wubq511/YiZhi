import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './save-store';
import { equal } from '../editor-api';
const parse=(v:unknown)=>JSON.parse(String(v));
const targets=[
 ['cg_objects','id'],
 ['cg_bases','id'],['cg_candidates','id'],['agent_tool_recovery','id'],['agent_executor_receipts','json_array(attempt_id,event_id)'],
 ['annotation_operations','id'],['annotation_versions','json_array(block_id,version)'],['annotation_steps','CAST(seq AS TEXT)'],
 ['drawing_operations','id'],['drawing_history','CAST(seq AS TEXT)'],['builtin_experiment_operations','id'],
 ['builtin_definition_history','json_array(instance_id,revision)'],['extension_operations','id'],['restore_timeline','CAST(seq AS TEXT)'],
] as const;
/** Bounded purpose/age sweep. Current and registered objects are independent roots. */
export class RetentionPayloads {
 constructor(private db:DatabaseSync,private protectedInput:(blockId:string)=>boolean){
  db.exec(`CREATE TABLE IF NOT EXISTS retention_payloads(domain TEXT NOT NULL,record_key TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(domain,record_key));
   CREATE TABLE IF NOT EXISTS expired_payloads(domain TEXT NOT NULL,record_key TEXT NOT NULL,operation_id TEXT,PRIMARY KEY(domain,record_key));
   CREATE INDEX IF NOT EXISTS expired_payload_operation ON expired_payloads(operation_id);`);
 }
 install(){
  const stamp="coalesce((SELECT value FROM metadata WHERE key='history-clock-override'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  for(const [table,key] of targets)if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)){
   const expression=key.replace(/\b(id|attempt_id|event_id|block_id|version|seq|instance_id|revision)\b/g,'NEW.$1');
   this.db.exec(`DROP TRIGGER IF EXISTS retention_track_${table};CREATE TRIGGER retention_track_${table} AFTER INSERT ON ${table} BEGIN INSERT INTO retention_payloads VALUES('${table}',${expression},${stamp}) ON CONFLICT(domain,record_key) DO UPDATE SET created_at=excluded.created_at; END;`);
   if(table==='cg_objects')this.db.exec(`DROP TRIGGER IF EXISTS retention_update_cg_objects;CREATE TRIGGER retention_update_cg_objects AFTER UPDATE OF value ON cg_objects BEGIN INSERT INTO retention_payloads VALUES('cg_objects',NEW.id,${stamp}) ON CONFLICT(domain,record_key) DO UPDATE SET created_at=excluded.created_at; END;`);
  }
 }
 private active(attemptId:string){
  const attempt=this.db.prepare('SELECT * FROM cg_attempts WHERE id=?').get(attemptId);
  if(!attempt)return false;
  const generation=Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value);
  if(Number(attempt.generation)!==generation)return false;
  const row=this.db.prepare('SELECT payload FROM agent_tasks WHERE attempt_id=?').get(attemptId);
  if(!row)return attempt.status==='running';
  const task=parse(row.payload);
  return ['running','queued','waiting'].includes(task.status)||['stopping','unknown'].includes(task.status)&&(!task.executorStatus||task.executorStatus==='unknown'||task.recovery?.state==='active');
 }
 private versionRoot(row:Record<string,any>){
  const version=String(row.version),block=parse(row.block);
  if(this.protectedInput(String(row.block_id)))return true;
  if(this.db.prepare("SELECT 1 FROM annotation_heads WHERE json_extract(value,'$.version')=?").get(version))return true;
  for(const r of this.db.prepare('SELECT value FROM personal_notes').all()){
   const note=parse(r.value).note;
   if(note.originalVersions.includes(version)||note.current.fragments.some((f:any)=>f.version===version))return true;
  }
  for(const r of this.db.prepare('SELECT input FROM drafts').all()){
   const input=parse(r.input);if((input.unitId??'KU-001')!==row.unit_id)continue;
   const basis=this.db.prepare('SELECT version FROM annotation_versions WHERE block_id=? AND revision<=? ORDER BY revision DESC LIMIT 1').get(row.block_id,input.baseRevision);
   if(basis?.version===version)return true;
  }
  const refs=this.db.prepare('SELECT operation_id FROM history_object_refs WHERE object_id=? AND operation_id NOT IN(SELECT operation_id FROM history_expired)').all(row.block_id);
  for(const ref of refs){
   const student=this.db.prepare('SELECT before_text,after_text FROM operations WHERE id=?').get(ref.operation_id!);
   const group=this.db.prepare('SELECT payload FROM cg_history WHERE operation_id=?').get(ref.operation_id!);
   const contains=(v:any):boolean=>!!v&&typeof v==='object'&&(v.id===block.id&&equal(v.payload,block.payload)||Object.values(v).some(x=>x&&typeof x==='object'&&(Array.isArray(x)?x.some(contains):contains(x))));
   if(student&&(contains(parse(student.before_text))||contains(parse(student.after_text)))||group&&contains(parse(group.payload)))return true;
  }
  return false;
 }
 private crop(table:string,key:string,row:Record<string,any>):boolean {
  if(table==='cg_objects'){
   const value=parse(row.value);
   // Checked unit/graph lifecycle tombstones are already minimal. Preserve null
   // and the monotonic version: cleanup must not look like a formal resurrection.
   if(value===null)return true;
   if(!value.retired)return false;
   this.db.prepare('UPDATE cg_objects SET value=? WHERE id=?').run(JSON.stringify({id:row.id,retired:true}),row.id);return true;
  }
  if(table==='cg_bases'){
   if(this.active(String(row.attempt_id)))return false;
   this.db.prepare("UPDATE cg_bases SET read_values='[]',domain_basis=NULL WHERE id=?").run(row.id);return true;
  }
  if(table==='cg_candidates'){
   const result=parse(row.result);
   if(result.status==='retained'&&!this.db.prepare('SELECT 1 FROM cg_resolved WHERE candidate_id=?').get(row.id))return false;
   if(this.db.prepare('SELECT 1 FROM cg_history WHERE operation_id=?').get(row.id))return false;
   this.db.prepare("UPDATE cg_candidates SET command='{}' WHERE id=?").run(row.id);return true;
  }
  if(table==='agent_tool_recovery'){
   if(this.active(String(row.attempt_id)))return false;
   this.db.prepare("UPDATE agent_tool_recovery SET input=NULL,output=NULL,purpose='result-fact' WHERE id=?").run(row.id);return true;
  }
  if(table==='agent_executor_receipts'){
   if(!row.applied||this.active(String(row.attempt_id)))return false;
   this.db.prepare("UPDATE agent_executor_receipts SET payload=NULL,purpose='result-fact' WHERE attempt_id=? AND event_id=?").run(row.attempt_id,row.event_id);return true;
  }
  if(table==='annotation_versions'){
   if(this.versionRoot(row))return false;
   this.db.prepare('DELETE FROM annotation_versions WHERE block_id=? AND version=?').run(row.block_id,row.version);return true;
  }
  if(table==='restore_timeline'){
   if(row.kind==='formal')return false;
   const first=this.db.prepare("SELECT min(seq) n FROM restore_timeline WHERE kind='formal'").get()!.n;
   if(first!==null&&Number(row.seq)>=Number(first))return false;
  }
  if(table==='annotation_steps'||table==='drawing_history'||table==='restore_timeline'){
   this.db.prepare(`DELETE FROM ${table} WHERE seq=?`).run(row.seq);return true;
  }
  if(table==='builtin_definition_history'){
   this.db.prepare('DELETE FROM builtin_definition_history WHERE instance_id=? AND revision=?').run(row.instance_id,row.revision);return true;
  }
  const column=table==='annotation_operations'||table==='drawing_operations'?'result':'receipt';
  this.db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(JSON.stringify({operationId:row.id,status:'expired',digest:row.digest}),row.id);
  this.db.prepare('INSERT OR REPLACE INTO expired_payloads VALUES(?,?,?)').run(table,key,row.id);
  return true;
 }
 run(limit:number,cutoff:string,now:string){
  // Legacy rows lacking timestamps are registered once at first maintenance, conservatively.
  for(const [table,key] of targets){
   const missing=this.db.prepare(`SELECT ${key} AS record_key FROM ${table} WHERE ${key} NOT IN(SELECT record_key FROM retention_payloads WHERE domain=?) LIMIT ?`).all(table,limit);
   if(missing.length){transaction(this.db,()=>{for(const row of missing)this.db.prepare('INSERT OR IGNORE INTO retention_payloads VALUES(?,?,?)').run(table,row.record_key!,now);});return {pending:true,removed:0,phase:'payload-index'};}
  }
  const cursor=Number(this.db.prepare("SELECT value FROM metadata WHERE key='retention-payload-cursor'").get()?.value??0);
  const rows=this.db.prepare('SELECT rowid,domain,record_key FROM retention_payloads WHERE created_at<? AND rowid>? ORDER BY rowid LIMIT ?').all(cutoff,cursor,limit);
  if(!rows.length){this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-payload-cursor','0')").run();return {pending:false,removed:0,phase:'idle'};}
  let removed=0;
  transaction(this.db,()=>{
   for(const item of rows){
    const target=targets.find(t=>t[0]===item.domain)!;
    const row=this.db.prepare(`SELECT * FROM ${target[0]} WHERE ${target[1]}=?`).get(item.record_key!);
    if(!row||this.crop(target[0],String(item.record_key),row)){
     removed++;this.db.prepare('DELETE FROM retention_payloads WHERE domain=? AND record_key=?').run(item.domain!,item.record_key!);
     // Keep a timestamp marker for minimized immutable receipts so they are not re-indexed.
     if(row&&['cg_bases','cg_candidates','agent_tool_recovery','agent_executor_receipts','annotation_operations','drawing_operations','builtin_experiment_operations','extension_operations'].includes(target[0]))this.db.prepare('INSERT OR REPLACE INTO retention_payloads VALUES(?,?,?)').run(item.domain!,item.record_key!,'9999-12-31T00:00:00.000Z');
    }
   }
   this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-payload-cursor',?)").run(String(rows.at(-1)!.rowid));
  });
  return {pending:true,removed,phase:'payloads'};
 }
}
