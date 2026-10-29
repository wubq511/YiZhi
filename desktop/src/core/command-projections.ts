import type { DatabaseSync } from 'node:sqlite';
/** Disposable current relation endpoints. Monotonic objects and receipts remain in cg_objects/history. */
export function initializeRelationProjection(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS cg_relation_endpoints(relation_id TEXT NOT NULL,block_id TEXT NOT NULL,PRIMARY KEY(relation_id,block_id));
    CREATE INDEX IF NOT EXISTS cg_relation_blocks ON cg_relation_endpoints(block_id,relation_id);
    CREATE TABLE IF NOT EXISTS cg_dirty_memberships(id TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS cg_dependency_source ON cg_objects(json_extract(value,'$.sourceBlockId')) WHERE kind='dependency';`);
  const endpoints=(ref:string)=>`json_array(json_extract(${ref}.value,'$.sourceBlockId'),json_extract(${ref}.value,'$.dependentBlockId'),json_extract(${ref}.value,'$.fromBlockId'),json_extract(${ref}.value,'$.toBlockId'))`;
  const add=`INSERT OR IGNORE INTO cg_relation_endpoints SELECT NEW.id,value FROM json_each(${endpoints('NEW')}) WHERE value IS NOT NULL AND NEW.kind IN('reference','dependency');
    INSERT OR IGNORE INTO cg_dirty_memberships SELECT block_id FROM cg_relation_endpoints WHERE relation_id=NEW.id;`;
  const remove=`INSERT OR IGNORE INTO cg_dirty_memberships SELECT block_id FROM cg_relation_endpoints WHERE relation_id=OLD.id;
    DELETE FROM cg_relation_endpoints WHERE relation_id=OLD.id;`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS cg_relation_insert AFTER INSERT ON cg_objects WHEN NEW.kind IN('reference','dependency') BEGIN ${add} END;
    CREATE TRIGGER IF NOT EXISTS cg_relation_update AFTER UPDATE ON cg_objects WHEN (OLD.kind IN('reference','dependency') OR NEW.kind IN('reference','dependency')) AND (OLD.kind<>NEW.kind OR ${endpoints('OLD')}<>${endpoints('NEW')}) BEGIN ${remove}${add} END;
    CREATE TRIGGER IF NOT EXISTS cg_relation_delete AFTER DELETE ON cg_objects WHEN OLD.kind IN('reference','dependency') BEGIN ${remove} END;`);
  if(!db.prepare("SELECT 1 FROM metadata WHERE key='cg-relations-v1'").get()) {
    db.exec(`INSERT OR IGNORE INTO cg_relation_endpoints SELECT o.id,e.value FROM cg_objects o,json_each(${endpoints('o')}) e WHERE o.kind IN('reference','dependency') AND e.value IS NOT NULL;
      INSERT OR IGNORE INTO cg_dirty_memberships SELECT DISTINCT block_id FROM cg_relation_endpoints;
      INSERT INTO metadata VALUES('cg-relations-v1','1');`);
  }
}
