import type { DatabaseSync } from 'node:sqlite';
import type { LegacyRow } from './migration-state';
import { createHash } from 'node:crypto';
const list=(v:any):any[]=>Array.isArray(v)?v:Object.entries(v??{}).map(([key,value])=>({key,...(value&&typeof value==='object'?value:{value})}));
const json=JSON.stringify,parse=(r:LegacyRow)=>JSON.parse(r.value_json),hash=(v:unknown)=>createHash('sha256').update(json(v)).digest('hex');
export function migrateAgent(db:DatabaseSync,rows:LegacyRow[],report:any){
 db.exec(`CREATE TABLE IF NOT EXISTS agent_unthreaded_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES agent_conversations(id),payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migration_pending(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,record_key TEXT NOT NULL,purpose TEXT NOT NULL,state TEXT NOT NULL,payload TEXT,created_at TEXT);`);
 const active=rows.filter(r=>!r.deleted),conversations=active.filter(r=>r.namespace==='conversations'),tasks=active.filter(r=>r.namespace==='tasks');
 const currentGeneration=Number(db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value);
 const ui=active.find(r=>r.namespace==='agent_ui'&&r.key==='default'),u=ui?parse(ui):{};
 const units=new Map(db.prepare('SELECT id,payload,revision FROM units').all().map(r=>[String(r.id),{unit:JSON.parse(String(r.payload)),revision:Number(r.revision)}]));
 for(const r of conversations){const v=parse(r);db.prepare('INSERT INTO agent_conversations(id,title,updated_at,draft,draft_context) VALUES(?,?,?,?,?)').run(r.key,v.title??'',v.updatedAt??'',v.draft??'',json({legacy:{createdAt:v.createdAt??null,revision:r.revision}}));report.namespaces.conversations.imported++;}
 for(const r of tasks){const v=parse(r);if(!db.prepare('SELECT 1 FROM agent_conversations WHERE id=?').get(v.conversationId)){report.gaps.push(`${r.key}：原任务的对话不存在，执行事实保留只读，未创建虚假对话`);continue;}
  const unitId=v.target?.objectId??v.target?.unitId,known=units.get(unitId),attemptId=`legacy:${r.key}:${v.generation}:${v.attempt}`;
  const finished=['completed','stopped','failed','interrupted'].includes(v.status),status=finished?v.status:'unknown';
  const intent=v.requestKind==='ask'?'question':v.requestKind==='edit'||v.requestKind==='update_sources'?'modify':'question';
  const task={id:r.key,operationId:v.requestId,conversationId:v.conversationId,attemptId,generation:v.generation??currentGeneration,status,threadId:v.executor?.threadId??null,turnId:v.executor?.turnId??null,model:v.model??v.executor?.model??null,error:v.error??null,createdAt:v.createdAt??null,cursor:0,
   snapshot:{intent,text:v.instruction??'',target:{unitId,unitName:v.submittedEntity?.name??known?.unit.name??unitId,revision:String(v.target?.revision??v.submittedEntity?.reading?.revision??'unknown'),...(v.target?.blockId?{blockId:v.target.blockId}:{}),...(v.target?.text?{selectedText:v.target.text}:{})},citations:[]},
   executorStatus:status==='unknown'?'unknown':status==='completed'?'completed':status==='failed'?'failed':'interrupted',
   ...(status==='unknown'?{recovery:{state:'unknown',checkedAt:new Date().toISOString(),detail:'旧执行连接未跨设备恢复；原执行事实和收据已保留，需核对后明确继续'}}:{}),
   legacy:{requestHash:v.requestHash,requestKind:v.requestKind,attempt:v.attempt,revision:r.revision,startedAt:v.startedAt??null,completedAt:v.completedAt??null,updatedAt:v.updatedAt??null,executor:v.executor??{},executions:v.executions??[],operationIds:v.operationIds??[],concurrentEdits:list(v.concurrentEdits).map((x:any)=>({operationId:x.operationId,objectId:x.objectId,revision:x.revision})),reads:list(v.reads).map((x:any)=>({key:x.key,objectId:x.objectId,id:x.id,revision:x.revision,hash:x.hash,versionId:x.versionId,operationId:x.operationId})),submittedEntityHash:v.submittedEntity?hash(v.submittedEntity):null,startEntityHash:v.startEntity?hash(v.startEntity):null,sourceSelection:v.sourceSelection??null,lastSummary:v.lastSummary??null,unresolvedConflicts:v.unresolvedConflicts??[]}};
  db.prepare("INSERT INTO cg_attempts VALUES(?,?,?,'stopped')").run(attemptId,r.key,v.generation??currentGeneration);
  db.prepare('INSERT INTO agent_tasks VALUES(?,?,?,?)').run(r.key,v.conversationId,attemptId,json(task));report.namespaces.tasks.imported++;
  for(const key of ['pendingRequest','previousPendingRequest'])if(v[key])db.prepare("INSERT INTO migration_pending VALUES(?,?,?,'legacy-task-request','unresolved',?,?)").run(r.key+':'+key,'tasks',r.key,json(v[key]),v.updatedAt??null);
  if(!finished)report.gaps.push(`${r.key}：旧状态${v.status}不等于新运行资格，保留为未知且不自动重跑`);
 }
 for(const r of conversations){const v=parse(r);for(const [ordinal,m] of (v.messages??[]).entries()){
  const task=m.taskId&&db.prepare('SELECT 1 FROM agent_tasks WHERE id=?').get(m.taskId),message={id:m.messageId,taskId:task?m.taskId:null,role:m.role,text:m.text??'',state:m.pending?'partial':'complete',itemId:null,legacy:{ordinal,createdAt:m.createdAt??null,target:m.target??null,sourceSelection:m.sourceSelection??null,operationIds:m.operationIds??[]}};
  if(task)db.prepare('INSERT INTO agent_messages VALUES(?,?,?)').run(m.messageId,m.taskId,json(message));
  else db.prepare('INSERT INTO agent_unthreaded_messages VALUES(?,?,?)').run(m.messageId,r.key,json(message));
 }}
 if(u.conversationId&&db.prepare('SELECT 1 FROM agent_conversations WHERE id=?').get(u.conversationId))db.prepare('INSERT OR REPLACE INTO agent_context VALUES(1,?)').run(u.conversationId);
 for(const r of active.filter(r=>r.namespace==='editingDrafts')){const v=parse(r);if(v.cleared)continue;
  if(v.type==='agent'&&v.conversationId&&db.prepare('SELECT 1 FROM agent_conversations WHERE id=?').get(v.conversationId)){
   const intent=u.intent==='edit'?'modify':'question',context={intent,...(u.selection?.objectId?{target:{unitId:u.selection.objectId,...(u.selection.blockId?{blockId:u.selection.blockId}:{})}}:{}),citationIds:[],legacy:{sourceSelection:u.sourceSelection??null,draftRevision:r.revision}};
   db.prepare('UPDATE agent_conversations SET draft=?,draft_context=? WHERE id=?').run(v.text??'',json(context),v.conversationId);
  }else{db.prepare("INSERT INTO migration_pending VALUES(?,?,?,'legacy-draft','unresolved',?,NULL)").run(r.key,r.namespace,r.key,json(v));report.gaps.push(`${r.key}：旧草稿缺少新版会话/输入基线，保留原身份与内容供核对，不自动晋升正文`);}
  report.namespaces.editingDrafts.imported++;
 }
}
