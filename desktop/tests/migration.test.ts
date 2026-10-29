import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DevelopmentCourseService as CourseService } from '../../tools/desktop/course-service';
import { legacyFixture } from './migration-fixture';

test('a stopped legacy copy converts every persisted unit and opaque material, then reopens independently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-migrate-'));
  let core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source = join(root, 'source'), candidate = join(root, 'candidate'), moved = join(root, '独立 中文 path');
    const original = await legacyFixture(source);
    const report = await core.migration.convert({ sourceDirectory: source, directory: candidate });
    assert.equal(report.scope, 'content-candidate');
    assert.deepEqual(report.counts, { themes: 2, units: 2, answerableQuestions: 1, questionRecords: 2, mappings: 1, relations: 0 });
    const opened = await core.open(candidate);
    assert.equal(opened.courseId, 'COURSE-FIXTURE');
    assert.deepEqual((await core.migration.content({ sessionId: opened.sessionId })).knowledge, original.knowledge);
    assert.deepEqual((await core.readUnit(opened.sessionId, 'KU-086')).reading, original.last.reading);
    assert.equal((await core.readUnit(opened.sessionId, 'KU-086')).theme.id, 'TH-20');
    await assert.rejects(core.readUnit(opened.sessionId, 'KU-049'), /不存在/);
    assert.equal((await core.graph(opened.sessionId)).nodes.length, 2);
    assert.ok(report.gaps.some(gap => gap.includes('99') && gap.includes('2')));
    assert.match((await core.sources.page({ sessionId: opened.sessionId, versionId: 'VER-TEST', pdfPageIndex: 0 })).projection.text, /Fixed legacy source/);
    await core.close();
    await rename(candidate, moved); await rm(source, { recursive: true });
    core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
    const reopened = await core.open(moved);
    assert.deepEqual((await core.readUnit(reopened.sessionId, 'KU-086')).reading, original.last.reading);
    assert.match((await core.sources.page({ sessionId: reopened.sessionId, versionId: 'VER-TEST', pdfPageIndex: 0 })).projection.text, /Fixed legacy source/);
    const asset = await core.resources.read({ sessionId: reopened.sessionId, asset: '/source-pages/SRC-TEST/VER-TEST/1.png' });
    assert.equal(asset.mediaType, 'image/png'); assert.ok(asset.bytes.length > 500);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('active legacy service/content and SQLite writers reject conversion without publishing or changing the source', async () => {
  const { spawn } = await import('node:child_process');
  const { readFile, readdir } = await import('node:fs/promises');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-migrate-lock-'));
  const core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source = join(root, 'source'); await legacyFixture(source);
    const original = await readFile(join(source, 'data/map.json'));
    for (const file of ['.review-board/service.lock', 'data/map.json.content.lock']) {
      const holder = spawn('python3', ['-c', 'import fcntl,sys; h=open(sys.argv[1],"rb"); fcntl.flock(h,fcntl.LOCK_EX); print("locked",flush=True);sys.stdin.read()', join(source,file)], { stdio: ['pipe','pipe','pipe'] });
      await new Promise(resolve => holder.stdout.once('data',resolve));
      try { await assert.rejects(core.migration.convert({ sourceDirectory: source, directory: join(root, 'candidate') }), /活动写入者/); }
      finally { holder.stdin.end(); await new Promise(resolve => holder.once('exit',resolve)); }
    }
    const writer = new DatabaseSync(join(source, '.review-board/state.sqlite3'));
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE record(value TEXT); BEGIN IMMEDIATE; INSERT INTO record VALUES ('latest')");
    try { await assert.rejects(core.migration.convert({ sourceDirectory: source, directory: join(root, 'candidate') }), /活动写入事务/); }
    finally { writer.exec('ROLLBACK'); writer.close(); }
    assert.deepEqual(await readFile(join(source,'data/map.json')), original);
    assert.deepEqual((await readdir(root)).sort(), ['source']);
  } finally { await core.close(); await rm(root, {recursive:true,force:true}); }
});

