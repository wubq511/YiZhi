import type {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {coursePath} from './course-path';
import {hashFile} from './immutable-resource';
export function initializeCourseResources(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS exchange_operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS exchange_resources(asset TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS exchange_history(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);}
export function fenceImportedOperation(db:DatabaseSync,operationId:string){if(db.prepare('SELECT 1 FROM exchange_operations WHERE id=?').get(operationId))throw new Error('操作身份已用于交换导入');}
export function readCourseResource(db: DatabaseSync, directory: string, asset: string) {
  const exchanged = db.prepare("SELECT 1 FROM sqlite_master WHERE name='exchange_resources'").get() ? db.prepare('SELECT payload FROM exchange_resources WHERE asset=?').get(asset) : undefined;
  const legacy = db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
  const item = exchanged ? JSON.parse(String(exchanged.payload)) : legacy ? JSON.parse(String(legacy.value)).report.resources.find((item: any) => item.asset === asset) : undefined;
  if (!item || !item.mediaType.startsWith('image/')) throw new Error('未登记的课程图片');
  const path = coursePath(directory, item.path), actual = hashFile(path);
  if (actual.sha256 !== item.sha256 || actual.byteLength !== item.byteLength) throw new Error('课程图片损坏或缺失');
  return { bytes: new Uint8Array(readFileSync(path)), mediaType: item.mediaType };
}
