import { createHash,randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseGraph } from '../shared';
import type { CourseRestoreSelection,CourseRestorePreview,CourseRestoreResult,PreservedDraft,CourseRestorePermit } from '../course-restore-api';
import type { FormalHistory } from './formal-history';
import type { AgentStore } from './agent-store';
import type { BuiltinExperiments } from './builtin-experiments';
import type { Extensions } from './extensions';
import { transaction,appendEvent,readDrafts } from './save-store';
import { RestoreState } from './restore-state';
const parse=(value:unknown)=>JSON.parse(String(value));
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A checked, atomic course generation change using the existing formal object history. */
export class CourseRestore {
 private state:RestoreState;
 constructor(private db:DatabaseSync,private history:FormalHistory,private graph:CourseGraph,private agent:AgentStore,
  private experiments:BuiltinExperiments,private extensions:Extensions,private publishSession:(sessionId:string)=>void,private scheduling?:import('../course-restore-api').CourseRestoreScheduling) {
  db.exec(`CREATE TABLE IF NOT EXISTS course_sessions(id TEXT PRIMARY KEY,generation INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS course_restore_requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,generation INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS retired_drafts(session_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,restore_operation_id TEXT NOT NULL);`);
  this.state=new RestoreState(db,graph);
 }
 private generation(){return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value);}
 private boundary(buffer?:SharedArrayBuffer){if(buffer){const flag=new Int32Array(buffer);Atomics.store(flag,0,1);Atomics.notify(flag,0);Atomics.wait(flag,0,1);}}
 preview(p:CourseRestoreSelection):CourseRestorePreview {
  if(!p||!['before','after'].includes(p.side)||!Array.isArray(p.unitIds)||!p.unitIds.length||p.unitIds.length>this.graph.nodes.length||new Set(p.unitIds).size!==p.unitIds.length||p.unitIds.some(id=>!this.graph.nodes.some(n=>n.id===id))||typeof p.userState?.layout!=='boolean'||typeof p.userState?.review!=='boolean')throw new Error('整课恢复范围无效');
  const selection={atOperationId:p.atOperationId,side:p.side,unitIds:p.unitIds,userState:p.userState};
  const plan=this.history.courseProjection(p.unitIds,p.atOperationId,p.side,false),drafts=readDrafts(this.db);
  plan.changes.push(...this.state.changes(p,p.unitIds,id=>this.history.currentObject(id)));
  const versions=this.db.prepare('SELECT id,revision FROM units ORDER BY id').all();
  const sourceVersions=new Set<string>();
  const collect=(v:any):void=>{if(!v||typeof v!=='object')return;if(typeof v.versionId==='string')sourceVersions.add(v.versionId);if(typeof v.sourceCitationId==='string'){const r=this.db.prepare('SELECT version_id FROM source_citations WHERE id=?').get(v.sourceCitationId);if(r)sourceVersions.add(String(r.version_id));}for(const x of Object.values(v))if(x&&typeof x==='object')collect(x);};collect(plan.changes);
  return {...selection,generation:this.generation(),affectedUnitIds:plan.unitIds,changes:plan.changes,units:plan.units.map(u=>({id:u.id,name:u.name,blockCount:u.reading.blocks.length})),preservedDrafts:drafts.length,sourceVersions:[...sourceVersions],
   explanations:['这是独立整课历史恢复，产生新课程代际；旧任务必须重新核对后明确继续。',`当前笔记、图形、对话和新导入资料保留；布局${p.userState.layout?'按所选时间恢复':'保留当前值'}，掌握状态${p.userState.review?'按所选时间恢复':'保留当前值'}。`,'恢复前有效草稿单独保留，不自动写回新代际。'],
   token:hash([selection,this.generation(),plan.changes,versions,drafts])};
 }
 query(id:string):CourseRestoreResult|null {const row=this.db.prepare('SELECT result FROM cg_candidates WHERE id=?').get(id);if(!row)return null;const result=parse(row.result);return result.domain==='course-restore'?result:null;}
 drafts():PreservedDraft[]{return this.db.prepare('SELECT d.input,d.receipt,r.generation,r.restore_operation_id FROM drafts d JOIN retired_drafts r ON r.session_id=d.session_id ORDER BY d.rowid').all().map(r=>({input:parse(r.input),receipt:parse(r.receipt),generation:Number(r.generation),restoreOperationId:String(r.restore_operation_id)}));}
 apply(p:{sessionId:string;operationId:string;preview:CourseRestorePermit}):CourseRestoreResult {
  if(typeof p.operationId!=='string'||!p.operationId.length||p.operationId.length>160)throw new Error('整课恢复操作身份无效');
  if(!p.preview||!Number.isSafeInteger(p.preview.generation)||typeof p.preview.token!=='string')throw new Error('整课恢复依据无效');
  const {atOperationId,side,unitIds,userState,token,generation}=p.preview;
  const digest='course-restore:'+hash({atOperationId,side,unitIds,userState,token,generation}),old=this.db.prepare('SELECT digest FROM cg_candidates WHERE id=?').get(p.operationId);
  if(old){if(old.digest!==digest)throw new Error('同一恢复操作不能更换范围或依据');const result=this.query(p.operationId);if(!result)throw new Error('操作身份已用于其他修改');return result;}
  if(this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(p.operationId))throw new Error('操作身份已用于正文修改');
  const requested=this.db.prepare('SELECT digest FROM course_restore_requests WHERE id=?').get(p.operationId);
  if(requested&&requested.digest!==digest)throw new Error('同一恢复操作不能更换范围或依据');
  if(!requested){
   const fresh=this.preview(p.preview);
   if(generation!==fresh.generation||token!==fresh.token)throw new Error('预览后课程或草稿已变化，请重新核对整课范围和代际');
   // Reserve only identity, never content: survives a later rollback or process death.
   this.db.prepare('INSERT INTO course_restore_requests VALUES(?,?,?,?)').run(p.operationId,digest,generation,new Date().toISOString());
  }
  const publications:Array<()=>void>=[];
  const result=transaction(this.db,()=>{
   const fresh=this.preview(p.preview);if(fresh.generation!==generation||fresh.token!==token)throw new Error('预览后课程或草稿已变化，请重新核对整课范围和代际');
   const previousGeneration=this.generation(),nextGeneration=previousGeneration+1,nextSession=randomUUID();
   const revisions=new Map(this.db.prepare('SELECT id,revision FROM units').all().map(r=>[String(r.id),Number(r.revision)]));
   const restored=this.history.restoreInTransaction(fresh.changes,fresh.affectedUnitIds);publications.push(restored.publish);
   // Units without a body difference still receive a new revision in the new course generation.
   for(const id of fresh.affectedUnitIds)if(Number(this.db.prepare('SELECT revision FROM units WHERE id=?').get(id)?.revision)===revisions.get(id))this.db.prepare('UPDATE units SET revision=revision+1 WHERE id=?').run(id);
   for(const row of this.db.prepare('SELECT session_id FROM drafts WHERE session_id NOT IN(SELECT session_id FROM retired_drafts)').all())this.db.prepare('INSERT INTO retired_drafts VALUES(?,?,?)').run(row.session_id!,previousGeneration,p.operationId);
   for(const row of this.db.prepare('SELECT id FROM agent_tasks').all())this.agent.stop({taskId:String(row.id)});
   this.db.prepare("UPDATE cg_attempts SET status='stopped' WHERE status='running'").run();
   this.db.prepare("UPDATE cg_bases SET read_values='[]',domain_basis=NULL").run();
   this.db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(String(nextGeneration));
   this.db.prepare('INSERT INTO course_sessions VALUES(?,?)').run(nextSession,nextGeneration);
   publications.push(this.experiments.fenceGeneration(),this.extensions.fenceGeneration());
   const receipt:CourseRestoreResult={domain:'course-restore',operationId:p.operationId,status:'committed',generation:nextGeneration,sessionId:nextSession,cursor:0,unitIds:fresh.affectedUnitIds,changedObjectIds:restored.changes.map(c=>c.objectId),preservedDrafts:fresh.preservedDrafts};
   receipt.cursor=appendEvent(this.db,{type:'group.committed',operationId:p.operationId,revision:Math.max(1,...this.db.prepare('SELECT revision FROM units').all().map(r=>Number(r.revision))),changedObjectIds:receipt.changedObjectIds});
   this.db.prepare('INSERT INTO cg_candidates VALUES(?,?,?,?)').run(p.operationId,digest,'{}',JSON.stringify(receipt));
   this.db.prepare('INSERT INTO cg_history VALUES(?,?)').run(p.operationId,JSON.stringify({operationId:p.operationId,actor:'student',unitIds:fresh.affectedUnitIds,explanation:'整课所选范围恢复',generation:nextGeneration,revision:Math.max(1,...this.db.prepare('SELECT revision FROM units').all().map(r=>Number(r.revision))),committedAt:new Date().toISOString(),recovery:{kind:'course-restore',atOperationId:fresh.atOperationId,side:fresh.side,userState:fresh.userState,previousGeneration},changes:restored.changes}));
   this.boundary(this.scheduling?.beforeCommit);return receipt;
  });
  this.boundary(this.scheduling?.afterCommit);
  for(const publish of publications)publish();this.publishSession(result.sessionId);return result;
 }
}
