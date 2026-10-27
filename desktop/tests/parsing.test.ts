import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { parsingFixture } from './parsing-fixture';

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 20000;
  for (;;) { const value = await read(); if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Unexpected task state: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 15)); }
}
test('actual tagged PDF parsing retains table, formula, image, hierarchy and original coordinates without changing the board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-parse-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const path = join(root, 'tagged.pdf'); await parsingFixture(path);
    const opened = await service.open(join(root, 'course')); const sessionId = opened.sessionId;
    const source = (await service.sources.importFile({ sessionId, generation: 1, operationId: 'import', path, title: 'Logic notes' })).version;
    const request = { sessionId, generation: 1, operationId: 'parse', versionId: source.versionId };
    const task = await service.parsing.start(request);
    const done = await until(() => service.parsing.get({ sessionId, taskId: task.taskId }), t => t.status !== 'running');
    assert.equal(done.status, 'completed', JSON.stringify(done)); assert.equal(done.confirmed.length, 2);
    const artifact = await service.parsing.artifact({ sessionId, artifactId: done.confirmed[0].artifactId });
    assert.equal(artifact.source.sha256, source.sha256); assert.equal(artifact.pdfPageIndex, 0);
    assert.equal(artifact.coordinateSpace, 'pdf-user-space');
    assert.ok(artifact.text.some(t => t.text === 'Logic notes' && t.bounds[0] === 30));
    assert.match(JSON.stringify(artifact.structure), /"role":"Table"/);
    assert.match(JSON.stringify(artifact.structure), /"role":"Formula"/);
    assert.match(JSON.stringify(artifact.structure), /"role":"H1"/);
    const figures=(node: any):any[]=>[...(node?.role==='Figure'?[node]:[]),...(node?.children??[]).flatMap(figures)];
    assert.deepEqual(figures(artifact.structure)[0].bounds,[30,50,90,100]);
    assert.ok(artifact.images.some(image => image.bounds[0] === 30 && image.bounds[1] === 50));
    assert.ok(artifact.resources.some(ref => ref.mediaType === 'image/png'));
    const scan = await service.parsing.artifact({ sessionId, artifactId: done.confirmed[1].artifactId });
    assert.equal(scan.textStatus, 'ocr-needed'); assert.deepEqual(scan.text, []);
    assert.equal((await service.parsing.start(request)).taskId, task.taskId);
    await assert.rejects(service.parsing.start({ ...request, versionId: 'changed' }), /不同内容/);
    assert.deepEqual((await service.read(sessionId)).unit, opened.unit);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(join(root, 'course'));
    assert.deepEqual(await service.parsing.artifact({ sessionId: reopened.sessionId, artifactId: done.confirmed[0].artifactId }), artifact);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

async function reached(buffer: SharedArrayBuffer) {
  await until(async () => Atomics.load(new Int32Array(buffer), 0), value => value === 1);
}
function release(buffer: SharedArrayBuffer) { const state = new Int32Array(buffer); Atomics.store(state,1,1); Atomics.notify(state,1); }

test('stop fences actual late parser output while confirmed pages survive, other courses save during a held long stage, explicit continue skips confirmed pages', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-parse-stop-'));
  const gate=new SharedArrayBuffer(8);
  const service=new CourseService(resolve('dist/worker.cjs'),{parseScheduling:{pageIndex:1,beforeResult:gate}});
  try {
    const path=join(root,'new.pdf');await parsingFixture(path);
    const first=await service.open(join(root,'course'));
    const sessionId=first.sessionId;
    const source=(await service.sources.importFile({sessionId,generation:1,operationId:'import',path,title:'New source'})).version;
    const started=await service.parsing.start({sessionId,generation:1,operationId:'parse',versionId:source.versionId});
    await reached(gate);
    const partial=await service.parsing.get({sessionId,taskId:started.taskId});assert.equal(partial.confirmed.length,1);
    const other=await service.open(join(root,'other-course'));
    const receipt=await service.save({sessionId:other.sessionId,inputSeq:1,baseRevision:other.revision,operationId:'other-save',blockId:other.editableBlockId,text:'Saved while actual page parser is held'});
    assert.equal(receipt.inputSeq,1);assert.equal((await service.read(other.sessionId)).revision,2);
    assert.equal(Atomics.load(new Int32Array(gate),1),0,'other-course work completes before parser release, without a benchmark threshold');
    const stop={sessionId,generation:1,operationId:'stop',taskId:started.taskId,attemptId:started.attemptId};
    await service.parsing.stop(stop);
    const stopped=await service.parsing.get({sessionId,taskId:started.taskId});
    assert.equal(stopped.status,'stopped');assert.equal(stopped.confirmed.length,1);
    assert.equal((await service.parsing.artifacts({sessionId,versionId:source.versionId})).length,1);
    const resumed=await service.parsing.continue({sessionId,generation:1,operationId:'continue',taskId:started.taskId});
    assert.notEqual(resumed.attemptId,started.attemptId);
    release(gate); // The old real result arrives only AFTER the new attempt has acquired eligibility.
    const done=await until(()=>service.parsing.get({sessionId,taskId:started.taskId}),t=>t.status==='completed' && !!t.attempts[0].outputs?.some(o=>o.status==='rejected'));
    assert.equal(done.status,'completed');assert.deepEqual(done.attempts[1].pagesStarted,[1]);
    assert.deepEqual(done.confirmed[0],partial.confirmed[0]);
    assert.deepEqual(await service.parsing.query({sessionId,operationId:done.confirmed[0].operationId}),done.confirmed[0]);
    const events=await service.readEvents(sessionId,0);
    assert.ok(events.kind==='events' && events.events.some(event=>event.type==='parse.changed' && event.kind==='page-confirmed'));
    assert.equal((await service.parsing.stop(stop)).status,'stopped','exact old receipt does not stop newer attempt');
    await assert.rejects(service.parsing.stop({...stop,operationId:'stale-stop'}),/旧尝试/);
    assert.deepEqual((await service.read(sessionId)).unit,first.unit);
  } finally { release(gate);await service.close();await rm(root,{recursive:true,force:true}); }
});

