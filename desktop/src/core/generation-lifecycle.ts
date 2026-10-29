import type { DatabaseSync } from 'node:sqlite';

/** Observe later formal writes too, so returning to equal content cannot erase ABA. */
export function initializeGenerationLifecycle(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS course_graph_revisions(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
    INSERT OR IGNORE INTO course_graph_revisions VALUES(1,0);
    DROP TRIGGER IF EXISTS generation_unit_insert;
    DROP TRIGGER IF EXISTS generation_unit_update;
    CREATE TRIGGER generation_unit_insert AFTER INSERT ON units BEGIN
      INSERT INTO cg_objects VALUES('unit:'||new.id,'unit',json_object('encoding','unit-header-v1','value',json(json_remove(new.payload,'$.reading.blocks'))),1)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value,version=version+1;
    END;
    CREATE TRIGGER generation_unit_update AFTER UPDATE ON units BEGIN
      INSERT INTO cg_objects VALUES('unit:'||new.id,'unit',json_object('encoding','unit-header-v1','value',json(json_remove(new.payload,'$.reading.blocks'))),1)
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
  const domains=[['graph','$.nodes','id'],['theme','$.groups','id'],['layout-theme','$.layout.groups','themeId']] as const;
  const stored=db.prepare("SELECT value FROM metadata WHERE key='course-graph'").get();
  if(stored){
    const graph=JSON.parse(String(stored.value)),legacyVersion=graphRevision(db);
    const insert=db.prepare('INSERT OR IGNORE INTO cg_objects VALUES(?,?,?,?)');
    for(const [kind,path,key] of domains){
      const values=path==='$.nodes'?graph.nodes:path==='$.groups'?graph.groups:graph.layout.groups;
      for(const value of values)insert.run(`${kind}:${value[key]}`,kind,JSON.stringify(value),legacyVersion);
    }
  }
  const updates=domains.map(([kind,path,key])=>`
    INSERT INTO cg_objects(id,kind,value,version)
      SELECT '${kind}:'||json_extract(value,'$.${key}'),'${kind}',json(value),1
      FROM json_each(new.value,'${path}') WHERE 1
      ON CONFLICT(id) DO UPDATE SET value=excluded.value,version=cg_objects.version+1
      WHERE cg_objects.value<>excluded.value;
    UPDATE cg_objects SET value='null',version=version+1
      WHERE kind='${kind}' AND value<>'null' AND id NOT IN
        (SELECT '${kind}:'||json_extract(value,'$.${key}') FROM json_each(new.value,'${path}'));`).join('');
  db.exec(`CREATE TRIGGER IF NOT EXISTS generation_graph_objects_insert AFTER INSERT ON metadata WHEN new.key='course-graph' BEGIN ${updates} END;
    CREATE TRIGGER IF NOT EXISTS generation_graph_objects_update AFTER UPDATE OF value ON metadata WHEN new.key='course-graph' BEGIN ${updates} END;`);
}

export function graphRevision(db:DatabaseSync) {
  return Number(db.prepare('SELECT version FROM course_graph_revisions WHERE id=1').get()?.version??0);
}
export function graphObjectRevision(db:DatabaseSync,id:string) {
  return Number(db.prepare('SELECT version FROM cg_objects WHERE id=?').get(id)?.version??0);
}
export function layoutRevision(db:DatabaseSync,unitId:string) {
  return Number(db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(unitId)?.version??0);
}
export function bumpLayoutRevision(db:DatabaseSync,unitId:string) {
  db.prepare('INSERT INTO layout_versions VALUES(?,1) ON CONFLICT(unit_id) DO UPDATE SET version=version+1').run(unitId);
}
