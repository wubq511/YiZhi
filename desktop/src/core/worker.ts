import { FormalHistory } from './formal-history';
import { HistoryRetention } from './retention';
import { CourseRestore } from './course-restore';
import { LearningViews } from './learning-views';
import { AgentMutations } from './agent-mutations';
import { CommandConsistency } from './command-consistency';
import { Exchange } from './exchange';

import { Search } from './search';
import { snapshotLegacy, convertLegacy, legacyContent, candidateResource } from './migration';
import { Drawings } from './drawings';
import { Annotations } from './annotations';
import { initializeLayout, layoutGraph, saveLayout } from './local-layout';
import { projectLayout } from '../layout';

import { Extensions } from './extensions';
import { BuiltinExperiments } from './builtin-experiments';
import { AgentStore } from './agent-store';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FormalRelations } from './formal-relations';
import { CommandGroups } from './command-groups';
import { Parsing } from './parsing';
import { Sources } from './sources';
import { randomUUID } from 'node:crypto';
import type { CourseGraph, OpenedCourse, SaveParagraph, SaveReceipt, EditCommand } from '../shared';

import { initializeSaveStore, readDrafts, saveDraft, eventCursor, commitEdit, queryOperation, history, confirmedInput, readEvents } from './save-store';
import { transaction } from './save-store';
import { resolveInput } from './save-store';
import { initializeReviewState, reviewSnapshot, setReviewStatus, confirmReviewPrompt } from './review-state';

