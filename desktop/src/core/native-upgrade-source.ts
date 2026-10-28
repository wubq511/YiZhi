import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** A short read snapshot includes committed WAL state and every persistent domain.
 * Session/lease ownership and rebuildable search projections do not change the source version.
 */
export function nativeSourceVersion(directory:string){
 const db=new DatabaseSync(join(directory,'course.sqlite'),{readOnly:true}),hash=createHash('sha256');db.exec('BEGIN');
 try{
  const excluded=new Set(['course_sessions','learning_views','retention_resource_leases','backup_jobs']);
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().filter(r=>!excluded.has(String(r.name))&&!/^search_|^fts_/i.test(String(r.name)));
  for(const row of tables){
   const name=String(row.name),quoted='"'+name.replaceAll('"','""')+'"';
   const rows=db.prepare(`SELECT * FROM ${quoted}`).all().filter(r=>name!=='metadata'||!['history-clock-override','retention-last-error','retention-resource-cursor'].includes(String(r.key)));
   hash.update(name+'\0'+row.sql+'\0');for(const value of rows.map(r=>JSON.stringify(r,(_k,v)=>typeof v==='bigint'?String(v):v)).sort())hash.update(value+'\n');
  }
  const meta=(key:string)=>db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
  const courseFormat=Number(db.prepare('PRAGMA user_version').get()!.user_version);hash.update('courseFormat:'+courseFormat);
  return {courseId:String(meta('courseId')),generation:Number(meta('generation')),sequence:Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='save_events'").get()?.seq??0),courseFormat,dataDigest:hash.digest('hex')};
 }finally{db.close();}
}
