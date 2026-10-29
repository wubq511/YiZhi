import { initializeMigrationHistory,migratedHistory,migratedOperation } from './migration-history';
import { migrationRecords,initializeMigrationRecords } from './migration-state';
import { prepareDirectory,publishDirectory,directoryStatus,recoverDirectory,admitDirectory,closeDirectoryLeases,abandonDirectory,directoryTransition } from './directory-authority';
import { importPersonal,importPersonalRecords } from './migration-personal';
import { FormalHistory } from './formal-history';
import { CourseBackups } from './backup';
import { CourseUpgrades,type UpgradeSource } from './upgrade';
import { assertWritableFormat,inspectFormat,readUnderstoodUnit } from './course-format';
import { claimPortableIdentity } from './course-identity';
import { validateCourseCopy } from './course-validation';
import { registerRetentionResourceRoot } from './retention-resources';
import { generationRetentionResourceRoot,generationRetentionResourceRoots } from './generation-retention';
import { HistoryRetention } from './retention';
import { CourseRestore } from './course-restore';
import { LearningViews } from './learning-views';
import { AgentMutations } from './agent-mutations';
import { Generation } from './generation';
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
import { parentPort, workerData, threadId } from 'node:worker_threads';
import { observation } from '../acceptance-observation';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join,basename } from 'node:path';
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

registerRetentionResourceRoot('t30-generation-recovery',generationRetentionResourceRoot,generationRetentionResourceRoots);
if (workerData?.observe) observation.enable();
const observedInstanceId = randomUUID();
const queuedObservation = observation.resource('core.queued');
let observedQueued = 0;