test('consistent stopped copy includes committed WAL state and registered bytes, excludes live runtime, leaves source byte-identical', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-stopped-copy-'));
  const core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source = join(root, 'source'), copy = join(root, 'copy'); await legacyFixture(source);
    const state = new DatabaseSync(join(source, '.review-board/state.sqlite3'));
    state.exec("PRAGMA journal_mode=WAL; CREATE TABLE documents(value TEXT); INSERT INTO documents VALUES ('latest confirmed input')");
    await writeFile(join(source,'.review-board/runtime.json'), '{"url":"http://127.0.0.1:8769/"}');
    const before = await readFile(join(source,'data/map.json'));
    const receipt = await core.migration.snapshot({sourceDirectory:source,directory:copy});
    assert.ok(receipt.files['.review-board/state.sqlite3']);
    assert.deepEqual(await readFile(join(copy,'data/map.json')),before);
    assert.deepEqual(await readFile(join(source,'data/map.json')),before);
    await assert.rejects(readFile(join(copy,'.review-board/runtime.json')),/ENOENT/);
    const saved = new DatabaseSync(join(copy,'.review-board/state.sqlite3'),{readOnly:true});
    assert.equal(saved.prepare('SELECT value FROM documents').get()!.value,'latest confirmed input'); saved.close(); state.close();
    const report = await core.migration.convert({sourceDirectory:copy,directory:join(root,'candidate')});
    assert.equal(report.counts.units,2);
    await assert.rejects(core.migration.snapshot({sourceDirectory:source,directory:copy}),/全新目录/);
  } finally { await core.close(); await rm(root,{recursive:true,force:true}); }
});

test('answerable questions are stable leaf records, including legacy stems kept only in reading material', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-migrate-questions-'));
  const core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source = join(root,'source'); await legacyFixture(source);
    const knowledge = JSON.parse(await readFile(join(source,'data/map.json'),'utf8'));
    knowledge.questions.push({id:'Q-SUMMARY',taskSummary:'旧版在正文中展开的小问'});
    await writeFile(join(source,'data/map.json'),JSON.stringify(knowledge));
    const report = await core.migration.convert({sourceDirectory:source,directory:join(root,'candidate')});
    assert.equal(report.counts.answerableQuestions,2);
  } finally { await core.close(); await rm(root,{recursive:true,force:true}); }
});

test('real SQLite failure during registration rolls back all units/resources and retry reopens a complete candidate', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(),'yizhi-migration-rollback-'));
  const gate = new SharedArrayBuffer(4), signal = new Int32Array(gate);
  const core = new CourseService(join(developmentDirectory(), 'worker.cjs'), { migrationScheduling: { beforeRegistration: gate } });
  try {
    const source=join(root,'source'),target=join(root,'candidate');await legacyFixture(source);
    const pending=core.migration.convert({sourceDirectory:source,directory:target});
    const outcome=pending.then(()=>null,error=>error);
    await new Promise<void>((resolve,reject)=>{
      const deadline=setTimeout(()=>{clearInterval(timer);reject(new Error('registration gate not reached'));},10000);
      const timer=setInterval(()=>{if(Atomics.load(signal,0)===1){clearTimeout(deadline);clearInterval(timer);resolve();}},10);
    });
    const stage=(await readdir(root)).find(name=>name.startsWith('candidate.converting-'))!;
    const fault=new DatabaseSync(join(root,stage,'course.sqlite'));
    fault.exec("CREATE TRIGGER reject_registration BEFORE INSERT ON metadata BEGIN SELECT RAISE(ABORT,'real candidate disk registration failed'); END");fault.close();
    Atomics.store(signal,0,2);Atomics.notify(signal,0);
    assert.match(String(await outcome),/real candidate disk registration failed/);
    assert.deepEqual(await readdir(root),['source']);
    const report=await core.migration.convert({sourceDirectory:source,directory:target});
    assert.equal(report.counts.units,2);
    const opened=await core.open(target);
    assert.equal((await core.readUnit(opened.sessionId,'KU-086')).name,'持久化末单元');
    assert.deepEqual(await core.history(opened.sessionId),[]);
    assert.equal(opened.eventCursor,0);
  } finally {Atomics.store(signal,0,2);Atomics.notify(signal,0);await core.close();await rm(root,{recursive:true,force:true});}
});

