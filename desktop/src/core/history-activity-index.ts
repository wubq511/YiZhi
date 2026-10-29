import type { DatabaseSync } from 'node:sqlite';
/** Rebuildable activity heads and membership. No historical body or receipt is rewritten. */
export function initializeHistoryActivities(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS history_unit_refs(operation_id TEXT NOT NULL,unit_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(operation_id,unit_id));
    CREATE INDEX IF NOT EXISTS history_unit_order ON history_unit_refs(unit_id,seq);
    CREATE TABLE IF NOT EXISTS history_activity_heads(activity_id TEXT NOT NULL,unit_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(activity_id,unit_id));
    CREATE INDEX IF NOT EXISTS history_activity_page ON history_activity_heads(unit_id,seq DESC);`);
  const root = `(WITH RECURSIVE lineage(id,previous,path) AS (
    SELECT id,json_extract(payload,'$.continuesTaskId'),'|'||id||'|' FROM agent_tasks WHERE id=NEW.task_id
    UNION ALL SELECT t.id,json_extract(t.payload,'$.continuesTaskId'),l.path||t.id||'|' FROM lineage l JOIN agent_tasks t ON t.id=l.previous WHERE instr(l.path,'|'||t.id||'|')=0
  ) SELECT coalesce((SELECT id FROM lineage WHERE previous IS NULL LIMIT 1),NEW.task_id))`;
  const refs = `INSERT OR REPLACE INTO history_unit_refs SELECT NEW.operation_id,value,NEW.seq FROM json_each(NEW.unit_ids);`;
  const heads = `INSERT INTO history_activity_heads SELECT activity_id,'',seq FROM history_index WHERE operation_id=NEW.operation_id AND operation_id NOT IN(SELECT operation_id FROM history_expired)
    UNION ALL SELECT h.activity_id,u.unit_id,h.seq FROM history_index h JOIN history_unit_refs u USING(operation_id) WHERE h.operation_id=NEW.operation_id AND h.operation_id NOT IN(SELECT operation_id FROM history_expired)
    ON CONFLICT(activity_id,unit_id) DO UPDATE SET seq=max(seq,excluded.seq);`;
  const rebuild = (activity: string) => `DELETE FROM history_activity_heads WHERE activity_id=${activity};
    INSERT INTO history_activity_heads SELECT h.activity_id,'',max(h.seq) FROM history_index h WHERE h.activity_id=${activity} AND h.operation_id NOT IN(SELECT operation_id FROM history_expired) GROUP BY h.activity_id
    UNION ALL SELECT h.activity_id,u.unit_id,max(h.seq) FROM history_index h JOIN history_unit_refs u USING(operation_id) WHERE h.activity_id=${activity} AND h.operation_id NOT IN(SELECT operation_id FROM history_expired) GROUP BY h.activity_id,u.unit_id;`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_activity_insert AFTER INSERT ON history_index BEGIN
    UPDATE history_index SET activity_id='task:'||${root} WHERE operation_id=NEW.operation_id AND NEW.task_id IS NOT NULL;
    ${refs}${heads} END;
    CREATE TRIGGER IF NOT EXISTS history_activity_update AFTER UPDATE OF seq,activity_id,unit_ids ON history_index BEGIN
    DELETE FROM history_unit_refs WHERE operation_id=OLD.operation_id;${refs}${rebuild('OLD.activity_id')}${heads} END;
    CREATE TRIGGER IF NOT EXISTS history_activity_expire AFTER INSERT ON history_expired BEGIN
    ${rebuild('(SELECT activity_id FROM history_index WHERE operation_id=NEW.operation_id)')} END;`);
  if (!db.prepare("SELECT 1 FROM metadata WHERE key='history-activities-v1'").get()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // One metadata-only upgrade; original formal records retain their encoding and receipts.
      db.exec(`UPDATE history_index AS NEW SET activity_id=CASE WHEN task_id IS NULL THEN activity_id ELSE 'task:'||${root} END;
        INSERT OR REPLACE INTO history_unit_refs SELECT h.operation_id,u.value,h.seq FROM history_index h,json_each(h.unit_ids) u;
        INSERT INTO metadata VALUES('history-activities-v1','1'); COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
