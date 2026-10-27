'use strict';
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const {canonical,hash,receipt} = require('./fixture.cjs');
const schema = `
CREATE TABLE baseline(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE current(key TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE operations(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL);
CREATE TABLE changes(operation TEXT REFERENCES operations(id),key TEXT REFERENCES current(key),before TEXT NOT NULL,after TEXT NOT NULL,prior_revision INTEGER NOT NULL,PRIMARY KEY(operation,key));
CREATE INDEX changes_by_key ON changes(key,operation);
CREATE TABLE drafts(key TEXT PRIMARY KEY REFERENCES current(key),input_seq INTEGER NOT NULL,text TEXT NOT NULL);
CREATE TABLE messages(conversation TEXT NOT NULL,offset INTEGER NOT NULL,bytes INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(conversation,offset));`;
function connect(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA wal_autocheckpoint=1000; PRAGMA fullfsync=OFF; PRAGMA checkpoint_fullfsync=OFF;');
  return db;
}
function pragmas(db) {
  const out = Object.fromEntries(['journal_mode','synchronous','foreign_keys','busy_timeout','wal_autocheckpoint','page_size','fullfsync','checkpoint_fullfsync'].map(k => [k,Object.values(db.prepare(`PRAGMA ${k}`).get())[0]]));
  assert.equal(out.journal_mode,'wal'); assert.equal(out.synchronous,2);
  assert.equal(out.page_size,4096); assert.equal(out.foreign_keys,1);
  return out;
}
function seedDatabase(file, seed) {
  const db = connect(file);
  try {
    db.exec(schema); db.exec('BEGIN IMMEDIATE');
    const a = db.prepare('INSERT INTO baseline VALUES (?,?)'), b = db.prepare('INSERT INTO current VALUES (?,?,0)');
    for (const [key,value] of seed.objects) { a.run(key,value); b.run(key,value); }
    db.exec('COMMIT');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy,0);
    return {pragmas:pragmas(db),sqlite:db.prepare('SELECT sqlite_version() AS version').get().version,
      compileOptions:db.prepare('PRAGMA compile_options').all(),units:seed.unitCount,objects:seed.objectCount};
  } finally { db.close(); }
}
class Adapter {
  constructor(file) {
    this.db = connect(file);
    this.settings = pragmas(this.db);
    const sql = {
      prior:'SELECT * FROM operations WHERE id=?', next:'SELECT COALESCE(MAX(seq),0)+1 AS seq FROM operations',
      current:'SELECT * FROM current WHERE key=?',
      operation:'INSERT INTO operations VALUES (?,?,?,?,?)',
      change:'INSERT INTO changes VALUES (?,?,?,?,?)', update:'UPDATE current SET value=?,revision=revision+1 WHERE key=?',
      draft:'SELECT * FROM drafts WHERE key=?',
      saveDraft:'INSERT INTO drafts VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET input_seq=excluded.input_seq,text=excluded.text',
      offset:'SELECT COALESCE(MAX(offset+bytes),0) AS end FROM messages WHERE conversation=?',
      message:'INSERT INTO messages VALUES (?,?,?,?)',
    };
    this.q = Object.fromEntries(Object.entries(sql).map(([k,v]) => [k,this.db.prepare(v)]));
  }
  apply(c) {
    const started = performance.now();
    const request = canonical(c), requestHash = hash(request);
    const transactionStarted = performance.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.q.prior.get(c.id);
      let value, duplicate = false;
      if (old) {
        if (old.request_hash !== requestHash) throw new Error('operation_payload_changed');
        value = JSON.parse(old.receipt); duplicate = true;
      } else {
        const seq = this.q.next.get().seq;
        value = receipt(c,seq);
        this.q.operation.run(seq,c.id,requestHash,request,canonical(value));
        if (c.kind === 'group') for (const e of c.edits) {
          const before = this.q.current.get(e.key);
          if (!before || before.revision !== e.expectedRevision) throw new Error('stale_revision');
          const after = canonical(e.after);
          this.q.change.run(c.id,e.key,before.value,after,before.revision);
          this.q.update.run(after,e.key);
        }
        else if (c.kind === 'draft') {
          const prior = this.q.draft.get(c.key);
          if (prior && c.inputSeq <= prior.input_seq) throw new Error('stale_draft');
          this.q.saveDraft.run(c.key,c.inputSeq,c.text);
        } else if (c.kind === 'message') {
          if (this.q.offset.get(c.conversation).end !== c.offset) throw new Error('message_offset');
          this.q.message.run(c.conversation,c.offset,Buffer.byteLength(c.text),c.text);
        } else throw new Error('unknown_kind');
      }
      const commitStarted = performance.now();
      this.db.exec('COMMIT');
      const finished = performance.now();
      return {receipt:value,duplicate,adapterMs:finished-started,
        transactionMs:finished-transactionStarted,commitCallMs:finished-commitStarted};
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  probeRollback() {
    const before = hash(this.snapshot());
    let failure;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec("UPDATE current SET value='synthetic must rollback' WHERE key=(SELECT MIN(key) FROM current)");
      this.q.saveDraft.run('definitely-missing-object',1,'expected FK error');
    } catch (e) { failure = {name:e.name,message:e.message,code:e.code,errcode:e.errcode,errstr:e.errstr}; }
    finally { this.db.exec('ROLLBACK'); }
    assert(failure && /FOREIGN KEY/i.test(failure.message),'must execute a real SQLite foreign-key error');
    assert.equal(hash(this.snapshot()),before,'rollback must restore every table');
    return {failure,unchanged:true};
  }
  snapshot() {
    return Object.fromEntries(Object.entries({baseline:'key',current:'key',operations:'seq',
      changes:'operation,key',drafts:'key',messages:'conversation,offset'})
      .map(([t,order]) => [t,this.db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all()]));
  }
  verify(seed, commands) {
    const {expectedSnapshot} = require('./fixture.cjs');
    const actual = this.snapshot(), expected = expectedSnapshot(seed,commands);
    assert.equal(hash(actual),hash(expected),'independent final current/history/receipt oracle');
    const integrity = this.db.prepare('PRAGMA integrity_check').all();
    assert.deepEqual(integrity.map(r => r.integrity_check),['ok']);
    assert.equal(this.db.prepare('PRAGMA foreign_key_check').all().length,0);
    return {snapshotSha256:hash(actual),tableCounts:Object.fromEntries(Object.entries(actual).map(([k,v]) => [k,v.length])),
      integrity:'ok',foreignKeys:'ok',oracle:'matched'};
  }
  close() { this.db.close(); }
}
module.exports = {Adapter,seedDatabase};