test('real SQLite registration failure preserves confirmed pages across reopen and continuation only executes the missing stage', async () => {
  const { DatabaseSync }=await import('node:sqlite');
  const root=await mkdtemp(join(tmpdir(),'yizhi-parse-reopen-')),gate=new SharedArrayBuffer(8);
  let service=new CourseService(resolve('dist/worker.cjs'),{parseScheduling:{pageIndex:1,beforeResult:gate}});
  let fault:InstanceType<typeof DatabaseSync>|undefined;
  try {
    const path=join(root,'new.pdf');await parsingFixture(path);const directory=join(root,'course');
    let opened=await service.open(directory),sessionId=opened.sessionId;
    const version=(await service.sources.importFile({sessionId,generation:1,operationId:'import',path,title:'New'})).version;
    const task=await service.parsing.start({sessionId,generation:1,operationId:'parse',versionId:version.versionId});
    await reached(gate);
    fault=new DatabaseSync(join(directory,'course.sqlite'));
    fault.exec("CREATE TRIGGER parse_fault BEFORE INSERT ON save_events WHEN json_extract(NEW.event,'$.kind')='page-confirmed' BEGIN SELECT RAISE(ABORT,'actual stage registration fault'); END");
    release(gate);
    const failed=await until(()=>service.parsing.get({sessionId,taskId:task.taskId}),t=>t.status==='failed');
    assert.match(failed.failure!,/actual stage registration fault/);assert.equal(failed.confirmed.length,1);
    assert.ok(failed.attempts[0].outputs?.some(o=>o.status==='failed' && o.digest),'failed real output digest is retained without a formal artifact');
    assert.equal((await service.parsing.artifacts({sessionId,versionId:version.versionId})).length,1);
    fault.exec('DROP TRIGGER parse_fault');fault.close();fault=undefined;
    await service.close();service=new CourseService(resolve('dist/worker.cjs'));opened=await service.open(directory);sessionId=opened.sessionId;
    const recovered=await service.parsing.get({sessionId,taskId:task.taskId});assert.equal(recovered.status,'failed');
    assert.deepEqual(recovered.confirmed,failed.confirmed);
    const continued=await service.parsing.continue({sessionId,generation:1,operationId:'resume',taskId:task.taskId});
    const done=await until(()=>service.parsing.get({sessionId,taskId:task.taskId}),t=>t.status!=='running');
    assert.equal(done.status,'completed');assert.equal(done.attemptId,continued.attemptId);
    assert.deepEqual(done.attempts[1].pagesStarted,[1]);assert.deepEqual(done.confirmed[0],failed.confirmed[0]);
  } finally {release(gate);fault?.close();await service.close();await rm(root,{recursive:true,force:true});}
});

