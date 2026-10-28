import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

/** Independent fault injectors share the running app's short SQLite write leases. */
export function openFaultDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

/** A real competing writer for fault-setup regressions; caller terminates in finally. */
export async function holdFaultWriter(path: string): Promise<Worker> {
  const writer = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      db.exec('COMMIT'); db.close(); parentPort.close();
    }, 150));
  `, { eval: true, workerData: path });
  await once(writer, 'message');
  return writer;
}
