import type { DatabaseSync } from 'node:sqlite';
import { existsSync,lstatSync,readdirSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from './save-store';
import type { RetentionSpace } from '../retention-api';
export class RetentionStorage {
 constructor(private db:DatabaseSync,private directory:string){}
 private size(table:string,columns:string[]){
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))return {bytes:0,rows:0};
  const r=this.db.prepare(`SELECT coalesce(sum(${columns.map(c=>`coalesce(length(CAST(${c} AS BLOB)),0)`).join('+')}),0) bytes,count(*) rows FROM ${table}`).get()!;
  return {bytes:Number(r.bytes),rows:Number(r.rows)};
 }
 space():RetentionSpace {
  const category=(id:string,label:string,tables:Array<[string,string[]]>)=>{const values=tables.map(([table,columns])=>this.size(table,columns));return {id,label,bytes:values.reduce((n,v)=>n+v.bytes,0),rows:values.reduce((n,v)=>n+v.rows,0),kind:'logical' as const};};
  const categories=[
   category('current','当前正文与课程对象',[['units',['payload']],['cg_objects',['value']]]),
   category('personal','当前个人记录与可见对话',[['personal_notes',['value']],['personal_drawings',['value']],['agent_messages',['payload']],['agent_conversations',['draft','draft_context']],['reading_state',['payload']]]),
   category('history','正式历史与窗口边界',[['operations',['before_text','after_text']],['cg_history',['payload']],['history_boundary',['value']],['restore_timeline',['before_value','after_value']],['placement_history',['value']],['drawing_history',['value']],['annotation_steps',['value']],['builtin_definition_history',['before_value','after_value']]]),
   category('recovery','草稿、原语境与任务恢复材料',[['drafts',['input','receipt']],['annotation_versions',['block']],['cg_bases',['read_values','domain_basis']],['cg_candidates',['command']],['agent_tool_recovery',['input','output']],['agent_executor_receipts',['payload']]]),
   category('receipts','操作身份与持久结果',[['operations',['receipt','digest']],['cg_candidates',['result','digest']],['annotation_operations',['result','digest']],['drawing_operations',['result','digest']],['agent_operations',['receipt','digest']]]),
   category('cache','可重建搜索缓存',[['search_documents',['payload']],['search_fts',['text']]]),
  ];
  const resources=join(this.directory,'resources');let resourceBytes=0,resourceCount=0;
  if(existsSync(resources))for(const file of readdirSync(resources)){try{const s=lstatSync(join(resources,file));if(s.isFile()&&!s.isSymbolicLink()){resourceBytes+=s.size;resourceCount++;}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  let databaseBytes=0;for(const suffix of ['', '-wal','-shm']){const path=join(this.directory,'course.sqlite'+suffix);if(existsSync(path))databaseBytes+=lstatSync(path).size;}
  const legacy=this.db.prepare("SELECT coalesce(sum(length(CAST(value AS BLOB))),0) bytes FROM metadata WHERE key='legacy-content'").get()!;
  return {categories:[...categories,{id:'provenance',label:'原课程来源与保留清单',bytes:Number(legacy.bytes),rows:Number(Number(legacy.bytes)>0),kind:'logical'},
   {id:'resources',label:'固定资源文件',bytes:resourceBytes,rows:resourceCount,kind:'files'}],databaseBytes,reusableBytes:Number(this.db.prepare('PRAGMA freelist_count').get()!.freelist_count)*Number(this.db.prepare('PRAGMA page_size').get()!.page_size),notice:'表中为逻辑载荷与资源文件统计；SQLite 文件另计，清理后的空闲页可复用。清缓存只移除可重建索引，不清除正式历史、个人内容或固定来源。'};
 }
 clearCache(limit=32){
  if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new Error('缓存批次必须为1到64条');
  return transaction(this.db,()=>{
   if(!this.db.prepare("SELECT 1 FROM metadata WHERE key='retention-cache-clearing'").get()){
    this.db.prepare('UPDATE search_entities SET dirty=1,epoch=epoch+1,page=0').run();this.db.prepare("INSERT INTO metadata VALUES('retention-cache-clearing','1')").run();
   }
   const rows=this.db.prepare('SELECT id FROM search_documents ORDER BY id LIMIT ?').all(limit);
   for(const r of rows)this.db.prepare('DELETE FROM search_documents WHERE id=?').run(r.id!);
   const pending=!!this.db.prepare('SELECT 1 FROM search_documents LIMIT 1').get();
   if(!pending)this.db.prepare("DELETE FROM metadata WHERE key='retention-cache-clearing'").run();
   return {pending,removed:rows.length};
  });
 }
 staleCache(limit:number){
  const rows=this.db.prepare('SELECT d.id FROM search_documents d JOIN search_entities e ON e.scope=d.scope AND e.id=d.entity_id WHERE e.dirty=1 OR e.epoch<>d.epoch ORDER BY d.id LIMIT ?').all(limit);
  if(rows.length)transaction(this.db,()=>{for(const r of rows)this.db.prepare('DELETE FROM search_documents WHERE id=?').run(r.id!);});
  return {phase:'cache',pending:rows.length>0,removed:rows.length};
 }
}
