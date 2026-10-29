import type {DatabaseSync} from 'node:sqlite';
import {registerRetentionResourceRoot} from './retention-resources';
import {declaredResourcesIn} from './resource-roots';
export function initializeMigrationRecords(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS migration_origins(namespace TEXT NOT NULL,record_key TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,sha256 TEXT NOT NULL,extra TEXT NOT NULL,PRIMARY KEY(namespace,record_key));
 CREATE TABLE IF NOT EXISTS migration_pending(id TEXT PRIMARY KEY,namespace TEXT NOT NULL,record_key TEXT NOT NULL,purpose TEXT NOT NULL,state TEXT NOT NULL,payload TEXT,created_at TEXT);`);}
/** Enumerate real declarations, including absent blobs, without interpreting origin/value digests as files. */
export function migrationResourceRoots(db:DatabaseSync){
 const values:unknown[]=[];
 const read=(table:string,column:string,where='1')=>{
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return;
  for(const row of db.prepare(`SELECT ${column} value FROM ${table} WHERE ${where}`).all())if(row.value!==null)values.push(JSON.parse(String(row.value)));
 };
 read('migration_values','value');read('migration_pending','payload',"state='unresolved'");read('migration_origins','extra','deleted=0');
 read('restore_timeline','before_value',"kind='legacy'");read('restore_timeline','after_value',"kind='legacy'");
 return declaredResourcesIn(values,'t25-origin-and-imported-history');
}
registerRetentionResourceRoot('t25-origin-and-imported-history',(db,sha)=>{
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_values'").get()&&db.prepare('SELECT 1 FROM migration_values WHERE value LIKE ? LIMIT 1').get('%'+sha+'%'))return true;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_pending'").get()&&db.prepare("SELECT 1 FROM migration_pending WHERE state='unresolved' AND payload LIKE ? LIMIT 1").get('%'+sha+'%'))return true;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_origins'").get()&&db.prepare('SELECT 1 FROM migration_origins WHERE deleted=0 AND extra LIKE ? LIMIT 1').get('%'+sha+'%'))return true;
 return !!db.prepare("SELECT 1 FROM restore_timeline WHERE kind='legacy' AND (before_value LIKE ? OR after_value LIKE ?) LIMIT 1").get('%'+sha+'%','%'+sha+'%');
},migrationResourceRoots);
