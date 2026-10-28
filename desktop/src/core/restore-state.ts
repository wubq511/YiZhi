import type { DatabaseSync } from 'node:sqlite';
import type { CourseGraph } from '../shared';
import type { HistoryChange } from '../history-api';
import { equal } from '../editor-api';
import type { CourseRestoreSelection } from '../course-restore-api';
/** Only per-object user-state changes and formal-history references, never whole-course snapshots. */
export class RestoreState {
 constructor(private db:DatabaseSync,private graph:CourseGraph){
  db.exec(`CREATE TABLE IF NOT EXISTS restore_timeline(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,reference TEXT,domain TEXT,object_id TEXT,before_value TEXT,after_value TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS restore_formal_reference ON restore_timeline(reference) WHERE kind='formal';
    CREATE INDEX IF NOT EXISTS restore_state_scope ON restore_timeline(domain,object_id,seq);`);
  if(!db.prepare("SELECT 1 FROM metadata WHERE key='restore-state-start'").get()){
   for(const row of db.prepare('SELECT operation_id FROM history_index ORDER BY seq').all())db.prepare("INSERT OR IGNORE INTO restore_timeline(kind,reference) VALUES('formal',?)").run(row.operation_id!);
   db.prepare("INSERT INTO metadata VALUES('restore-state-start',?)").run(String(db.prepare('SELECT coalesce(max(seq),0) AS seq FROM restore_timeline').get()!.seq));
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS restore_timeline_group AFTER INSERT ON cg_history BEGIN INSERT OR IGNORE INTO restore_timeline(kind,reference) VALUES('formal',NEW.operation_id); END;
    CREATE TRIGGER IF NOT EXISTS restore_timeline_student AFTER INSERT ON operation_times BEGIN INSERT OR IGNORE INTO restore_timeline(kind,reference) VALUES('formal',NEW.operation_id); END;
    CREATE TRIGGER IF NOT EXISTS restore_timeline_placement AFTER INSERT ON placement_history BEGIN INSERT OR IGNORE INTO restore_timeline(kind,reference) VALUES('formal',json_extract(NEW.value,'$.operationId')); END;
    CREATE TRIGGER IF NOT EXISTS restore_state_review_insert AFTER INSERT ON review_states BEGIN
      INSERT INTO restore_timeline(kind,domain,object_id,before_value,after_value) VALUES('state','review',NEW.unit_id,NULL,json_object('unitId',NEW.unit_id,'status',NEW.status)); END;
    CREATE TRIGGER IF NOT EXISTS restore_state_review_update AFTER UPDATE ON review_states WHEN OLD.status<>NEW.status BEGIN
      INSERT INTO restore_timeline(kind,domain,object_id,before_value,after_value) VALUES('state','review',NEW.unit_id,json_object('unitId',OLD.unit_id,'status',OLD.status),json_object('unitId',NEW.unit_id,'status',NEW.status)); END;
    CREATE TRIGGER IF NOT EXISTS restore_state_layout_insert AFTER INSERT ON layout_baseline BEGIN
      INSERT INTO restore_timeline(kind,domain,object_id,before_value,after_value) VALUES('state','layout',NEW.unit_id,NULL,json_object('unitId',NEW.unit_id,'x',NEW.x,'y',NEW.y,'width',NEW.width)); END;
    CREATE TRIGGER IF NOT EXISTS restore_state_layout_update AFTER UPDATE ON layout_baseline WHEN OLD.x<>NEW.x OR OLD.y<>NEW.y OR OLD.width<>NEW.width BEGIN
      INSERT INTO restore_timeline(kind,domain,object_id,before_value,after_value) VALUES('state','layout',NEW.unit_id,json_object('unitId',OLD.unit_id,'x',OLD.x,'y',OLD.y,'width',OLD.width),json_object('unitId',NEW.unit_id,'x',NEW.x,'y',NEW.y,'width',NEW.width)); END;`);
 }
 changes(p:CourseRestoreSelection,unitIds:string[],read:(id:string)=>{value:Record<string,any>|null;version:number}):HistoryChange[]{
  if(!p.userState.review&&!p.userState.layout)return [];
  const anchor=this.db.prepare("SELECT seq FROM restore_timeline WHERE kind='formal' AND reference=?").get(p.atOperationId);
  const start=Number(this.db.prepare("SELECT value FROM metadata WHERE key='restore-state-start'").get()!.value);
  if(!anchor||Number(anchor.seq)<=start)throw new Error('所选旧时间点尚未记录可恢复的用户状态；可只恢复课程内容');
  const selected=new Set(unitIds),desired=new Map<string,Record<string,any>>();
  for(const row of this.db.prepare("SELECT * FROM restore_timeline WHERE kind='state' AND seq>? ORDER BY seq DESC").all(Number(anchor.seq)-(p.side==='before'?1:0))) {
   if(!selected.has(String(row.object_id))||!(row.domain==='review'?p.userState.review:p.userState.layout))continue;
   const id=String(row.object_id),domain=String(row.domain),n=this.graph.layout.nodes.find(n=>n.unitId===id);
   const before=row.before_value?JSON.parse(String(row.before_value)):domain==='review'?{unitId:id,status:'pending'}:n?{unitId:id,x:n.x,y:n.y,width:n.width}:null;
   if(!before)throw new Error('所选布局旧值缺少有效单元');desired.set(`${domain}:${id}`,before);
  }
  // A formal layout mutation occurs just before its formal reference in the same transaction.
  if(p.side==='before')for(const c of this.db.prepare('SELECT payload FROM cg_history WHERE operation_id=?').all(p.atOperationId).flatMap(r=>JSON.parse(String(r.payload)).changes as HistoryChange[])) {
   const domain=c.objectId.split(':')[0];if((domain==='layout'?p.userState.layout:domain==='review'&&p.userState.review)&&selected.has(c.objectId.slice(7))&&c.before)desired.set(c.objectId,c.before);
  }
  return [...desired].flatMap(([objectId,after])=>{const now=read(objectId);return equal(now.value,after)?[]:[{objectId,before:now.value,after,beforeVersion:now.version,afterVersion:now.version}];});
 }
}
