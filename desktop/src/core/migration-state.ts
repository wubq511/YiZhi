import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { registerRetentionResourceRoot } from './retention-resources';
const json=JSON.stringify;
export type LegacyRow={namespace:string;key:string;revision:number;deleted:number;value_json:string};
const fields:Record<string,string[]>={notes:['noteId','text','objectId','anchor','createdAt','updatedAt'],review:['status'],layout:['objectId','blockId','x','y','width'],annotations:['drawingId','objectId','tool','anchor','createdAt','updatedAt'],reading:['selected','expanded','camera'],materialUpdates:['updateId','versionId','status','createdAt'],knowledge:['hash']};
export function initializeMigrationRecords(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS migration_origins(namespace TEXT NOT NULL,record_key TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,sha256 TEXT NOT NULL,extra TEXT NOT NULL,PRIMARY KEY(namespace,record_key));
 CREATE TABLE IF NOT EXISTS migration_pending(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,record_key TEXT NOT NULL,purpose TEXT NOT NULL,state TEXT NOT NULL,payload TEXT,created_at TEXT);`);}
export function origin(db:DatabaseSync,row:LegacyRow,value:any,extra?:any){
 const special=row.namespace==='knowledge'?{contentHash:value?.hash??createHash('sha256').update(json(value)).digest('hex')}:row.namespace==='tasks'?{historyPurpose:'original-execution-facts',extra:Object.fromEntries(Object.entries(value??{}).filter(([k])=>!['submittedEntity','startEntity','reads','concurrentEdits','pendingRequest','previousPendingRequest'].includes(k)))}:row.namespace==='conversations'?Object.fromEntries(Object.entries(value??{}).filter(([k])=>!['messages','draft','title','updatedAt'].includes(k))):row.namespace==='editingDrafts'?{type:value?.type??null,conversationId:value?.conversationId??null,cleared:!!value?.cleared}:undefined;
 const retained=extra??special??(typeof value==='object'&&value!==null?Object.fromEntries(Object.entries(value??{}).filter(([key])=>row.namespace!=='notes'||!(fields.notes??[]).includes(key))):{original:value});
 db.prepare('INSERT INTO migration_origins VALUES(?,?,?,?,?,?)').run(row.namespace,row.key,row.revision,row.deleted,createHash('sha256').update(row.value_json).digest('hex'),json(retained));
}
export function migrationRecords(db:DatabaseSync,p:{namespace?:string;after?:string;limit?:number}){
 initializeMigrationRecords(db);const limit=p.limit??30;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('迁移记录分页无效');
 const rows=db.prepare("SELECT * FROM migration_origins WHERE (? IS NULL OR namespace=?) AND namespace||':'||record_key>? ORDER BY namespace,record_key LIMIT ?").all(p.namespace??null,p.namespace??null,p.after??'',limit+1);
 return {records:rows.slice(0,limit).map(r=>({namespace:r.namespace,key:r.record_key,revision:r.revision,deleted:!!r.deleted,sha256:r.sha256,extra:JSON.parse(String(r.extra))})),...(rows.length>limit?{next:rows[limit-1].namespace+':'+rows[limit-1].record_key}:{})};
}
registerRetentionResourceRoot('t25-origin-and-imported-history',(db,sha)=>{
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_values'").get()&&db.prepare('SELECT 1 FROM migration_values WHERE value LIKE ? LIMIT 1').get('%'+sha+'%'))return true;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_pending'").get()&&db.prepare("SELECT 1 FROM migration_pending WHERE state='unresolved' AND payload LIKE ? LIMIT 1").get('%'+sha+'%'))return true;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_origins'").get()&&db.prepare('SELECT 1 FROM migration_origins WHERE deleted=0 AND extra LIKE ? LIMIT 1').get('%'+sha+'%'))return true;
 return !!db.prepare("SELECT 1 FROM restore_timeline WHERE kind='legacy' AND (before_value LIKE ? OR after_value LIKE ?) LIMIT 1").get('%'+sha+'%','%'+sha+'%');
});
export function migrateNativeState(db:DatabaseSync,rows:LegacyRow[],report:any){
 const active=rows.filter(r=>!r.deleted),find=(ns:string,key?:string)=>active.find(r=>r.namespace===ns&&(!key||r.key===key)),value=(r:LegacyRow)=>JSON.parse(r.value_json);
 const units=new Map(db.prepare('SELECT id,payload FROM units').all().map(r=>[String(r.id),JSON.parse(String(r.payload))]));
 const block=(unitId:string,id:string)=>{const walk=(xs:any[]):any=>{for(const b of xs){if(b.id===id)return b;const child=walk(b.children??[]);if(child)return child;}};return walk(units.get(unitId)?.reading.blocks??[]);};
 for(const r of active){const v=value(r);
  if(r.namespace==='review'){
   const status=v.status==='todo'?'pending':v.status;
   if(units.has(r.key)&&['pending','weak','mastered'].includes(status)){db.prepare('INSERT OR REPLACE INTO review_states VALUES(?,?,?)').run(r.key,status,r.revision);report.namespaces.review.imported++;}else report.gaps.push(`${r.namespace}/${r.key}：状态或单元不能核对，原值只读保留`);
  }
  if(r.namespace==='layout'&&r.key.startsWith('VE-')){
   const id=r.key.slice(3); // Old app/editing.js explicitly addresses VE-${unitId}; require a real matching unit.
   if(units.has(id)&&(!v.objectId||v.objectId===id)&&[v.x,v.y,v.width].every(Number.isFinite)&&v.width>=160&&v.width<=2400){db.prepare('INSERT OR REPLACE INTO layout_baseline VALUES(?,?,?,?)').run(id,v.x,v.y,v.width);db.prepare('INSERT OR REPLACE INTO layout_versions VALUES(?,?)').run(id,r.revision);report.namespaces.layout.imported++;}
   else report.gaps.push(`${r.key}：旧布局无法对应有效单元，原值保留`);
  }
  if(r.namespace==='annotations'){
   const a=v.anchor??{},l=find('layout',r.key),g=l&&value(l),id=v.objectId,b=a.blockId&&block(id,a.blockId);
   const supported=!!g&&[g.x,g.y,g.width,g.height].every(Number.isFinite),matches=units.has(id)&&(!a.blockId||b&&(!a.originalText||a.originalText===b.payload.text));
   const geometry=supported?{x:g.x+(g.flipX?g.width:0),y:g.y+(g.flipY?g.height:0),width:g.flipX?-g.width:g.width,height:g.flipY?-g.height:g.height}:{x:0,y:0,width:0,height:0};
   const original={kind:v.tool==='highlight'?'highlighter':v.tool,color:v.color,anchor:{space:'object',unitId:id,...(a.blockId?{blockId:a.blockId,...(b?{block:b}:{})}:{})},geometry};
   const record={id:r.key,version:r.revision,value:supported?original:null,original,status:supported&&matches?'attached':'orphan',legacy:{anchor:a,color:v.color,createdAt:v.createdAt??null,updatedAt:v.updatedAt??null,layout:g??null,geometryPending:!supported||!matches}};
   db.prepare('INSERT INTO personal_drawings VALUES(?,?)').run(r.key,json(record));report.namespaces.annotations.imported++;
   if(!matches||!supported)report.gaps.push(`${r.key}：旧图形几何或原目标无法核对，保留原语境待关联`);
  }
  if(r.namespace==='materialUpdates'){
   const decision=v.status==='later'?'defer':v.status==='update'?'update':null;
   if(decision&&db.prepare('SELECT 1 FROM source_versions WHERE id=?').get(v.versionId)){db.prepare('INSERT INTO source_intents VALUES(?,?,?)').run(r.key,v.versionId,json({id:r.key,versionId:v.versionId,decision,createdAt:v.createdAt??null,generation:1,legacy:{status:v.status,sourceId:v.sourceId,affectedUnitIds:v.affectedUnitIds}}));report.namespaces.materialUpdates.imported++;}
   else report.gaps.push(`${r.key}：旧资料更新意图尚未完成，原状态保留，不伪造defer或已更新`);
  }
 }
 const rr=find('reading','default');if(rr){const v=value(rr),id=String(v.selected??'');
  if(units.has(id)){
   const state={unitId:id,expanded:Array.isArray(v.expanded)?Object.fromEntries(v.expanded.map((x:string)=>[x,true])):v.expanded??{},returnStack:[],scrollTop:v.unitScroll?.[id]??0,unitScroll:v.unitScroll??{},...(v.camera&&[v.camera.x,v.camera.y,v.camera.scale].every(Number.isFinite)?{camera:{x:v.camera.x,y:v.camera.y,zoom:v.camera.scale}}:{})};
   db.prepare('INSERT OR REPLACE INTO reading_state VALUES(1,?)').run(json(state));report.namespaces.reading.imported++;
  }
  const source=v.sourceView??v.source;if(source?.versionId&&Number.isSafeInteger(source.location?.pdfPage)&&source.location.pdfPage>0&&db.prepare('SELECT 1 FROM source_versions WHERE id=?').get(source.versionId)){
   db.prepare("INSERT OR REPLACE INTO source_reading VALUES(1,'legacy-migration',0,?)").run(json({open:true,versionId:source.versionId,pdfPageIndex:source.location.pdfPage-1,scrollTop:v.sourceScroll??0,scrollLeft:0,scale:1,legacyMissing:['scrollLeft','scale'],target:{unitId:id}}));
   report.gaps.push('旧来源选段/归一化区域保留只读原语境，未伪造成PDF.js精确citation；缺少的缩放/横滚采用新阅读器初始视口');
  }
 }
}