test('the persisted eight-input legacy MUX computes all 2048 finite rows without changing its original definition', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'yizhi-migration-eight-'));const core=new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source=join(root,'source'),target=join(root,'candidate');await legacyFixture(source);
    const knowledge=JSON.parse(await readFile(join(source,'data/map.json'),'utf8'));
    const payload={component:'mux',config:{selectBits:['A','B','C'],dataSignals:['D0','D1','D2','D3','D4','D5','D6','D7']},inputs:{A:0,B:1,C:0,D0:0,D1:1,D2:0,D3:0,D4:1,D5:1,D6:0,D7:1}};
    knowledge.units[1].reading.blocks.push({id:'eight-mux',kind:'interactive',payload});
    await writeFile(join(source,'data/map.json'),JSON.stringify(knowledge));
    await core.migration.convert({sourceDirectory:source,directory:target});const opened=await core.open(target);
    const v=await core.experiments.open({sessionId:opened.sessionId,unitId:'KU-086',blockId:'eight-mux'});
    for(let selected=0;selected<8;selected++)for(let data=0;data<256;data++) {
      const inputs={A:selected>>2,B:(selected>>1)&1,C:selected&1,...Object.fromEntries(Array.from({length:8},(_,i)=>['D'+i,(data>>i)&1]))};
      const result=await core.experiments.act({sessionId:opened.sessionId,instanceId:v.instanceId,generation:v.generation,operationId:`row-${selected}-${data}`,action:{kind:'inputs',inputs}});
      assert.equal(result.result!.output,(data>>selected)&1);
    }
    assert.deepEqual((await core.readUnit(opened.sessionId,'KU-086')).reading.blocks.at(-1)!.payload,payload);
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});

test('missing or changed real resources never publish a candidate or modify legacy content; corrupted candidate images fail closed on reopen', async () => {
  const { readFile, writeFile, readdir } = await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'yizhi-migration-io-'));let core=new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source=join(root,'source'),target=join(root,'candidate');await legacyFixture(source);
    const original=await readFile(join(source,'data/map.json')),pdf=await readFile(join(source,'原始 资料.pdf'));
    await writeFile(join(source,'原始 资料.pdf'),'broken fixed version');
    await assert.rejects(core.migration.convert({sourceDirectory:source,directory:target}),/哈希不同/);
    assert.deepEqual(await readdir(root),['source']);assert.deepEqual(await readFile(join(source,'data/map.json')),original);
    await writeFile(join(source,'原始 资料.pdf'),pdf);
    const report=await core.migration.convert({sourceDirectory:source,directory:target});
    const image=report.resources.find(r=>r.mediaType==='image/png')!;
    await writeFile(join(target,image.path),'corrupt image bytes');
    await core.close();core=new CourseService(join(developmentDirectory(), 'worker.cjs'));const reopened=await core.open(target);
    await assert.rejects(core.resources.read({sessionId:reopened.sessionId,asset:image.asset}),/损坏|缺失/);
    assert.equal((await core.readUnit(reopened.sessionId,'KU-086')).reading.blocks[0].payload.text,'末单元完整正文');
    await assert.rejects(core.resources.read({sessionId:reopened.sessionId,asset:'../../unregistered'}),/未登记/);
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});

test('fixed references and layout identities are checked before a candidate can be published', async () => {
  const {readFile,writeFile,readdir}=await import('node:fs/promises');
  const root=await mkdtemp(join(tmpdir(),'yizhi-migration-refs-'));const core=new CourseService(join(developmentDirectory(), 'worker.cjs'));
  try {
    const source=join(root,'source'),target=join(root,'candidate');await legacyFixture(source);
    const path=join(source,'data/map.json'),knowledge=JSON.parse(await readFile(path,'utf8'));
    knowledge.units[1].reading.blocks[0].sourceRefs=[{sourceId:'SRC-TEST',versionId:'VER-NOT-REGISTERED',pdfPages:[1]}];
    await writeFile(path,JSON.stringify(knowledge));
    await assert.rejects(core.migration.convert({sourceDirectory:source,directory:target}),/固定来源版本不存在/);
    assert.deepEqual(await readdir(root),['source']);
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});
