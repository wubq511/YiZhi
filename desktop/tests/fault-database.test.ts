import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { openFaultDatabase, holdFaultWriter } from './fault-database';

test('fault connections install and remove real storage faults after a competing writer releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-fault-writer-'));
  const path = join(root, 'course.sqlite'), fault = openFaultDatabase(path);
  let writer: Worker | undefined;
  try {
    fault.exec('PRAGMA journal_mode = WAL; CREATE TABLE entries (value TEXT)');
    writer = await holdFaultWriter(path); writer.postMessage('release');
    fault.exec("CREATE TRIGGER reject_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'actual test storage failure'); END");
    await writer.terminate(); writer = undefined;
    assert.throws(() => fault.exec("INSERT INTO entries VALUES ('unconfirmed')"), /actual test storage failure/);
    writer = await holdFaultWriter(path); writer.postMessage('release');
    fault.exec('DROP TRIGGER reject_entry');
    await writer.terminate(); writer = undefined;
    fault.exec("INSERT INTO entries VALUES ('confirmed retry')");
    assert.equal(fault.prepare('SELECT value FROM entries').get()!.value, 'confirmed retry');
  } finally { await writer?.terminate(); fault.close(); await rm(root, { recursive: true, force: true }); }
});