test('corrections and fresh parses create immutable versions, failure binds the original operation and preserves old references',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const root=await mkdtemp(join(tmpdir(),'yizhi-parse-correct-'));let service=new CourseService(resolve('dist/worker.cjs'));
  let fault:InstanceType<typeof DatabaseSync>|undefined;
  try {
    const path=join(root,'new.pdf');await parsingFixture(path);let opened=await service.open(join(root,'course'));let sessionId=opened.sessionId;
    const source=(await service.sources.importFile({sessionId,generation:1,operationId:'import',path,title:'New'})).version;
    const request={sessionId,generation:1,operationId:'parse',versionId:source.versionId};const task=await service.parsing.start(request);
    const done=await until(()=>service.parsing.get({sessionId,taskId:task.taskId}),t=>t.status!=='running');
    const parent=done.confirmed[0],original=await service.parsing.artifact({sessionId,artifactId:parent.artifactId});
    const correction={sessionId,generation:1,operationId:'correction',artifactId:parent.artifactId,textId:original.text[0].id,text:'Reviewed heading',note:'Compared with source page'};
    fault=new DatabaseSync(join(root,'course/course.sqlite'));
    fault.exec("CREATE TRIGGER correct_fault BEFORE INSERT ON save_events WHEN json_extract(NEW.event,'$.kind')='corrected' BEGIN SELECT RAISE(ABORT,'correction event fault'); END");
    await assert.rejects(service.parsing.correct(correction),/correction event fault/);
    assert.equal((await service.parsing.artifacts({sessionId,versionId:source.versionId})).length,2);
    assert.equal(await service.parsing.query({sessionId,operationId:'correction'}),null);
    fault.exec('DROP TRIGGER correct_fault');fault.close();fault=undefined;
    await service.close();service=new CourseService(resolve('dist/worker.cjs'));sessionId=(await service.open(join(root,'course'))).sessionId;
    correction.sessionId=sessionId;
    await assert.rejects(service.parsing.correct({...correction,text:'Different request after failure'}),/不同内容/);
    const ref=await service.parsing.correct(correction);assert.notEqual(ref.artifactId,parent.artifactId);assert.notEqual(ref.digest,parent.digest);
    const corrected=await service.parsing.artifact({sessionId,artifactId:ref.artifactId});
    assert.equal(corrected.text[0].text,'Reviewed heading');assert.deepEqual(corrected.text[0].bounds,original.text[0].bounds);
    assert.equal(corrected.correction?.parentArtifactId,parent.artifactId);
    assert.deepEqual(await service.parsing.artifact({sessionId,artifactId:parent.artifactId}),original);
    assert.deepEqual(await service.parsing.correct(correction),ref);
    const raster=await service.parsing.readResource({sessionId,artifactId:ref.artifactId,sha256:ref.resources[0].sha256,begin:0,end:8});
    assert.equal(Buffer.from(raster.bytes).toString('hex'),'89504e470d0a1a0a');
    await assert.rejects(service.parsing.readResource({sessionId,artifactId:ref.artifactId,sha256:'0'.repeat(64),begin:0,end:8}),/未登记/);
    await assert.rejects(service.save({sessionId,inputSeq:1,baseRevision:opened.revision,operationId:'correction',blockId:opened.editableBlockId,text:'Must not steal operation'}),/操作身份/);
    const fresh=await service.parsing.start({...request,sessionId,operationId:'fresh-parse'});
    const parsed=await until(()=>service.parsing.get({sessionId,taskId:fresh.taskId}),t=>t.status!=='running');
    assert.equal(parsed.status,'completed');assert.notEqual(parsed.confirmed[0].artifactId,parent.artifactId);
    assert.equal((await service.parsing.artifact({sessionId,artifactId:parsed.confirmed[0].artifactId})).text[0].text,'Logic notes');
    assert.deepEqual((await service.read(sessionId)).unit,opened.unit);
  }finally{fault?.close();await service.close();await rm(root,{recursive:true,force:true});}
});

