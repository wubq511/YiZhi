import type { DatabaseSync } from 'node:sqlite';
/** Remove the proven duplicate unit-body cache; retain the sole provenance/catalog fields. */
export function registerLegacyRetention(db:DatabaseSync,now:string){
 if(db.prepare("SELECT 1 FROM metadata WHERE key='legacy-content'").get())db.prepare("INSERT OR IGNORE INTO metadata VALUES('legacy-retention-registered-at',?)").run(now);
}
export function cropLegacyContent(db:DatabaseSync,cutoff:string,now:string){
 const registered=db.prepare("SELECT value FROM metadata WHERE key='legacy-retention-registered-at'").get();
 if(!registered||String(registered.value)>=cutoff)return false;
 const row=db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();if(!row)return false;
 const legacy=JSON.parse(String(row.value));if(legacy.retention?.originalUnitBodies==='expired')return false;
 for(const unit of legacy.knowledge.units){
  if(!db.prepare('SELECT 1 FROM units WHERE id=?').get(unit.id)){
   const boundary=db.prepare('SELECT value FROM history_boundary WHERE object_id=?').get(`unit:${unit.id}`);
   if(!boundary||JSON.parse(String(boundary.value))!==null)throw new Error('原课程单元尚未对应正式内容或退休事实，保留来源缓存供核对');
  }
 }
 legacy.knowledge.units=legacy.knowledge.units.map((unit:any)=>{
  const {blocks,...reading}=unit.reading;return {...unit,reading:{...reading,originalBlocksExpired:true}};
 });
 legacy.layout={...legacy.layout,nodes:[],groups:[],edges:[],originalPlacementsExpired:true};
 legacy.retention={originalUnitBodies:'expired',expiredAt:now,registeredAt:registered.value};
 legacy.report.gaps=[...legacy.report.gaps,'原始单元正文与原始布局的重复副本已按保留期限清理；当前正式内容、来源清单、未知元数据与原始摘要仍独立保留。'];
 db.prepare("UPDATE metadata SET value=? WHERE key='legacy-content'").run(JSON.stringify(legacy));return true;
}
