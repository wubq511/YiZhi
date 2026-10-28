import type { DatabaseSync } from 'node:sqlite';
import {unitObjects} from './history-objects';
const json=JSON.stringify;
import { createHash } from 'node:crypto';
const parse=(v:unknown)=>JSON.parse(String(v));
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex');
export function initializeMigrationHistory(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS migration_values(id TEXT PRIMARY KEY,value TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migration_receipts(id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt TEXT NOT NULL,committed_at TEXT,sequence INTEGER NOT NULL,generation INTEGER NOT NULL,expired INTEGER NOT NULL DEFAULT 0);`);
 for(const [name,type] of [['committed_at','TEXT'],['origin','TEXT']] as const)if(!db.prepare('PRAGMA table_info(restore_timeline)').all().some(r=>r.name===name))db.exec(`ALTER TABLE restore_timeline ADD COLUMN ${name} ${type}`);
}
function encode(db:DatabaseSync,value:any,time:string):any {
 const id=digest(value);db.prepare('INSERT OR IGNORE INTO migration_values VALUES(?,?,?)').run(id,JSON.stringify(value),time);return {$value:id};
}
function decode(db:DatabaseSync,value:any):any {
 if(value&&typeof value==='object'&&typeof value.$value==='string'&&Object.keys(value).length===1){const row=db.prepare('SELECT value FROM migration_values WHERE id=?').get(value.$value);if(!row)throw new Error('旧版明细已过期清理，无法恢复原载荷');return parse(row.value);}
 if(Array.isArray(value))return value.map(x=>decode(db,x));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decode(db,v)]));return value;
}
export function importRecordHistory(db:DatabaseSync,source:DatabaseSync,report:any){
 initializeMigrationHistory(db);const events=new Map(source.prepare('SELECT sequence,event_json FROM events').all().map(r=>[Number(r.sequence),parse(r.event_json)]));
 const now=new Date().toISOString(),time=(s:any)=>typeof s==='string'&&Number.isFinite(Date.parse(s))?new Date(Date.parse(s)+(/\.\d{3}[1-9]\d*/.test(s)?1:0)).toISOString():now;
 const backdate=(domain:string,key:string,at:string)=>db.prepare('INSERT INTO retention_payloads VALUES(?,?,?) ON CONFLICT(domain,record_key) DO UPDATE SET created_at=excluded.created_at').run(domain,key,at);
 let total=0;
 for(const r of source.prepare('SELECT * FROM history ORDER BY sequence,ordinal').all()){
  const e=events.get(Number(r.sequence)),at=time(e?.savedAt),origin={sequence:Number(r.sequence),ordinal:Number(r.ordinal),operationId:e?.operationId??null,savedAt:e?.savedAt??null,kind:e?.kind??null};
  const before=parse(r.before_json),after=parse(r.after_json);before.value=encode(db,before.value,at);after.value=encode(db,after.value,at);
  const inserted=db.prepare("INSERT INTO restore_timeline(kind,reference,domain,object_id,before_value,after_value,committed_at,origin) VALUES('legacy',?,?,?,?,?,?,?)").run(e?.operationId??null,r.namespace!,r.key!,JSON.stringify(before),JSON.stringify(after),e?.savedAt??null,JSON.stringify(origin));
  backdate('restore_timeline',String(inserted.lastInsertRowid),at);total++;
 }
 let operations=0;
 for(const r of source.prepare('SELECT * FROM operations ORDER BY rowid').all()){
  const request=parse(r.payload_json),receipt=parse(r.result_json),originalDigest=digest(receipt),at=time(receipt.savedAt);
  const stored={...receipt,changes:(receipt.changes??[]).map((c:any)=>({...c,value:encode(db,c.value,at)}))};
  db.prepare('INSERT INTO migration_receipts VALUES(?,?,?,?,?,?,?,0)').run(r.operation_id!,digest(request),originalDigest,JSON.stringify(stored),receipt.savedAt??null,receipt.sequence,receipt.generation);backdate('migration_receipts',String(r.operation_id),at);operations++;
 }
 for(const r of db.prepare('SELECT id,created_at FROM migration_values').all())backdate('migration_values',String(r.id),String(r.created_at));
 const versions=source.prepare("SELECT 1 FROM sqlite_master WHERE name='content_versions'").get()?source.prepare('SELECT version_id,sequence,generation,label,knowledge_json,personal_json FROM content_versions ORDER BY rowid').all().map(r=>({versionId:r.version_id,sequence:r.sequence,generation:r.generation,label:r.label,knowledgeSha256:digest(parse(r.knowledge_json)),personalSha256:digest(parse(r.personal_json)),committedAt:null,timeGap:'旧checkpoint未记录时间；不以相邻事件时间冒充'})):[];
 db.prepare("INSERT INTO metadata VALUES('legacy-checkpoint-facts',?)").run(JSON.stringify(versions));report.history={entries:total,operations,checkpointFacts:versions.length,fullCheckpointCopies:0};
 indexLegacyBodies(db,events,report);
 if(versions.length)report.gaps.push(`${versions.length}份旧checkpoint只保留身份/摘要/原顺序；其逐对象实际历史已转换，checkpoint缺失原时间明确为null，未隐藏保存51份课程全文`);
}
export function migratedHistory(db:DatabaseSync,p:{namespace?:string;key?:string;before?:number;limit?:number}){
 const limit=p.limit??30;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('旧版历史分页无效');
 const rows=db.prepare("SELECT * FROM restore_timeline WHERE kind='legacy' AND (? IS NULL OR domain=?) AND (? IS NULL OR object_id=?) AND seq<? ORDER BY seq DESC LIMIT ?").all(p.namespace??null,p.namespace??null,p.key??null,p.key??null,p.before??Number.MAX_SAFE_INTEGER,limit+1);
 return {entries:rows.slice(0,limit).map(r=>({id:Number(r.seq),namespace:r.domain,key:r.object_id,before:decode(db,parse(r.before_value)),after:decode(db,parse(r.after_value)),restoreSupport:db.prepare("SELECT 1 FROM history_index WHERE source='legacy' AND operation_id=?").get(r.reference)?'formal-history':'read-only: legacy group lacks a complete checked inverse',...parse(r.origin)})),...(rows.length>limit?{next:Number(rows[limit-1].seq)}:{})};
}
export function migratedOperation(db:DatabaseSync,id:string){
 const r=db.prepare('SELECT * FROM migration_receipts WHERE id=?').get(id);if(!r)return null;
 return {operationId:id,requestDigest:r.request_digest,receiptDigest:r.receipt_digest,expired:!!r.expired,receipt:r.expired?null:decode(db,parse(r.receipt)),savedAt:r.committed_at,sequence:Number(r.sequence),generation:Number(r.generation)};
}

/** Old full entities are read from the one retained value pool, not copied to a second history. */
export function legacyBodyGroup(db:DatabaseSync,operationId:string){
 const rows=db.prepare("SELECT * FROM restore_timeline WHERE kind='legacy' AND reference=? ORDER BY seq").all(operationId);
 if(!rows.length)throw new Error('旧版一致组明细已过期或不存在');
 const changes:import('../history-api').HistoryChange[]=[],unitIds:string[]=[];
 for(const row of rows){
  const before=decode(db,parse(row.before_value)),after=decode(db,parse(row.after_value));
  if(row.domain!=='knowledge'||!String(row.object_id).startsWith('KU-')||before.deleted||after.deleted||!before.value?.reading?.blocks||!after.value?.reading?.blocks)throw new Error('旧版一致组缺少完整正文或包含尚无可核对逆操作的对象；整个组只读保留');
  const a=before.value,b=after.value;
  const metadata=(v:any)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!=='reading'&&k!=='theme'));
  if(canonical(metadata(a))!==canonical(metadata(b)))throw new Error('旧版一致组同时改变单元元数据，尚无完整逆操作；整个组只读保留');
  const aa=unitObjects(a),bb=unitObjects(b);unitIds.push(String(row.object_id));
  for(const id of new Set([...aa.keys(),...bb.keys()])){const previous=aa.get(id)??null,next=bb.get(id)??null;if(canonical(previous)!==canonical(next))changes.push({objectId:id,before:previous,after:next,beforeVersion:0,afterVersion:0});}
 }
 return {changes,unitIds:[...new Set(unitIds)]};
}
function indexLegacyBodies(db:DatabaseSync,events:Map<number,any>,report:any){
 const supported:Array<{id:string;event:any;changes:import('../history-api').HistoryChange[];unitIds:string[]}>=[];let unsupported=0;
 for(const [sequence,event] of events){if(!db.prepare("SELECT 1 FROM restore_timeline WHERE kind='legacy' AND reference=? AND domain='knowledge'").get(event.operationId))continue;
  try{if(!event.savedAt||!Number.isFinite(Date.parse(event.savedAt)))throw new Error('旧版没有原提交时间');const group=legacyBodyGroup(db,event.operationId);if(group.changes.length)supported.push({id:event.operationId,event,...group});}
  catch{unsupported++;}
 }
 if(supported.length){
  // The copied candidate can already contain T30 formal history. Historical order
  // precedes it; identities/payloads and monotonic live revisions stay untouched.
  const n=supported.length;db.prepare('UPDATE history_index SET seq=-seq').run();db.prepare('UPDATE history_index SET seq=-seq+?').run(n);db.prepare('UPDATE history_object_refs SET seq=seq+?').run(n);
  db.prepare("DELETE FROM metadata WHERE key IN('history-retention-indexed','retention-history-cursor')").run();
  supported.forEach((g,i)=>db.prepare("INSERT INTO history_index(seq,operation_id,source,activity_id,actor,committed_at,explanation,unit_ids,object_ids) VALUES(?,?,'legacy',?,'student',?,'旧版正式正文修改',?,?)").run(i+1,g.id,'legacy:'+g.id,g.event.savedAt,json(g.unitIds),json(g.changes.map(c=>c.objectId))));
  db.prepare("UPDATE sqlite_sequence SET seq=(SELECT max(seq) FROM history_index) WHERE name='history_index'").run();
 }
 report.formalHistory={restorableBodyGroups:supported.length,readOnlyGroups:unsupported};if(unsupported)report.gaps.push(`${unsupported}个旧知识一致组缺完整前值或尚无完整逆操作；原身份/时间/逐对象值仍可查，整个组明确只读，不跳过结构对象后局部恢复`);
}