test('application interruption retains confirmed artifacts and explicit continuation creates a new attempt without redoing them',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-parse-interrupt-')),gate=new SharedArrayBuffer(8);
  let service=new CourseService(resolve('dist/worker.cjs'),{parseScheduling:{pageIndex:1,beforeCompute:gate}});
  try {
    const path=join(root,'new.pdf');await parsingFixture(path);const directory=join(root,'course');let opened=await service.open(directory);let sessionId=opened.sessionId;
    const source=(await service.sources.importFile({sessionId,generation:1,operationId:'import',path,title:'New'})).version;
    const task=await service.parsing.start({sessionId,generation:1,operationId:'parse',versionId:source.versionId});await reached(gate);
    const before=await service.parsing.get({sessionId,taskId:task.taskId});assert.equal(before.confirmed.length,1);
    await service.close();service=new CourseService(resolve('dist/worker.cjs'));sessionId=(await service.open(directory)).sessionId;
    const interrupted=await service.parsing.get({sessionId,taskId:task.taskId});assert.equal(interrupted.status,'interrupted');
    assert.deepEqual(interrupted.confirmed,before.confirmed);
    const request={sessionId,generation:1,operationId:'explicit-resume',taskId:task.taskId};
    const resumed=await service.parsing.continue(request);assert.notEqual(resumed.attemptId,task.attemptId);
    const done=await until(()=>service.parsing.get({sessionId,taskId:task.taskId}),t=>t.status!=='running');
    assert.equal(done.status,'completed');assert.deepEqual(done.attempts[1].pagesStarted,[1]);
    assert.equal((await service.parsing.continue(request)).attemptId,resumed.attemptId);
    assert.equal((await service.commands.query({sessionId,operationId:done.confirmed[0].operationId})),null,'artifact registration is not body publication');
  }finally{release(gate);await service.close();await rm(root,{recursive:true,force:true});}
});

test('the actual shared command-attempt stop and course generation boundary also reject late parsing registration',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  for(const boundary of ['commands-stop','generation'] as const) {
    const root=await mkdtemp(join(tmpdir(),'yizhi-parse-fence-')),gate=new SharedArrayBuffer(8);
    const service=new CourseService(resolve('dist/worker.cjs'),{parseScheduling:{pageIndex:1,beforeResult:gate}});
    try {
      const path=join(root,'new.pdf');await parsingFixture(path);const directory=join(root,'course'),opened=await service.open(directory),sessionId=opened.sessionId;
      const source=(await service.sources.importFile({sessionId,generation:1,operationId:'import',path,title:'New'})).version;
      const task=await service.parsing.start({sessionId,generation:1,operationId:'parse',versionId:source.versionId});await reached(gate);
      if(boundary==='commands-stop') await service.commands.stop({sessionId,attemptId:task.attemptId});
      else {const db=new DatabaseSync(join(directory,'course.sqlite'));try{db.exec("UPDATE metadata SET value='2' WHERE key='generation'");}finally{db.close();}}
      release(gate);
      const stopped=await until(()=>service.parsing.get({sessionId,taskId:task.taskId}),t=>!!t.attempts[0].outputs?.some(o=>o.status==='rejected'));
      assert.equal(stopped.confirmed.length,1);assert.equal(stopped.status,'stopped');
      assert.equal((await service.parsing.artifacts({sessionId,versionId:source.versionId})).length,1);
      if(boundary==='generation') await assert.rejects(service.parsing.continue({sessionId,generation:1,operationId:'old-gen',taskId:task.taskId}),/代际/);
    }finally{release(gate);await service.close();await rm(root,{recursive:true,force:true});}
  }
});
