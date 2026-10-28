import type { DatabaseSync } from 'node:sqlite';
import { readdirSync,lstatSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { declaredResourceRoots as enumerateDeclared } from './resource-roots';
import type { BackupResource } from '../backup-api';
type RootCheck=(db:DatabaseSync,sha256:string)=>boolean;
const extraRoots=new Map<string,RootCheck>();
const extraEnumerators=new Map<string,(db:DatabaseSync)=>BackupResource[]>();
/** Trusted producer modules register actual roots here; never an IPC/evaluation surface. */
export function registerRetentionResourceRoot(name:string,check:RootCheck,enumerate?:(db:DatabaseSync)=>BackupResource[]){extraRoots.set(name,check);if(enumerate)extraEnumerators.set(name,enumerate);}
/** Same trusted producer registry, with enumeration for backup instead of on-disk membership queries. */
export function declaredResourceRoots(db:DatabaseSync){
 for(const name of extraRoots.keys())if(!extraEnumerators.has(name))throw new Error('可信资源根尚无备份声明枚举器: '+name);
 const refs=enumerateDeclared(db);
 for(const [name,enumerate] of extraEnumerators)for(const ref of enumerate(db)){
  const old=refs.find(r=>r.sha256===ref.sha256);
  if(old){if(old.byteLength!==null&&ref.byteLength!==null&&old.byteLength!==ref.byteLength)throw new Error('资源根长度冲突: '+name);if(old.byteLength===null)old.byteLength=ref.byteLength;old.declaredBy.push(name);}
  else refs.push({...ref,declaredBy:[...ref.declaredBy,name]});
 }
 return refs.sort((a,b)=>a.sha256.localeCompare(b.sha256));
}
const roots=[['source_versions','payload'],['parse_artifacts','payload'],['exchange_resources','payload'],['extension_packages','manifest'],
 ['units','payload'],['personal_notes','value'],['personal_drawings','value'],['drafts','input'],['annotation_versions','block'],
 ['builtin_experiments','payload'],['builtin_formal_definitions','payload'],['extension_scene','payload'],['cg_history','payload'],
 ['operations','before_text'],['operations','after_text'],['history_boundary','value'],['agent_tool_recovery','input'],['agent_tool_recovery','output'],['agent_executor_receipts','payload'],
 ['cg_bases','read_values'],['cg_bases','domain_basis'],['cg_candidates','command'],['agent_tasks','payload']] as const;
export class RetentionResources {
 constructor(private db:DatabaseSync,private directory:string){
  db.exec(`CREATE TABLE IF NOT EXISTS retention_resource_leases(id TEXT PRIMARY KEY,purpose TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,released_at TEXT);`);
 }
 leases(){return this.db.prepare('SELECT * FROM retention_resource_leases ORDER BY created_at,id').all().map(r=>({id:String(r.id),purpose:String(r.purpose),state:r.state as 'active'|'released',createdAt:String(r.created_at),releasedAt:r.released_at as string|null}));}
 lease(id:string,action:'acquire'|'release',now:string){
  if(typeof id!=='string'||!id.length||id.length>160||!['acquire','release'].includes(action))throw new Error('资源保留 lease 身份无效');
  const old=this.db.prepare('SELECT * FROM retention_resource_leases WHERE id=?').get(id);
  if(action==='acquire'){
   if(old?.state==='released')throw new Error('此备份 lease 已释放；新备份必须使用新身份');
   if(!old)this.db.prepare("INSERT INTO retention_resource_leases VALUES(?,'backup','active',?,NULL)").run(id,now);
  }else{
   if(!old)throw new Error('资源保留 lease 不存在');
   this.db.prepare("UPDATE retention_resource_leases SET state='released',released_at=coalesce(released_at,?) WHERE id=?").run(now,id);
  }
  return this.leases().find(l=>l.id===id)!;
 }
 private live(hash:string){
  for(const [table,column] of roots)if(this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} LIKE ? LIMIT 1`).get('%'+hash+'%'))return true;
  if(this.db.prepare("SELECT 1 FROM cg_objects WHERE coalesce(json_extract(value,'$.retired'),0)=0 AND value LIKE ? LIMIT 1").get('%'+hash+'%'))return true;
  if(this.db.prepare("SELECT 1 FROM metadata WHERE key IN ('course-graph','relation-catalog') AND value LIKE ? LIMIT 1").get('%'+hash+'%'))return true;
  const legacy=this.db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
  if(legacy&&JSON.parse(String(legacy.value)).report.resources.some((r:any)=>r.sha256===hash))return true;
  for(const check of extraRoots.values())if(check(this.db,hash))return true;
  return false;
 }
 run(limit:number,cutoff:string){
  if(this.db.prepare("SELECT 1 FROM retention_resource_leases WHERE state='active' LIMIT 1").get())return {phase:'resources-pinned',pending:false,removed:0};
  // A parser publishes immutable bytes before Core registers its ArtifactRef.
  if(this.db.prepare("SELECT 1 FROM parse_tasks WHERE json_extract(payload,'$.status')='running' LIMIT 1").get())return {phase:'resources-pinned',pending:false,removed:0};
  const folder=join(this.directory,'resources');if(!existsSync(folder))return {phase:'idle',pending:false,removed:0};
  const cursor=String(this.db.prepare("SELECT value FROM metadata WHERE key='retention-resource-cursor'").get()?.value??'');
  const files=readdirSync(folder).filter(name=>/^[a-f0-9]{64}$/.test(name)&&name>cursor).sort().slice(0,limit);
  if(!files.length){this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-resource-cursor','')").run();return {phase:'idle',pending:false,removed:0};}
  let removed=0;
  for(const file of files){const path=join(folder,file),stat=lstatSync(path);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.mtime.toISOString()<cutoff&&!this.live(file)){unlinkSync(path);removed++;}}
  this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-resource-cursor',?)").run(files.at(-1)!);
  return {phase:'resources',pending:true,removed};
 }
}
