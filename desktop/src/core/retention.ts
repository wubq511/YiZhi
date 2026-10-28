import type { DatabaseSync } from 'node:sqlite';
import type { RetentionStatus,RetentionScheduling } from '../retention-api';
import type { FormalHistory } from './formal-history';
import { transaction } from './save-store';
import { equal } from '../editor-api';
import { RetentionPayloads } from './retention-payloads';
import { RetentionResources } from './retention-resources';
import { registerLegacyRetention,cropLegacyContent } from './retention-legacy';
import { RetentionStorage } from './retention-storage';
/** Course-owned policy. History bodies stay in their original formal records. */
export class HistoryRetention {
 private timer?:ReturnType<typeof setTimeout>;private stopped=false;private periodic=false;private queued=false;
 private payloads:RetentionPayloads;
 readonly resources:RetentionResources;
 readonly storage:RetentionStorage;
 constructor(private db:DatabaseSync,private history:FormalHistory,directory:string,protectedInput:(blockId:string)=>boolean,private scheduling?:RetentionScheduling){
  db.prepare("INSERT OR IGNORE INTO metadata VALUES('history-retention-days','140')").run();
  db.prepare("DELETE FROM metadata WHERE key='history-clock-override'").run();this.synchronizeClock();
  this.payloads=new RetentionPayloads(db,protectedInput);
  this.resources=new RetentionResources(db,directory);
  this.storage=new RetentionStorage(db,directory);
  registerLegacyRetention(db,new Date(this.now()).toISOString());
 }
 installPayloadTracking(){this.payloads.install();}
 synchronizeClock(){if(this.scheduling?.clock)this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('history-clock-override',?)").run(new Date(this.now()).toISOString());}
 stop(){this.stopped=true;clearTimeout(this.timer);}
 onActivity(enqueue:(run:()=>void)=>void){
  if(this.scheduling?.manual||this.stopped||this.queued||this.timer&&!this.periodic)return;
  this.arm(enqueue,1000,false);
 }
 private arm(enqueue:(run:()=>void)=>void,delay:number,periodic:boolean){
  clearTimeout(this.timer);this.periodic=periodic;
  this.timer=setTimeout(()=>{this.timer=undefined;this.queued=true;enqueue(()=>{
   this.queued=false;if(this.stopped)return;
   let pending=false;try{const result=this.run();pending=result.pending;}catch(error){try{this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-last-error',?)").run((error as Error).message);}catch{/* Preserve the original storage outcome; a later idle opportunity can retry. */}}
   this.arm(enqueue,pending?0:60_000,!pending);
  });},delay);this.timer.unref();
 }
 private now(){return this.scheduling?.clock?Number(Atomics.load(new BigInt64Array(this.scheduling.clock),0)):Date.now();}
 private boundary(buffer?:SharedArrayBuffer){if(buffer){const flag=new Int32Array(buffer);Atomics.store(flag,0,1);Atomics.notify(flag,0);Atomics.wait(flag,0,1);}}
 private recoveryPinned(row:Record<string,any>){
  const generation=Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value);
  for(const request of this.db.prepare('SELECT scope FROM course_restore_requests r WHERE generation=? AND NOT EXISTS(SELECT 1 FROM cg_candidates c WHERE c.id=r.id)').all(generation)){
   if(!request.scope)return true;
   const scope=JSON.parse(String(request.scope)),anchor=this.db.prepare('SELECT seq FROM history_index WHERE operation_id=?').get(scope.atOperationId);
   if(!anchor)return true;
   if(Number(row.seq)>=Number(anchor.seq)&&JSON.parse(String(row.unit_ids)).some((id:string)=>scope.unitIds.includes(id)))return true;
  }return false;
 }
 get():RetentionStatus {
  const days=Number(this.db.prepare("SELECT value FROM metadata WHERE key='history-retention-days'").get()!.value);
  const cutoff=new Date(Math.max(-8.64e15,this.now()-days*86_400_000)).toISOString();
  return {days,cutoff,blocked:String(this.db.prepare("SELECT value FROM metadata WHERE key='retention-last-error'").get()?.value??'')||undefined,removedBefore:this.db.prepare("SELECT value FROM metadata WHERE key='history-retention-boundary'").get()?.value as string??null,oldestAvailable:this.db.prepare('SELECT min(committed_at) AS time FROM history_index WHERE operation_id NOT IN(SELECT operation_id FROM history_expired)').get()?.time as string|null,
   pendingGroups:Number(this.db.prepare('SELECT count(*) AS n FROM history_index WHERE committed_at<? AND operation_id NOT IN(SELECT operation_id FROM history_expired)').get(cutoff)!.n),notice:'调大期限只影响今后保留，不能找回已清理的明细。独立备份单独管理。'};
 }
 set(days:number){
  if(!Number.isSafeInteger(days)||days<1)throw new Error('历史保留天数必须为正整数');
  this.db.prepare("UPDATE metadata SET value=? WHERE key='history-retention-days'").run(String(days));return this.get();
 }
 run(limit=16):{pending:boolean;removed:number;phase:string;blocked?:string} {
  const result=this.batch(limit);this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-last-phase',?)").run(result.phase);this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('retention-last-error',?)").run(result.blocked??'');return result;
 }
 private crop(id:string,source:string){
  if(source==='student')this.db.prepare("UPDATE operations SET before_text='[]',after_text='{}' WHERE id=?").run(id);
  else if(source==='group'){this.db.prepare('DELETE FROM cg_history WHERE operation_id=?').run(id);this.db.prepare("UPDATE cg_candidates SET command='{}' WHERE id=?").run(id);}
  else this.db.prepare("DELETE FROM placement_history WHERE json_extract(value,'$.operationId')=?").run(id);
 }
 private batch(limit:number):{pending:boolean;removed:number;phase:string;blocked?:string} {
  if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new Error('清理批次必须为1到64个完整组');
  const indexed=Number(this.db.prepare("SELECT value FROM metadata WHERE key='history-retention-indexed'").get()?.value??0);
  const prepare=this.db.prepare('SELECT * FROM history_index WHERE seq>? ORDER BY seq LIMIT ?').all(indexed,limit);
  if(prepare.length){transaction(this.db,()=>{
   for(const row of prepare){if(!this.db.prepare('SELECT 1 FROM history_expired WHERE operation_id=?').get(row.operation_id!))for(const c of this.history.detail(String(row.operation_id)).changes)this.db.prepare('INSERT OR IGNORE INTO history_object_refs VALUES(?,?,?)').run(row.operation_id!,c.objectId,row.seq!);}
   this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('history-retention-indexed',?)").run(String(prepare.at(-1)!.seq));
  });return {phase:'index',pending:true,removed:0};}
  const status=this.get(),rows=this.db.prepare('SELECT * FROM history_index WHERE committed_at<? AND operation_id NOT IN(SELECT operation_id FROM history_expired) ORDER BY seq LIMIT ?').all(status.cutoff,limit);
  const expired=rows.filter(row=>!this.history.pinned(String(row.operation_id))&&!this.recoveryPinned(row));
  const references=this.db.prepare('SELECT h.* FROM history_index h JOIN history_window_refs w USING(operation_id) WHERE NOT EXISTS(SELECT 1 FROM history_index p WHERE p.seq<h.seq AND p.operation_id NOT IN(SELECT operation_id FROM history_expired)) ORDER BY seq LIMIT ?').all(limit).filter(row=>!this.history.pinned(String(row.operation_id))&&!this.recoveryPinned(row));
  if(references.length){transaction(this.db,()=>{for(const row of references){this.crop(String(row.operation_id),String(row.source));this.db.prepare('DELETE FROM history_window_refs WHERE operation_id=?').run(row.operation_id!);}});return {phase:'window-references',pending:true,removed:references.length};}
  if(rows.length&&!expired.length)return {phase:'blocked',pending:false,removed:0,blocked:'当前历史预览或恢复正在使用此组，先保留其完整依据'};
  if(!expired.length){
   const now=new Date(this.now()).toISOString(),payloads=this.payloads.run(limit,status.cutoff,now);if(payloads.pending)return payloads;
   if(transaction(this.db,()=>cropLegacyContent(this.db,status.cutoff,now)))return {phase:'provenance',pending:true,removed:1};
   const cache=this.storage.staleCache(limit);if(cache.pending)return cache;
   return this.resources.run(limit,status.cutoff);
  }
  const groups=expired.map(row=>this.history.detail(String(row.operation_id)));
  for(const group of groups)for(const c of group.changes){
   const later=this.db.prepare('SELECT operation_id FROM history_object_refs WHERE object_id=? AND seq>? AND (operation_id NOT IN(SELECT operation_id FROM history_expired) OR operation_id IN(SELECT operation_id FROM history_window_refs)) ORDER BY seq LIMIT 1').get(c.objectId,Number(group.order));
   const next=later?this.history.detail(String(later.operation_id),true).changes.find(n=>n.objectId===c.objectId):undefined;
   const current=this.history.currentObject(c.objectId),value=next?next.before:current.value,version=next?next.beforeVersion:current.version;
   const canonical=(v:any)=>v?.retired?null:v;
   if(c.afterVersion<1||version!==c.afterVersion||!equal(canonical(value),canonical(c.after)))return {phase:'blocked',pending:false,removed:0,blocked:`窗口边界不能核对：${c.objectId}；原明细保留`};
  }
  transaction(this.db,()=>{
   for(const group of groups){
    for(const c of group.changes)this.db.prepare('INSERT INTO history_boundary VALUES(?,?,?,?) ON CONFLICT(object_id) DO UPDATE SET value=excluded.value,version=excluded.version,operation_id=excluded.operation_id WHERE (SELECT seq FROM history_index WHERE operation_id=excluded.operation_id)>(SELECT seq FROM history_index WHERE operation_id=history_boundary.operation_id)').run(c.objectId,JSON.stringify(c.after?.retired?null:c.after),c.afterVersion,group.operationId);
    this.db.prepare('INSERT INTO history_expired VALUES(?,?,?,?)').run(group.operationId,group.source,group.committedAt,group.taskId??null);
    // Keep only original records still needed to reconstruct an earlier in-window version.
    // This is a bounded reference to existing history, never a parallel snapshot stream.
    if(this.db.prepare('SELECT 1 FROM history_index WHERE seq<? AND operation_id NOT IN(SELECT operation_id FROM history_expired) LIMIT 1').get(Number(group.order)))this.db.prepare('INSERT INTO history_window_refs VALUES(?)').run(group.operationId);
    else this.crop(group.operationId,group.source);
    this.db.prepare('DELETE FROM restore_timeline WHERE reference=?').run(group.operationId);
   }
   this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('history-retention-boundary',?)").run(status.cutoff);
   this.boundary(this.scheduling?.beforeCommit);
  });
  this.boundary(this.scheduling?.afterCommit);
  return {phase:'history',pending:true,removed:groups.length};
 }
}