const EDITABLE = 'RB-TH-01-01-what-is-positional-notation';
interface Course { db: DatabaseSync; owner: DatabaseSync; sessionId: string; courseId: string; graph: CourseGraph;
  retention:HistoryRetention;
  // T03 constructs its observer on this same connection; both student save entry points call it in-transaction.
  formalHistory: FormalHistory;
  courseRestore: CourseRestore;
  views: LearningViews;
  exchange: Exchange;
  search: Search;
  unit: (id: string) => import('../shared').CourseUnit | undefined;
  annotations: Annotations;
  drawings: Drawings;
  groups: CommandGroups;
  sources: Sources;
  experiments: BuiltinExperiments;
  extensions: Extensions;
  parsing: Parsing;
  relations: FormalRelations;
  agent: AgentStore;
  mutations: AgentMutations;
}
const courses = new Map<string, Course>();
const historicalRoutes=new Set(['courseRestore:apply','courseRestore:query','queryOperation','commands:query','commands:history','formalHistory:query','formalHistory:release','formalHistory:detail','formalHistory:list','relations:query','annotations:query','drawings:query','drawings:queryPlacement','sources:query','parsing:query','agent:record','agent:task','agent:facts','agent:stop','agent:get','agent:list','agent:events','agent:work','agentMutation:query']);
function session(id: string,action?:string): Course {
  const course = [...courses.values()].find(course => course.sessionId === id || action&&historicalRoutes.has(action)&&!!course.db.prepare('SELECT 1 FROM course_sessions WHERE id=?').get(id));
  if (!course) throw new Error('编辑会话已失效，请重新打开课程');
  return course;
}
function snapshot(course: Course, unitId = 'KU-001'): OpenedCourse {
  let row = course.db.prepare('SELECT payload, revision FROM units WHERE id = ?').get(unitId);
  if (!row) {
    const unit = course.unit(unitId);
    if (!unit) throw new Error('该单元正文不可读');
    course.db.prepare('INSERT INTO units VALUES(?,?,1)').run(unitId, JSON.stringify(unit));
    course.groups.observe();
    row = course.db.prepare('SELECT payload, revision FROM units WHERE id = ?').get(unitId)!;
  }
  return { resourceAssets: course.db.prepare('SELECT asset FROM exchange_resources ORDER BY asset').all().map(r => String(r.asset)), contentScope: course.db.prepare("SELECT value FROM metadata WHERE key='content-scope'").get()?.value === 'content-candidate' ? 'content-candidate' : undefined, courseId: course.courseId, sessionId: course.sessionId, generation:Number(course.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value), preservedDraftCount:course.courseRestore.drafts().length, revision: Number(row.revision),
    blockVersions: Object.fromEntries(course.db.prepare("SELECT id, version FROM cg_objects WHERE kind='block'").all().map(r => [String(r.id), Number(r.version)])),
    drafts: readDrafts(course.db).filter(d => (d.input.unitId ?? 'KU-001') === unitId), eventCursor: eventCursor(course.db),
    confirmedInputSeq: confirmedInput(course.db, course.sessionId, unitId), editableBlockId: JSON.parse(String(row.payload)).reading.blocks.find((b: any) => b.kind === 'paragraph')?.id ?? unitId, unit: JSON.parse(String(row.payload)),
    runtime: { node: process.versions.node, electron: process.versions.electron,
      sqlite: String(course.db.prepare('SELECT sqlite_version() AS version').get()!.version),
      pragmas: {
        journalMode: String(course.db.prepare('PRAGMA journal_mode').get()!.journal_mode),
        foreignKeys: Number(course.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys),
        synchronous: Number(course.db.prepare('PRAGMA synchronous').get()!.synchronous),
      } } };
}
function open(directory: string): OpenedCourse {
  if (existsSync(join(directory, '课程.json')) && !existsSync(join(directory, 'course.sqlite'))) throw new Error('这是旧版课程，请从停止写入的一致副本转换到新目录');
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
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata'").get() && db.prepare("SELECT 1 FROM metadata WHERE key='content-scope'").get() && !existsSync(join(canonical,'content-candidate.json'))) throw new Error('内容候选缺少完成标记，拒绝打开');
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
    initializeLayout(db);
    const sourceUnit = (id: string) => {
      const row = db!.prepare('SELECT payload FROM units WHERE id=?').get(id);
      if (row) return JSON.parse(String(row.payload));
      if (!db!.prepare("SELECT 1 FROM metadata WHERE key='content-scope'").get() && ['KU-002', 'KU-003', 'KU-004', 'KU-005', 'KU-006', 'KU-035', 'KU-055', 'KU-057', 'KU-062'].includes(id))
        return JSON.parse(readFileSync(join(__dirname, `fixtures/unit-${id.slice(3)}.json`), 'utf8'));
    };
    const storedGraph = db.prepare("SELECT value FROM metadata WHERE key='course-graph'").get();
    const graph = JSON.parse(storedGraph ? String(storedGraph.value) : readFileSync(join(__dirname, 'fixtures/graph.json'), 'utf8')) as CourseGraph;
    initializeReviewState(db);
    const annotations = new Annotations(db);
    let consistency!: CommandConsistency;
    const drawings = new Drawings(db, sourceUnit, annotations, graph);

    const groups = new CommandGroups(db, graph, operationId => {
      exchange.fence('commands:commit', operationId);
      annotations.fence('commands:commit', operationId);
      drawings.fence('commands:commit', operationId);
      sources.fenceOperation('commands:commit', operationId);
      agent.fence('commands:commit', operationId);
      experiments.fenceOperation('commands:commit', operationId);
      extensions.fence('commands:commit', operationId);
    }, sourceUnit, { read: request => consistency.read(request), apply: (...args) => consistency.apply(...args), committed: result => agent.group(result) });
    const sources = new Sources(db, canonical, sourceUnit);
    const storedCatalog = db.prepare("SELECT value FROM metadata WHERE key='relation-catalog'").get();
    const relationCatalog = JSON.parse(storedCatalog ? String(storedCatalog.value) : readFileSync(join(__dirname, 'fixtures/relation-catalog.json'), 'utf8'));
    const relations = new FormalRelations(db, graph, { retiredUnitIds: relationCatalog.retiredUnitIds,
      get sources() { return sources.relationCatalog(relationCatalog.sources); } });
    const experiments = new BuiltinExperiments(db, sourceUnit);
    consistency = new CommandConsistency(db,graph,relations,experiments,sources);
    const extensions = new Extensions(db, canonical);
    const parsing = new Parsing(db, canonical, sources, run => { queue = queue.then(run).catch(error => { console.error(error); }); }, workerData?.parseScheduling);
    const agent = new AgentStore(db, sources, sourceUnit, groups);
    const mutations = new AgentMutations(db,groups,agent,sourceUnit,relations);
    const exchange = new Exchange(db, canonical, graph, () => relations.graph(), () => ({ sources: sources.relationCatalog(relationCatalog.sources), retiredUnitIds: relationCatalog.retiredUnitIds }));
    const readableUnitIds = [...new Set([...db.prepare('SELECT id FROM units').all().map(r => String(r.id)), ...(!db.prepare("SELECT 1 FROM metadata WHERE key='content-scope'").get() ? ['KU-002', 'KU-003', 'KU-004', 'KU-005', 'KU-006', 'KU-035', 'KU-055', 'KU-057', 'KU-062'] : [])])];
    const search = new Search(db, sourceUnit, readableUnitIds, graph.nodes.length, sources);
    const formalHistory=new FormalHistory(db,groups,agent,graph,relations,experiments);
    const course: Course = { retention:new HistoryRetention(db,formalHistory,canonical,id=>groups.protectsBlock(id),workerData?.retentionScheduling), courseRestore:undefined!, formalHistory, views:new LearningViews(db), exchange, db, owner, agent, mutations, search, unit: sourceUnit, annotations, drawings, sessionId: randomUUID(), graph, groups, relations, sources, experiments, extensions, parsing,

      courseId: String(db.prepare("SELECT value FROM metadata WHERE key='courseId'").get()!.value) };
    course.courseRestore=new CourseRestore(db,formalHistory,graph,agent,experiments,extensions,next=>{course.sessionId=next;groups.releaseGeneration();formalHistory.releaseGeneration();},workerData?.restoreScheduling);
    course.retention.installPayloadTracking();
    db.prepare('INSERT INTO course_sessions VALUES(?,?)').run(course.sessionId,Number(db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value));
    const result = snapshot(course);
    courses.set(canonical, course);
    return result;
  } catch (error) { db?.close(); owner.close(); throw error; }
}
function commit(course: Course, command: EditCommand) {
  return commitEdit(course.db, command, (unitId, revision, blockIds) => {
    const changes = course.groups.observe();
    course.agent.studentChanged({ operationId: command.operationId, unitId, revision, objectIds: blockIds });
    return changes;
  });
}
function save(command: SaveParagraph): SaveReceipt {
  if (!command || command.blockId !== EDITABLE) throw new Error('无效的段落保存请求');
  return commit(session(command.sessionId), { sessionId: command.sessionId,
    inputSeq: command.inputSeq, baseRevision: command.baseRevision, operationId: command.operationId,
    complete: true, changes: [{ blockId: command.blockId, text: command.text }] });
}
// Async validation/import shares the SAME ordered command boundary with saves, stop and close.
let queue = Promise.resolve();
const sourceReads = new Set<Promise<void>>();
let draining = false;
parentPort!.on('message', message => {
  if (draining) { parentPort!.postMessage({ id: message.id, ok: false, error: '课程核心正在退出' }); return; }
  if (message.action === 'close') draining = true;
  if (message.action === 'experiments:act') {
    const course = [...courses.values()].find(c => c.sessionId === message.payload?.sessionId);
    try { course?.experiments.stopIssuing(message.payload); } catch { /* Invalid input is rejected by the ordered dispatcher below. */ }
  }
  if (message.action === 'sources:page' || message.action.startsWith('search:')) {
    // Immutable source bytes may parse asynchronously while short core requests continue.
    // Start after prior ordered writes; only close drains these read-only operations.
    queue = queue.then(() => {
      const pending = dispatch(message); sourceReads.add(pending);
      void pending.finally(() => sourceReads.delete(pending));
    });
  } else queue = queue.then(() => dispatch(message));
});
async function dispatch({ id, action, payload }: { id: number; action: string; payload: any }) {
  try {
    if(workerData?.retentionScheduling?.clock)for(const course of courses.values())course.retention.synchronizeClock();
    if(action==='courseRestore:apply' && session(payload.sessionId,action).sessionId!==payload.sessionId && !session(payload.sessionId,action).courseRestore.query(payload.operationId))throw new Error('编辑会话已失效，未执行新的整课恢复，请重新打开核对');
    if (payload?.operationId) {
      const course = session(payload.sessionId,action);
      if(course.db.prepare('SELECT 1 FROM expired_payloads WHERE operation_id=?').get(payload.operationId))throw new Error('这项操作明细已过期清理；原身份保留，不能重新应用，请重新读取当前内容');
      if(action!=='courseRestore:apply'&&!action.endsWith(':query')&&action!=='queryOperation'&&action!=='formalHistory:detail'&&course.db.prepare('SELECT 1 FROM course_restore_requests WHERE id=?').get(payload.operationId))throw new Error('操作身份已用于整课恢复');
      const fencedAction = action === 'commands:resolveInput' ? 'commitEdit' : (action === 'formalHistory:apply'||action === 'courseRestore:apply') ? 'commands:commit' : action;
      course.exchange.fence(fencedAction, payload.operationId);
      course.annotations.fence(fencedAction, payload.operationId);
      course.drawings.fence(fencedAction, payload.operationId);
      course.sources.fenceOperation(fencedAction, payload.operationId);
      course.agent.fence(fencedAction, payload.operationId);
      course.experiments.fenceOperation(fencedAction, payload.operationId);
      course.extensions.fence(fencedAction, payload.operationId);
    }
    let value: unknown;
    if(action.startsWith('retention:')) {const retention=session(payload.sessionId,action).retention;if(action==='retention:get')value=retention.get();else if(action==='retention:set')value=retention.set(payload.days);else if(action==='retention:run')value=retention.run(payload.limit);else if(action==='retention:resourceLease')value=retention.resources.lease(payload.id,payload.action,new Date().toISOString());else if(action==='retention:resourceLeases')value=retention.resources.leases();else if(action==='retention:space')value=retention.storage.space();else if(action==='retention:clearCache')value=retention.storage.clearCache(payload.limit);else throw new Error('未知历史保留接口');}
    else if(action.startsWith('courseRestore:')) {const restore=session(payload.sessionId,action).courseRestore;if(action==='courseRestore:preview')value=restore.preview(payload);else if(action==='courseRestore:apply')value=restore.apply(payload);else if(action==='courseRestore:query')value=restore.query(payload.operationId);else if(action==='courseRestore:drafts')value=restore.drafts();else throw new Error('未知整课恢复接口');}
    else if (action.startsWith('exchange:')) {
      const exchange = session(payload.sessionId,action).exchange;
      if (action === 'exchange:available') value = exchange.available();
      else if (action === 'exchange:exportPackage') value = exchange.exportPackage(payload);
      else if (action === 'exchange:inspect') value = exchange.inspect(payload.directory);
      else if (action === 'exchange:importPackage') { const receipt = await exchange.importPackage(payload); exchange.refresh(); const course = session(payload.sessionId,action); course.search.includeImportedUnits(receipt.unitIds, course.graph.nodes.length); value = receipt; }
      else if (action === 'exchange:query') value = exchange.query(payload.operationId);
      else throw new Error('未知交换接口');
    }
    else if (action === 'migration:snapshot') value = await snapshotLegacy(payload);
    else if (action === 'migration:convert') value = await convertLegacy(payload, workerData?.migrationScheduling);
    else if (action === 'migration:content') value = legacyContent(session(payload.sessionId,action).db);
    else if (action === 'migration:resource') { const c=session(payload.sessionId,action); const directory=[...courses.entries()].find(([,v])=>v===c)![0]; value=candidateResource(c.db,directory,payload.asset); }
    else if(action.startsWith('learningView:')) {const c=session(payload.sessionId,action);if(action==='learningView:open')value=c.views.open(payload.viewId);else {value=c.views.release(payload.viewId,action==='learningView:confirm'||payload.saved);if(action==='learningView:release'){c.groups.dispatch('commands:releaseView',payload);c.groups.recheck(payload.sessionId);}}}
    else if (action === 'agentShutdown') {for(const c of courses.values())c.agent.revokeForQuit();value=[...courses.values()].flatMap(c=>c.agent.prepareShutdown().map(task=>({sessionId:c.sessionId,task})));}
    else if (action === 'open') value = open(payload.directory);
    else if (action === 'read') value = snapshot(session(payload.sessionId,action), payload.unitId);
    else if (action === 'readingState') {
      const row = session(payload.sessionId,action).db.prepare('SELECT payload FROM reading_state WHERE id=1').get();
      value = row ? JSON.parse(String(row.payload)) : null;
    } else if (action === 'setReadingState') {
      const encoded = JSON.stringify(payload.state);
      if (!encoded || encoded.length > 100000) throw new Error('阅读状态无效');
      session(payload.sessionId,action).db.prepare('INSERT INTO reading_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(encoded);
    }
    else if (action === 'setLayout') { const course = session(payload.sessionId,action); saveLayout(course.db, course.graph, payload.updates); }
    else if (action === 'projectLayout') { const course = session(payload.sessionId,action); value = projectLayout(layoutGraph(course.db, course.graph).layout.nodes, payload.sizes, payload.fixed); }
    else if (action === 'reviewStates') { const course = session(payload.sessionId,action); value = reviewSnapshot(course.db, course.graph); }
    else if (action === 'setReviewStatus') { const course = session(payload.sessionId,action); value = transaction(course.db, () => setReviewStatus(course.db, course.graph, payload.unitId, payload.status)); }
    else if (action === 'confirmReviewPrompt') { const course = session(payload.sessionId,action); value = transaction(course.db, () => confirmReviewPrompt(course.db, course.graph, payload.promptId, payload.adjust)); }
    else if (action === 'graph') {
      const course = session(payload.sessionId,action);
      value = layoutGraph(course.db, course.relations.graph());
    } else if (action === 'readUnit') {
      const course = session(payload.sessionId,action);
      value = course.unit(payload.unitId);
      if (!value) throw new Error('该单元不存在或正文尚未加入课程副本');

    }
    else if (action === 'extensions:recoverRenderers') { for(const course of payload?.sessionId?[session(payload.sessionId,action)]:courses.values()) {course.experiments.pauseAll();course.extensions.recoverRenderer();} }
    else if (action.startsWith('extensions:')) {
      const extension = session(payload.sessionId,action).extensions;
      if (action === 'extensions:open') value = await extension.open();
      else if (action === 'extensions:read') value = extension.read();
      else if (action === 'extensions:act') value = await extension.act(payload);
      else if (action === 'extensions:resource') value = extension.resource(payload);
      else throw new Error('未知扩展接口');
    }
    else if (action.startsWith('experiments:')) {
      const experiments = session(payload.sessionId,action).experiments;
      const method = action.slice(12);
      if (method === 'open') value = experiments.open(payload);
      else if (method === 'read') value = experiments.read(payload);
      else if (method === 'snapshot') value = experiments.snapshot(payload);
      else if (method === 'act') value = experiments.act(payload);
      else if (method === 'pauseAll') value = experiments.pauseAll();
      else throw new Error('未知实验接口');
    }
    else if (action === 'saveDraft') value = saveDraft(session(payload.sessionId,action).db, payload);
    else if (action === 'commitEdit') value = commit(session(payload.sessionId,action), payload);
    else if (action === 'queryOperation') value = queryOperation(session(payload.sessionId,action).db, payload.operationId);
    else if (action === 'readEvents') {
      const course = session(payload.sessionId,action);
      value = readEvents(course.db, payload.after, payload.limit) ?? { kind: 'reset', reason: 'cursor-expired',
        cursor: eventCursor(course.db), snapshot: snapshot(course) };
    }
    else if (action.startsWith('formalHistory:')) value = session(payload.sessionId,action).formalHistory.dispatch(action,payload);
    else if (action === 'history') {const c=session(payload.sessionId,action);value=history(c.db).filter(h=>!c.db.prepare('SELECT 1 FROM history_expired WHERE operation_id=?').get(h.receipt.operationId));}
    else if (action === 'save') value = save(payload);
    else if (action === 'relations:prerequisites') value = session(payload.sessionId,action).relations.prerequisites(payload.unitId);
    else if (action === 'relations:read') { const course = session(payload.sessionId,action); const basis = course.relations.read(payload); value = { ...basis, graph: layoutGraph(course.db, basis.graph) }; }
    else if (action === 'relations:commit') value = session(payload.sessionId,action).relations.commit(payload);
    else if (action === 'relations:query') value = session(payload.sessionId,action).relations.query(payload.operationId);
    else if (action === 'commands:resolveInput') { const c = session(payload.sessionId,action); value = resolveInput(c.db, payload, () => c.groups.observe()); }
    else if (action.startsWith('commands:')) value = session(payload.sessionId,action).groups.dispatch(action, payload);
    else if (action.startsWith('drawings:')) value = session(payload.sessionId,action).drawings.dispatch(action, payload);
    else if (action.startsWith('search:')) value = await session(payload.sessionId,action).search.dispatch(action, payload);
    else if (action.startsWith('annotations:')) value = session(payload.sessionId,action).annotations.dispatch(action, payload);
    else if (action.startsWith('agentMutation:')) { const m=session(payload.sessionId,action).mutations; value=action==='agentMutation:read'?m.read(payload):action==='agentMutation:apply'?m.apply(payload):m.query(payload); }
    else if (action.startsWith('agent:')) value = session(payload.sessionId,action).agent.dispatch(action, payload);
    else if (action.startsWith('parsing:')) value = await session(payload.sessionId,action).parsing.dispatch(action, payload);
    else if (action.startsWith('sources:')) value = await session(payload.sessionId,action).sources.dispatch(action, payload);
    else if (action === 'close') {
      await Promise.all(sourceReads);
      for (const course of courses.values()) { course.retention.stop();course.experiments.dispose(); await course.parsing.close(); course.db.close(); course.owner.close(); }
      courses.clear();
    } else throw new Error('未知课程命令');
    parentPort!.postMessage({ id, ok: true, value });
    for(const course of courses.values())course.retention.onActivity(run=>{queue=queue.then(()=>{if(!draining)run();}).catch(error=>console.error('Retention maintenance:',error));});
  } catch (error) { parentPort!.postMessage({ id, ok: false, error: (error as Error).message }); }
}
