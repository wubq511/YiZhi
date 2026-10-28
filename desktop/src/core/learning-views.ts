import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './save-store';
/** Durable confirmation concerns the last completed barrier, never an unseen renderer tail. */
export class LearningViews {
  constructor(private db:DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS learning_views(id TEXT PRIMARY KEY,state TEXT NOT NULL,updated_at TEXT NOT NULL);
      UPDATE learning_views SET state='lost' WHERE state='active';`);
  }
  open(viewId:string) {
    if(typeof viewId!=='string'||!viewId||viewId.length>200)throw new Error('学习窗口身份无效');
    return transaction(this.db,()=>{
      const own=this.db.prepare('SELECT state FROM learning_views WHERE id=?').get(viewId);
      const unconfirmedTail=!!this.db.prepare("SELECT 1 FROM learning_views WHERE state='lost' LIMIT 1").get();
      if(!own)this.db.prepare("INSERT INTO learning_views VALUES(?,'active',?)").run(viewId,new Date().toISOString());
      else this.db.prepare("UPDATE learning_views SET state='active',updated_at=? WHERE id=?").run(new Date().toISOString(),viewId);
      return {unconfirmedTail,detail:unconfirmedTail?'上次窗口异常结束。已确认的正文、草稿与个人记录已接回；未确认的最后输入无法保证找回。':'已接回持久确认的内容与草稿。'};
    });
  }
  release(viewId:string,saved:boolean) {
    return transaction(this.db,()=>{
      if(!this.db.prepare('SELECT 1 FROM learning_views WHERE id=?').get(viewId))throw new Error('学习窗口未登记');
      this.db.prepare('UPDATE learning_views SET state=?,updated_at=? WHERE id=?').run(saved?'saved':'lost',new Date().toISOString(),viewId);
      // A successful current barrier supersedes the prior uncertainty notice, not the durable drafts.
      if(saved)this.db.prepare("DELETE FROM learning_views WHERE id<>? AND state IN ('lost','saved')").run(viewId);
    });
  }
}
