import type { DatabaseSync } from 'node:sqlite';

/** Observe later formal writes too, so returning to equal content cannot erase ABA. */
export function initializeGenerationLifecycle(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS course_graph_revisions(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO course_graph_revisions VALUES(1,0);
    CREATE TRIGGER IF NOT EXISTS generation_unit_insert AFTER INSERT ON units BEGIN
      INSERT INTO cg_objects VALUES('unit:'||new.id,'unit',new.payload,1)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value,version=version+1;
    END;
    CREATE TRIGGER IF NOT EXISTS generation_unit_update AFTER UPDATE ON units BEGIN
      INSERT INTO cg_objects VALUES('unit:'||new.id,'unit',new.payload,1)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value,version=version+1;
    END;
    CREATE TRIGGER IF NOT EXISTS generation_unit_delete AFTER DELETE ON units BEGIN
      INSERT INTO cg_objects VALUES('unit:'||old.id,'unit','null',1)
      ON CONFLICT(id) DO UPDATE SET value='null',version=version+1;
    END;
    CREATE TRIGGER IF NOT EXISTS generation_graph_insert AFTER INSERT ON metadata WHEN new.key='course-graph' BEGIN
      UPDATE course_graph_revisions SET version=version+1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS generation_graph_update AFTER UPDATE OF value ON metadata WHEN new.key='course-graph' BEGIN
      UPDATE course_graph_revisions SET version=version+1 WHERE id=1;
    END;`);
}

export function graphRevision(db:DatabaseSync) {
  return Number(db.prepare('SELECT version FROM course_graph_revisions WHERE id=1').get()?.version??0);
}
export function layoutRevision(db:DatabaseSync,unitId:string) {
  return Number(db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(unitId)?.version??0);
}
export function bumpLayoutRevision(db:DatabaseSync,unitId:string) {
  db.prepare('INSERT INTO layout_versions VALUES(?,1) ON CONFLICT(unit_id) DO UPDATE SET version=version+1').run(unitId);
}