const EDITABLE = 'RB-TH-01-01-what-is-positional-notation';
interface Course { db: DatabaseSync; owner: DatabaseSync; sessionId: string; courseId: string; graph: CourseGraph;
  identityOwner?:DatabaseSync;
  upgradeFrozen?:boolean;
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
  generation: Generation;
}
const courses = new Map<string, Course>();
const backups=new CourseBackups(workerData?.backupScheduling);
const upgrades=new CourseUpgrades(backups,workerData?.upgradeScheduling,workerData?.cutoverScheduling);
const historicalRoutes=new Set(['courseRestore:apply','courseRestore:query','queryOperation','commands:query','commands:history','formalHistory:query','formalHistory:release','formalHistory:detail','formalHistory:list','relations:query','annotations:query','drawings:query','drawings:queryPlacement','sources:query','parsing:query','agent:record','agent:task','agent:facts','agent:stop','agent:get','agent:list','agent:events','agent:work','agentMutation:query','generation:query','generation:candidates']);
function session(id: string,action?:string): Course {
  const course = [...courses.values()].find(course => course.sessionId === id || action&&historicalRoutes.has(action)&&!!course.db.prepare('SELECT 1 FROM course_sessions WHERE id=?').get(id));
  if (!course) throw new Error('编辑会话已失效，请重新打开课程');
  if(course.upgradeFrozen&&!action?.startsWith('upgrade:'))throw new Error('该课程正在升级，已停止写入和新任务；其他课程可继续使用');
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
  return { courseFormat:Number(course.db.prepare('PRAGMA user_version').get()!.user_version),resourceAssets: course.db.prepare('SELECT asset FROM exchange_resources ORDER BY asset').all().map(r => String(r.asset)), contentScope: course.db.prepare("SELECT value FROM metadata WHERE key='content-scope'").get()?.value === 'content-candidate' ? 'content-candidate' : undefined, courseId: course.courseId, sessionId: course.sessionId, generation:Number(course.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value), preservedDraftCount:course.courseRestore.drafts().length, revision: Number(row.revision),
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
function open(directory: string,preparing=false): OpenedCourse {
  if(/\.backup-starting-[\w-]+$/.test(basename(directory)))throw new Error('备份初始化未完成，拒绝打开');
  if(existsSync(join(directory,'backup-manifest.json'))&&!existsSync(join(directory,'backup-complete.json')))throw new Error('备份未完成，拒绝打开');
  if (existsSync(join(directory, '课程.json')) && !existsSync(join(directory, 'course.sqlite'))) throw new Error('这是旧版课程，请从停止写入的一致副本转换到新目录');
  mkdirSync(directory, { recursive: true });
  const canonical = realpathSync(directory);
  if(!preparing)admitDirectory(canonical);
  const existing = courses.get(canonical);
  if (existing) {if(existing.upgradeFrozen)throw new Error('该课程正在升级，已停写');return snapshot(existing);}
  if(existsSync(join(canonical,'course.sqlite')))assertWritableFormat(canonical);
  // A separate DB holds an OS-backed exclusive transaction for the entire session.
  // It survives window closure and is released by SQLite on process death; no stale PID lock.
  const owner = new DatabaseSync(join(canonical, 'ownership.sqlite'));
  let db: DatabaseSync | undefined;
  let identityOwner:DatabaseSync|undefined;
  try {
    owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  } catch {
    owner.close();
    throw new Error('课程已由另一应用进程打开，不能取得第二份写入资格');
  }
  try {
    if(existsSync(join(canonical,'course.sqlite'))){
      const inspect=new DatabaseSync(join(canonical,'course.sqlite'),{readOnly:true});
      try{if(inspect.prepare("SELECT 1 FROM metadata WHERE key='portable-identity'").get())identityOwner=claimPortableIdentity(String(inspect.prepare("SELECT value FROM metadata WHERE key='courseId'").get()!.value));}finally{inspect.close();}
    }
    db = new DatabaseSync(join(canonical, 'course.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 1 && version !== 2) throw new Error('不支持的课程格式，拒绝写入');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='metadata'").get() && db.prepare("SELECT 1 FROM metadata WHERE key='content-scope'").get() && !existsSync(join(canonical,'content-candidate.json'))) throw new Error('内容候选缺少完成标记，拒绝打开');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES units(id), before_text TEXT NOT NULL, after_text TEXT NOT NULL);
      PRAGMA user_version=${version||1}; COMMIT;`);
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
    const sources = new Sources(db, canonical, sourceUnit,workerData?.sourceScheduling,command=>{session(command.sessionId,'sources:importFile');fenceRequest('sources:importFile',command);});
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
    const generation = new Generation(db,graph,sources,parsing,agent,groups,search);
    const formalHistory=new FormalHistory(db,groups,agent,graph,relations,experiments);
    const course: Course = { identityOwner,retention:new HistoryRetention(db,formalHistory,canonical,id=>groups.protectsBlock(id),workerData?.retentionScheduling), courseRestore:undefined!, formalHistory, views:new LearningViews(db), exchange, db, owner, agent, mutations, generation, search, unit: sourceUnit, annotations, drawings, sessionId: randomUUID(), graph, groups, relations, sources, experiments, extensions, parsing,

      courseId: String(db.prepare("SELECT value FROM metadata WHERE key='courseId'").get()!.value) };
    course.courseRestore=new CourseRestore(db,formalHistory,graph,agent,experiments,extensions,next=>{course.sessionId=next;groups.releaseGeneration();formalHistory.releaseGeneration();},workerData?.restoreScheduling);
    initializeMigrationHistory(db);initializeMigrationRecords(db);course.retention.installPayloadTracking();
    db.prepare('INSERT INTO course_sessions VALUES(?,?)').run(course.sessionId,Number(db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value));
    const result = snapshot(course);
    courses.set(canonical, course);
    return result;
  } catch (error) { db?.close();identityOwner?.close(); owner.close(); throw error; }
}
function commit(course: Course, command: EditCommand) {
  const publications:Array<()=>void>=[];
  const receipt=commitEdit(course.db, command, (unitId, revision, blockIds) => {
    const changes = course.groups.observe();
    course.agent.studentChanged({ operationId: command.operationId, unitId, revision, objectIds: blockIds });
    return changes;
  },(before,after)=>{const prepared=course.experiments.prepareStudentEdit(before,after);publications.push(prepared.publish);return prepared.changes;});
  for(const publish of publications)publish();return receipt;
}
function save(command: SaveParagraph): SaveReceipt {
  if (!command || command.blockId !== EDITABLE) throw new Error('无效的段落保存请求');
  return commit(session(command.sessionId), { sessionId: command.sessionId,
    inputSeq: command.inputSeq, baseRevision: command.baseRevision, operationId: command.operationId,
    complete: true, changes: [{ blockId: command.blockId, text: command.text }] });
}
function acquireBackup(c:Course,id:string,directory:string){
 c.identityOwner??=claimPortableIdentity(c.courseId);
 transaction(c.db,()=>{
  c.db.exec('CREATE TABLE IF NOT EXISTS backup_jobs(id TEXT PRIMARY KEY,directory TEXT NOT NULL)');
  const old=c.db.prepare('SELECT directory FROM backup_jobs WHERE id=?').get(id),canonical=realpathSync(directory);
  if(old&&old.directory!==canonical)throw new Error('备份身份已用于另一目录，请使用原目录重试');
  c.db.prepare('INSERT OR IGNORE INTO backup_jobs VALUES(?,?)').run(id,canonical);
  c.db.prepare("INSERT OR IGNORE INTO metadata VALUES('portable-identity','1')").run();
  c.retention.resources.lease('backup:'+id,'acquire',new Date().toISOString());
 });
}
function releaseBackup(c:Course,id:string){c.retention.resources.lease('backup:'+id,'release',new Date().toISOString());}
async function releaseCourse(directory:string,c:Course){
 c.retention.stop();c.experiments.dispose();await c.parsing.close();c.db.close();c.owner.close();c.identityOwner?.close();courses.delete(directory);
}
function upgradeSource(c:Course,directory:string):UpgradeSource{
 const preceding=[...sourceReads];
 return {directory,courseId:c.courseId,
  async pause(){
   c.upgradeFrozen=true;c.retention.stop();c.experiments.pauseAll();c.experiments.dispose();c.agent.revokeForQuit();c.agent.prepareShutdown();
   await Promise.all(preceding);await c.parsing.close();await queue;
  },
  async release(){await releaseCourse(directory,c);},
  async resume(){await releaseCourse(directory,c);open(directory);},
  acquireBackup:(id,target)=>acquireBackup(c,id,target),releaseBackup:id=>releaseBackup(c,id),
 };
}
// Staging yields outside the ordered command queue; synchronous commits recheck current authority.
let queue = Promise.resolve();
const sourceReads = new Set<Promise<void>>();
let draining = false;
parentPort!.on('message', message => {
  if (draining) { parentPort!.postMessage({ id: message.id, ok: false, error: '课程核心正在退出' }); return; }
  if (message.action === 'close') draining = true;
  queuedObservation.set(++observedQueued);
  if (message.action === 'experiments:act') {
    const course = [...courses.values()].find(c => c.sessionId === message.payload?.sessionId);
    try { course?.experiments.stopIssuing(message.payload); } catch { /* Invalid input is rejected by the ordered dispatcher below. */ }
  }
  if (message.action === 'sources:importFile' || message.action === 'sources:repairFile' || message.action === 'sources:page' || message.action.startsWith('search:') || message.action.startsWith('backup:') || message.action.startsWith('format:') || message.action.startsWith('upgrade:') || message.action==='migration:prepare' || message.action==='migration:publish' || message.action==='migration:convert' || message.action==='migration:snapshot') {
    // Independent file staging and immutable parsing yield while other courses save.
    // Start after prior ordered writes; close drains every pending stage/lease.
    queue = queue.then(() => {
      const pending = dispatch(message); sourceReads.add(pending);
      void pending.finally(() => sourceReads.delete(pending));
    });
  } else queue = queue.then(() => dispatch(message));
});
function fenceRequest(action:string,payload:any) {
  if (payload?.operationId && payload.sessionId) {
      const course = session(payload.sessionId,action);
      if(course.db.prepare('SELECT 1 FROM expired_payloads WHERE operation_id=?').get(payload.operationId))throw new Error('这项操作明细已过期清理；原身份保留，不能重新应用，请重新读取当前内容');
      if(action!=='courseRestore:apply'&&!action.endsWith(':query')&&action!=='queryOperation'&&action!=='formalHistory:detail'&&course.db.prepare('SELECT 1 FROM course_restore_requests WHERE id=?').get(payload.operationId))throw new Error('操作身份已用于整课恢复');
      if(!action.startsWith('migration:')&&action!=='formalHistory:detail'&&!action.endsWith(':query')&&action!=='queryOperation'&&course.db.prepare('SELECT 1 FROM migration_receipts WHERE id=?').get(payload.operationId))throw new Error('旧版操作身份已迁移，仅可查询原收据，不能作为新操作执行');
      const fencedAction = action === 'commands:resolveInput' ? 'commitEdit' : (action === 'formalHistory:apply'||action === 'courseRestore:apply') ? 'commands:commit' : action;
      course.exchange.fence(fencedAction, payload.operationId);
      course.annotations.fence(fencedAction, payload.operationId);
      course.drawings.fence(fencedAction, payload.operationId);
      course.sources.fenceOperation(fencedAction, payload.operationId);
      course.agent.fence(fencedAction, payload.operationId);
      course.experiments.fenceOperation(fencedAction, payload.operationId);
      course.extensions.fence(fencedAction, payload.operationId);
    }
}
async function dispatch({ id, action, payload }: { id: number; action: string; payload: any }) {
  queuedObservation.set(--observedQueued);
  const started = performance.now(), activeObservation = observation.resource('core.active');
  activeObservation.set(1);
  try {
    if(workerData?.retentionScheduling?.clock)for(const course of courses.values())if(!course.upgradeFrozen)course.retention.synchronizeClock();
    if(action==='courseRestore:apply' && session(payload.sessionId,action).sessionId!==payload.sessionId && !session(payload.sessionId,action).courseRestore.query(payload.operationId))throw new Error('编辑会话已失效，未执行新的整课恢复，请重新打开核对');
    fenceRequest(action,payload);
    let value: unknown;
    if(action==='upgrade:status')value=upgrades.status(payload.directory);
    else if(action==='upgrade:recover')value=await upgrades.recover(payload.directory);
    else if(action==='upgrade:publish'){
      const c=payload.sessionId?[...courses.values()].find(c=>c.sessionId===payload.sessionId):undefined;
      const directory=c?[...courses.entries()].find(([,v])=>v===c)![0]:payload.sourceDirectory;
      if(!directory)throw new Error('请重新打开原课程核对升级资格');value=await upgrades.publish(directory,payload.upgradeId,c?upgradeSource(c,directory):undefined);
    }
    else if(action==='upgrade:cancel'){
      const c=session(payload.sessionId,action),directory=[...courses.entries()].find(([,v])=>v===c)![0];value=await upgrades.cancel(directory,payload.upgradeId,upgradeSource(c,directory));
    }
    else if(action==='upgrade:prepare'){
      const c=session(payload.sessionId,action),directory=[...courses.entries()].find(([,v])=>v===c)![0];value=await upgrades.prepare(payload,upgradeSource(c,directory));
    }
    else if(action==='format:inspect')value=inspectFormat(payload.directory);
    else if(action==='format:validate')value=await validateCourseCopy(payload.directory);
    else if(action==='format:readUnit')value=readUnderstoodUnit(payload.directory,payload.unitId);
    else if(action.startsWith('backup:')) {
      if(action==='backup:status')value=await backups.status(payload.directory);
      else if(action==='backup:verify')value=await backups.verify(payload.directory);
      else if(action==='backup:create'||action==='backup:resume'){
        const c=session(payload.sessionId,action),directory=[...courses.entries()].find(([,v])=>v===c)![0];
        value=await backups.create(payload,{directory,courseId:c.courseId,acquire:()=>acquireBackup(c,payload.backupId,payload.directory),release:()=>releaseBackup(c,payload.backupId)},action==='backup:resume');
      }else throw new Error('未知备份接口');
    }
    else if(action.startsWith('retention:')) {const retention=session(payload.sessionId,action).retention;if(action==='retention:get')value=retention.get();else if(action==='retention:set')value=retention.set(payload.days);else if(action==='retention:run')value=retention.run(payload.limit);else if(action==='retention:resourceLease')value=retention.resources.lease(payload.id,payload.action,new Date().toISOString());else if(action==='retention:resourceLeases')value=retention.resources.leases();else if(action==='retention:space')value=retention.storage.space();else if(action==='retention:clearCache')value=retention.storage.clearCache(payload.limit);else throw new Error('未知历史保留接口');}
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
    else if(action==='migration:prepare')value=await prepareDirectory(payload,async(directory,source)=>{
      const opened=open(directory,true),key=realpathSync(directory),course=courses.get(key)!;
      try{return importPersonalRecords(course.db,source);}
      finally{course.retention.stop();course.experiments.dispose();await course.parsing.close();course.db.close();course.owner.close();courses.delete(key);}
    });
    else if(action==='migration:publish')value=await publishDirectory(payload,workerData?.cutoverScheduling);
    else if(action==='migration:abandon')value=await abandonDirectory(payload);
    else if(action==='migration:transition')value=directoryTransition(payload);
    else if(action==='migration:status')value=directoryStatus(payload.directory);
    else if(action==='migration:recover')value=recoverDirectory(payload.directory);
    else if(action==='migration:history')value=migratedHistory(session(payload.sessionId,action).db,payload);
    else if(action==='migration:operation')value=migratedOperation(session(payload.sessionId,action).db,payload.operationId);
    else if(action==='migration:pending'){const db=session(payload.sessionId,action).db;value=db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_pending'").get()?db.prepare('SELECT * FROM migration_pending ORDER BY id').all().map(r=>({id:r.id,namespace:r.namespace,key:r.record_key,purpose:r.purpose,state:r.state,payload:r.payload?JSON.parse(String(r.payload)):null,createdAt:r.created_at})):[];}
    else if (action === 'migration:records')value=migrationRecords(session(payload.sessionId,action).db,payload);
    else if (action === 'migration:personal') value=await importPersonal(session(payload.sessionId,action).db,payload.sourceDirectory);
    else if (action === 'migration:snapshot') value = await snapshotLegacy(payload);
    else if (action === 'migration:convert') value = await convertLegacy(payload, workerData?.migrationScheduling);
    else if (action === 'migration:content') value = legacyContent(session(payload.sessionId,action).db);
    else if (action === 'migration:resource') { const c=session(payload.sessionId,action); const directory=[...courses.entries()].find(([,v])=>v===c)![0]; value=candidateResource(c.db,directory,payload.asset); }
    else if(action.startsWith('learningView:')) {const c=session(payload.sessionId,action);if(action==='learningView:open')value=c.views.open(payload.viewId);else {value=c.views.release(payload.viewId,action==='learningView:confirm'||payload.saved);if(action==='learningView:release'){c.groups.dispatch('commands:releaseView',payload);c.groups.recheck(payload.sessionId);}}}
    else if (action === 'agentShutdown') {for(const c of courses.values())c.agent.revokeForQuit();value=[...courses.values()].flatMap(c=>c.agent.prepareShutdown().map(task=>({sessionId:c.sessionId,task})));}
    else if (action === 'acceptance:observe') {
      if (!workerData?.observe) throw new Error('Acceptance observation is not enabled');
      value = { instanceId: observedInstanceId, threadId, courseIds: [...courses.values()].map(c => c.courseId),
        memory: process.memoryUsage(), counters: observation.snapshot() };
    }
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
    else if (action === 'commands:resolveInput') { const c = session(payload.sessionId,action); const publications:Array<()=>void>=[];value = resolveInput(c.db, payload, () => c.groups.observe(),(before,after)=>{const prepared=c.experiments.prepareStudentEdit(before,after);publications.push(prepared.publish);return prepared.changes;});for(const publish of publications)publish(); }
    else if (action.startsWith('commands:')) value = session(payload.sessionId,action).groups.dispatch(action, payload);
    else if (action.startsWith('drawings:')) value = session(payload.sessionId,action).drawings.dispatch(action, payload);
    else if (action.startsWith('search:')) value = await session(payload.sessionId,action).search.dispatch(action, payload);
    else if (action.startsWith('annotations:')) value = session(payload.sessionId,action).annotations.dispatch(action, payload);
    else if (action.startsWith('agentMutation:')) { const m=session(payload.sessionId,action).mutations; value=action==='agentMutation:read'?m.read(payload):action==='agentMutation:apply'?m.apply(payload):m.query(payload); }
    else if (action.startsWith('generation:')) { const g=session(payload.sessionId,action).generation;
      if(action==='generation:read')value=g.read(payload);
      else if(action==='generation:publish')value=g.publish(payload);
      else if(action==='generation:query')value=g.query(payload);
      else if(action==='generation:candidates')value=g.candidates(payload.taskId);
      else throw new Error('未知生成接口'); }
    else if (action.startsWith('agent:')) value = session(payload.sessionId,action).agent.dispatch(action, payload);
    else if (action.startsWith('parsing:')) value = await session(payload.sessionId,action).parsing.dispatch(action, payload);
    else if (action.startsWith('sources:')) value = await session(payload.sessionId,action).sources.dispatch(action, payload);
    else if (action === 'close') {
      await Promise.all(sourceReads);await closeDirectoryLeases();
      for (const course of courses.values()) { course.retention.stop();course.experiments.dispose(); await course.parsing.close(); course.db.close(); course.owner.close();course.identityOwner?.close(); }
      courses.clear();
    } else throw new Error('未知课程命令');
    parentPort!.postMessage({ id, ok: true, value });
    if (action !== 'acceptance:observe') for(const course of courses.values())course.retention.onActivity(run=>{queue=queue.then(()=>{if(!draining)run();}).catch(error=>console.error('Retention maintenance:',error));});
  } catch (error) { parentPort!.postMessage({ id, ok: false, error: (error as Error).message }); }
  finally { activeObservation.close(); observation.sample(`core.request.${action}.ms`, performance.now() - started); }
}
