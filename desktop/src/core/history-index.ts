import type { DatabaseSync } from 'node:sqlite';
/** Rebuildable metadata only. Bodies continue to live in their original formal records. */
export function initializeHistoryIndex(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS history_index(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
    activity_id TEXT NOT NULL, task_id TEXT, actor TEXT NOT NULL, committed_at TEXT NOT NULL,
    explanation TEXT NOT NULL, unit_ids TEXT NOT NULL, object_ids TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS history_activity ON history_index(activity_id,seq DESC);
    CREATE INDEX IF NOT EXISTS history_task ON history_index(task_id,seq DESC);`);
  const groupValues=(prefix:string)=>`SELECT ${prefix}.operation_id,'group',
    CASE WHEN json_extract(${prefix}.payload,'$.taskId') IS NOT NULL THEN 'task:'||json_extract(${prefix}.payload,'$.taskId') ELSE 'operation:'||${prefix}.operation_id END,
    json_extract(${prefix}.payload,'$.taskId'),coalesce(json_extract(${prefix}.payload,'$.actor'),'agent'),json_extract(${prefix}.payload,'$.committedAt'),
    coalesce(json_extract(${prefix}.payload,'$.explanation'),CASE WHEN json_extract(${prefix}.payload,'$.taskId') IS NOT NULL THEN 'Agent 修改' ELSE '正式关系修改' END),
    coalesce(json_extract(${prefix}.payload,'$.unitIds'),
      (SELECT json_group_array(DISTINCT id) FROM (
        SELECT json_extract(result,'$.unitId') AS id FROM cg_candidates WHERE id=${prefix}.operation_id
        UNION SELECT json_extract(value,'$.after.fromUnitId') FROM json_each(${prefix}.payload,'$.changes')
        UNION SELECT json_extract(value,'$.before.fromUnitId') FROM json_each(${prefix}.payload,'$.changes')
        UNION SELECT json_extract(value,'$.after.toUnitId') FROM json_each(${prefix}.payload,'$.changes')
        UNION SELECT json_extract(value,'$.before.toUnitId') FROM json_each(${prefix}.payload,'$.changes')
        UNION SELECT substr(json_extract(value,'$.objectId'),8) FROM json_each(${prefix}.payload,'$.changes') WHERE json_extract(value,'$.objectId') LIKE 'layout:%'
        UNION SELECT substr(json_extract(value,'$.objectId'),12,instr(substr(json_extract(value,'$.objectId'),12),'/')-1) FROM json_each(${prefix}.payload,'$.changes') WHERE json_extract(value,'$.objectId') LIKE 'experiment:%'
      ) WHERE id IS NOT NULL)),
    (SELECT json_group_array(json_extract(value,'$.objectId')) FROM json_each(${prefix}.payload,'$.changes'))`;
  const columns='operation_id,source,activity_id,task_id,actor,committed_at,explanation,unit_ids,object_ids';
  // operation_times is inserted after operations, in the same formal transaction.
  const studentValues=(prefix:string)=>`SELECT o.id,'student','edit:'||json_extract(o.receipt,'$.sessionId')||':'||CAST(unixepoch(${prefix}.committed_at)/300 AS INTEGER),NULL,'student',${prefix}.committed_at,'学生编辑正文',json_array(o.unit_id),
    coalesce(json_extract(o.receipt,'$.blockIds'),json_array(json_extract(o.receipt,'$.blockId')))
    FROM operations o WHERE o.id=${prefix}.operation_id`;
  const placementValues=(prefix:string)=>`SELECT json_extract(${prefix}.value,'$.operationId'),'placement','operation:'||json_extract(${prefix}.value,'$.operationId'),NULL,'student',json_extract(${prefix}.value,'$.committedAt'),'调整单元布局',json_array(json_extract(${prefix}.value,'$.after.unitId')),json_array('layout:'||json_extract(${prefix}.value,'$.after.unitId'))`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_index_group AFTER INSERT ON cg_history BEGIN INSERT INTO history_index(${columns}) ${groupValues('NEW')}; END;
    CREATE TRIGGER IF NOT EXISTS history_index_student AFTER INSERT ON operation_times BEGIN INSERT INTO history_index(${columns}) ${studentValues('NEW')}; END;
    CREATE TRIGGER IF NOT EXISTS history_index_placement AFTER INSERT ON placement_history BEGIN INSERT INTO history_index(${columns}) ${placementValues('NEW')}; END;`);
  // Old databases gain metadata once, ordered by the original confirmed time/cursor (not table insertion order).
  if(!db.prepare("SELECT 1 FROM metadata WHERE key='history-index-v1'").get()) {
    const rows=db.prepare(`SELECT operation_id AS id,'group' AS source,json_extract(payload,'$.committedAt') AS time,
      (SELECT json_extract(result,'$.cursor') FROM cg_candidates c WHERE c.id=h.operation_id) AS cursor FROM cg_history h
      UNION ALL SELECT o.id,'student',t.committed_at,json_extract(o.receipt,'$.cursor') FROM operations o JOIN operation_times t ON t.operation_id=o.id
      UNION ALL SELECT json_extract(value,'$.operationId'),'placement',json_extract(value,'$.committedAt'),0 FROM placement_history
      ORDER BY time,cursor,id`).all();
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of rows) {
        if(db.prepare('SELECT 1 FROM history_index WHERE operation_id=?').get(row.id!))continue;
        const select=row.source==='group'?`${groupValues('h')} FROM cg_history h WHERE h.operation_id=?`:
          row.source==='student'?`${studentValues('t').replace('FROM operations o WHERE','FROM operations o JOIN operation_times t ON t.operation_id=o.id WHERE')} AND t.operation_id=?`:
          `${placementValues('h')} FROM placement_history h WHERE json_extract(h.value,'$.operationId')=?`;
        db.prepare(`INSERT INTO history_index(${columns}) ${select}`).run(row.id!);
      }
      db.prepare("INSERT INTO metadata VALUES('history-index-v1','1')").run();db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
}
