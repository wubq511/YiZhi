import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FormalRelations } from './formal-relations';
import { CommandGroups } from './command-groups';
import { randomUUID } from 'node:crypto';
import type { OpenedCourse, SaveParagraph, SaveReceipt, EditCommand } from '../shared';

import { initializeSaveStore, readDrafts, saveDraft, eventCursor, commitEdit, queryOperation, history, confirmedInput, readEvents } from './save-store';

const EDITABLE = 'RB-TH-01-01-what-is-positional-notation';
interface Course { db: DatabaseSync; owner: DatabaseSync; sessionId: string; courseId: string;
  // T03 constructs its observer on this same connection; both student save entry points call it in-transaction.
  groups: CommandGroups;
  relations: FormalRelations;
}
const courses = new Map<string, Course>();
function session(id: string): Course {
  const course = [...courses.values()].find(course => course.sessionId === id);
  if (!course) throw new Error('编辑会话已失效，请重新打开课程');
  return course;
}
function snapshot(course: Course): OpenedCourse {
  const row = course.db.prepare('SELECT payload, revision FROM units WHERE id = ?').get('KU-001')!;
  return { courseId: course.courseId, sessionId: course.sessionId, revision: Number(row.revision),
    drafts: readDrafts(course.db), eventCursor: eventCursor(course.db),
    confirmedInputSeq: confirmedInput(course.db, course.sessionId), editableBlockId: EDITABLE, unit: JSON.parse(String(row.payload)),
    runtime: { node: process.versions.node, electron: process.versions.electron,
      sqlite: String(course.db.prepare('SELECT sqlite_version() AS version').get()!.version),
      pragmas: {
        journalMode: String(course.db.prepare('PRAGMA journal_mode').get()!.journal_mode),
        foreignKeys: Number(course.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys),
        synchronous: Number(course.db.prepare('PRAGMA synchronous').get()!.synchronous),
      } } };
}
function open(directory: string): OpenedCourse {
  mkdirSync(directory, { recursive: true });
  const canonical = realpathSync(directory);
  const existing = courses.get(canonical);
  if (existing) return snapshot(existing);
  // A separate DB holds an OS-backed exclusive transaction for the entire session.
  // It survives window closure and is released by SQLite on process death; no stale PID lock.
  const owner = new DatabaseSync(join(canonical, 'ownership.sqlite'));
  let db: DatabaseSync | undefined;
  try {
    owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    owner.close();
    throw new Error('课程已由另一应用进程打开，不能取得第二份写入资格');
  }
  try {
    db = new DatabaseSync(join(canonical, 'course.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 1) throw new Error('不支持的课程格式，拒绝写入');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES units(id), before_text TEXT NOT NULL, after_text TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
    if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
      const seed = readFileSync(join(__dirname, 'fixtures/unit-001.json'), 'utf8');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO units VALUES (?, ?, 1)').run('KU-001', seed);
        db.prepare('INSERT INTO metadata VALUES (?, ?)').run('courseId', randomUUID());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    initializeSaveStore(db);
    const groups = new CommandGroups(db);
    const relations = new FormalRelations(db, JSON.parse(readFileSync(join(__dirname, 'fixtures/graph.json'), 'utf8')),
      JSON.parse(readFileSync(join(__dirname, 'fixtures/relation-catalog.json'), 'utf8')));
    const course: Course = { db, owner, sessionId: randomUUID(), groups, relations,
      courseId: String(db.prepare("SELECT value FROM metadata WHERE key='courseId'").get()!.value) };
    const result = snapshot(course);
    courses.set(canonical, course);
    return result;
  } catch (error) { db?.close(); owner.close(); throw error; }
}
function commit(course: Course, command: EditCommand) {
  return commitEdit(course.db, command, () => course.groups.observe());
}
function save(command: SaveParagraph): SaveReceipt {
  if (!command || command.blockId !== EDITABLE) throw new Error('无效的段落保存请求');
  return commit(session(command.sessionId), { sessionId: command.sessionId,
    inputSeq: command.inputSeq, baseRevision: command.baseRevision, operationId: command.operationId,
    complete: true, changes: [{ blockId: command.blockId, text: command.text }] });
}
parentPort!.on('message', ({ id, action, payload }) => {
  try {
    let value: unknown;
    if (action === 'open') value = open(payload.directory);
    else if (action === 'read') value = snapshot(session(payload.sessionId));
    else if (action === 'readingState') {
      const row = session(payload.sessionId).db.prepare('SELECT payload FROM reading_state WHERE id=1').get();
      value = row ? JSON.parse(String(row.payload)) : null;
    } else if (action === 'setReadingState') {
      const encoded = JSON.stringify(payload.state);
      if (!encoded || encoded.length > 100000) throw new Error('阅读状态无效');
      session(payload.sessionId).db.prepare('INSERT INTO reading_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(encoded);
    }
    else if (action === 'graph') {
      value = session(payload.sessionId).relations.graph();
    } else if (action === 'readUnit') {
      const course = session(payload.sessionId);
      if (payload.unitId === 'KU-001') value = snapshot(course).unit;
      else if (['KU-002', 'KU-003', 'KU-004', 'KU-005', 'KU-006', 'KU-055', 'KU-057'].includes(payload.unitId))
        value = JSON.parse(readFileSync(join(__dirname, `fixtures/unit-${payload.unitId.slice(3)}.json`), 'utf8'));
      else throw new Error('该单元正文尚未加入课程副本');
    }
    else if (action === 'saveDraft') value = saveDraft(session(payload.sessionId).db, payload);
    else if (action === 'commitEdit') value = commit(session(payload.sessionId), payload);
    else if (action === 'queryOperation') value = queryOperation(session(payload.sessionId).db, payload.operationId);
    else if (action === 'readEvents') {
      const course = session(payload.sessionId);
      value = readEvents(course.db, payload.after, payload.limit) ?? { kind: 'reset', reason: 'cursor-expired',
        cursor: eventCursor(course.db), snapshot: snapshot(course) };
    }
    else if (action === 'history') value = history(session(payload.sessionId).db);
    else if (action === 'save') value = save(payload);
    else if (action === 'relations:prerequisites') value = session(payload.sessionId).relations.prerequisites(payload.unitId);
    else if (action === 'relations:read') value = session(payload.sessionId).relations.read(payload);
    else if (action === 'relations:commit') value = session(payload.sessionId).relations.commit(payload);
    else if (action === 'relations:query') value = session(payload.sessionId).relations.query(payload.operationId);
    else if (action.startsWith('commands:')) value = session(payload.sessionId).groups.dispatch(action, payload);
    else if (action === 'close') {
      for (const course of courses.values()) { course.db.close(); course.owner.close(); }
      courses.clear();
    } else throw new Error('未知课程命令');
    parentPort!.postMessage({ id, ok: true, value });
  } catch (error) { parentPort!.postMessage({ id, ok: false, error: (error as Error).message }); }
});
