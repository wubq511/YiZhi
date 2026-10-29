import type { DatabaseSync } from 'node:sqlite';
import {unitObjects} from './history-objects';
const parse=(v:unknown)=>JSON.parse(String(v));
const canonical=(v:any):string=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export function initializeMigrationHistory(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS migration_values(id TEXT PRIMARY KEY,value TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migration_receipts(id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt_digest TEXT NOT NULL,receipt TEXT NOT NULL,committed_at TEXT,sequence INTEGER NOT NULL,generation INTEGER NOT NULL,expired INTEGER NOT NULL DEFAULT 0);`);
 for(const [name,type] of [['committed_at','TEXT'],['origin','TEXT']] as const)if(!db.prepare('PRAGMA table_info(restore_timeline)').all().some(r=>r.name===name))db.exec(`ALTER TABLE restore_timeline ADD COLUMN ${name} ${type}`);
}
export function decode(db:DatabaseSync,value:any):any {
 if(value&&typeof value==='object'&&typeof value.$value==='string'&&Object.keys(value).length===1){const row=db.prepare('SELECT value FROM migration_values WHERE id=?').get(value.$value);if(!row)throw new Error('旧版明细已过期清理，无法恢复原载荷');return parse(row.value);}
 if(Array.isArray(value))return value.map(x=>decode(db,x));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,decode(db,v)]));return value;
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
