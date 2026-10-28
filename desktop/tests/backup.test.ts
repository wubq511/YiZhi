import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { sourceFixture } from './source-fixture';
import { parsingFixture } from './parsing-fixture';
import { fork,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { legacyFixture } from './migration-fixture';

const A='RB-TH-01-01-what-is-positional-notation';
async function until<T>(read:()=>Promise<T>,done:(v:T)=>boolean){const end=Date.now()+20000;for(;;){const v=await read();if(done(v))return v;if(Date.now()>end)throw new Error('等待真实备份/解析阶段超时');await new Promise(r=>setTimeout(r,5));}}
function release(gate:SharedArrayBuffer){Atomics.store(new Int32Array(gate),0,2);}
test('ordinary body text that looks like a resource path remains plain text through backup, verify and independent reopen',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-plain-path-')),core=new CourseService(resolve('dist/worker.cjs'));let copy:CourseService|undefined;
 try{
  const c=await core.open(join(root,'live')),text='resources/'+'9'.repeat(64);
  await core.save({...c,operationId:'literal-resource-shaped-text',inputSeq:1,baseRevision:1,blockId:A,text});
  const conversation=await core.agent.create({...c,operationId:'literal-conversation'});await core.agent.submit({...c,conversationId:conversation.id,operationId:'literal-question',text,target:{unitId:'KU-001'}});
  const request={...c,directory:join(root,'backup'),backupId:'literal-text'},result=await core.backup.create(request);
  assert.equal(result.resources.length,0);await core.backup.verify(request);await core.close();copy=new CourseService(resolve('dist/worker.cjs'));
  const opened=await copy.open(request.directory);assert.equal(opened.unit.reading.blocks[0].payload.text,text);
  assert.ok((await copy.agent.get({...opened,conversationId:conversation.id})).messages.some(m=>m.role==='user'&&m.text===text));
 }finally{await copy?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('a real bare figure asset remains a declaration and a missing blob cannot be omitted from the snapshot manifest',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-bare-figure-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'live')),sha='8'.repeat(64),ids=c.unit.reading.blocks.map(b=>b.id),figure={id:'missing-bare-figure',kind:'figure',payload:{asset:'resources/'+sha,alt:'Declared image'}};
  await core.commitEdit({...c,inputSeq:1,baseRevision:1,operationId:'missing-figure',changes:[],complete:true,patch:{updates:[],correspondence:[],structure:{parentId:c.unit.id,before:ids,after:[...ids,figure.id],inserted:[figure]}}});
  const request={...c,directory:join(root,'backup'),backupId:'missing-bare-image'};await assert.rejects(core.backup.create(request),/ENOENT/);
  assert.ok((await core.backup.status(request)).resources.some(r=>r.sha256===sha));
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('a complete local backup opens independently with the saved body, acknowledged draft, identity and history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-')),core=new CourseService(resolve('dist/worker.cjs'));
 let copy:CourseService|undefined;
 try{
  const c=await core.open(join(root,'live'));
  await core.save({...c,operationId:'before-backup',inputSeq:1,baseRevision:1,blockId:A,text:'Saved snapshot body'});
  await core.saveDraft({...c,inputSeq:2,baseRevision:2,changes:[{blockId:A,text:'Acknowledged incomplete draft'}],complete:false});
  const result=await (core as any).backup.create({...c,directory:join(root,'backup'),backupId:'first-backup'});
  assert.equal(result.phase,'complete');
  assert.equal(JSON.parse(await readFile(join(root,'backup','backup-complete.json'),'utf8')).backupId,'first-backup');
  await core.close();
  copy=new CourseService(resolve('dist/worker.cjs'));
  const reopened=await copy.open(join(root,'backup'));
  assert.equal(reopened.courseId,c.courseId);
  assert.equal(reopened.unit.reading.blocks[0].payload.text,'Saved snapshot body');
  assert.equal(reopened.drafts[0].input.changes[0].text,'Acknowledged incomplete draft');
  assert.equal((await copy.history(reopened.sessionId))[0].receipt.operationId,'before-backup');
  assert.equal((await copy.retention.resourceLeases(reopened)).some(l=>l.state==='active'),false);
 }finally{await copy?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('a source and its portable backup cannot both gain writable course identity through different directories',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-alias-')),core=new CourseService(resolve('dist/worker.cjs')),copy=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'live'));await core.backup.create({...c,directory:join(root,'backup'),backupId:'alias'});
  await assert.rejects(copy.open(join(root,'backup')),/身份|另一|权威/);
  await core.close();assert.equal((await copy.open(join(root,'backup'))).courseId,c.courseId);
 }finally{await copy.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('T25 actual migrated tables enumerate their declared resource closure and reject a missing pending ref without mistaking origin digests for files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-t25-roots-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const source=join(root,'legacy'),directory=join(root,'live');await legacyFixture(source);
  const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'state'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  await core.migration.convert({sourceDirectory:source,directory});const c=await core.open(directory);await core.migration.personal({...c,sourceDirectory:source});
  const refs:Array<{sha256:string;byteLength:number;relativePath:string}>=[];for(const kind of ['value','pending','origin','timeline']){const bytes=Buffer.from('Only T25 '+kind),sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(join(directory,'resources',sha256),bytes);refs.push({sha256,byteLength:bytes.length,relativePath:'resources/'+sha256});}
  const db=new DatabaseSync(join(directory,'course.sqlite'));db.exec('PRAGMA busy_timeout=1000');const time=new Date().toISOString(),opaque=createHash('sha256').update('Opaque origin identity, not a file').digest('hex');
  db.prepare('INSERT INTO migration_values VALUES(?,?,?)').run('backup-value-only',JSON.stringify({resource:refs[0]}),time);
  db.prepare('INSERT INTO migration_pending VALUES(?,?,?,?,?,?,?)').run('backup-pending-only','editingDrafts','pending','recovery','unresolved',JSON.stringify({resource:refs[1]}),time);
  db.prepare('INSERT INTO migration_origins VALUES(?,?,?,?,?,?)').run('backup-context','original-only',1,0,opaque,JSON.stringify({resource:refs[2]}));
  db.prepare("INSERT INTO restore_timeline(kind,reference,domain,object_id,before_value,after_value,committed_at) VALUES('legacy',?,'personal','root',?,?,?)").run('backup-timeline-only',JSON.stringify({resource:refs[3]}),JSON.stringify({resource:refs[3]}),time);db.close();
  const full=await core.backup.create({...c,directory:join(root,'backup'),backupId:'t25-all-roots'});
  for(const ref of refs)assert.ok(full.resources.some(r=>r.sha256===ref.sha256&&r.declaredBy.includes('t25-origin-and-imported-history')));
  assert.ok(!full.resources.some(r=>r.sha256===opaque));
  await rm(join(directory,'resources',refs[1].sha256));
  await assert.rejects(core.backup.create({...c,directory:join(root,'missing-backup'),backupId:'t25-missing-pending'}),/ENOENT/);
  const unfinished=await core.backup.status({directory:join(root,'missing-backup')});assert.equal(unfinished.phase,'unfinished');assert.ok(unfinished.resources.some(r=>r.sha256===refs[1].sha256));
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('a directory name beginning with two dots is still inside the live course and cannot become its backup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-path-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{const c=await core.open(root);await assert.rejects(core.backup.create({...c,directory:join(root,'..backup'),backupId:'nested'}),/独立|课程外/);}
 finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('a malformed registered source declaration cannot be hidden by another payload that happens to retain the same file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-declaration-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'live')),path=join(root,'source.pdf');await sourceFixture(path);
  const source=(await core.sources.importFile({...c,operationId:'source-declaration',path,title:'Required declaration'})).version;await core.close();
  const db=new DatabaseSync(join(root,'live','course.sqlite')),payload={...source} as any;delete payload.byteLength;
  db.prepare('UPDATE source_versions SET payload=? WHERE id=?').run(JSON.stringify(payload),source.versionId);db.close();
  core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(join(root,'live'));
  await assert.rejects(core.backup.create({...reopened,directory:join(root,'backup'),backupId:'invalid-declaration'}),/声明|长度/);
  assert.equal((await core.backup.status({directory:join(root,'backup')})).phase,'unfinished');
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('failure writing the final marker retries a verified bare resource declaration without treating its resolved length as a changed snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-marker-fault-')),gate=new SharedArrayBuffer(4),core=new CourseService(resolve('dist/worker.cjs'),{backupScheduling:{beforeMarker:gate}});let pending:Promise<unknown>|undefined;
 try{
  const c=await core.open(join(root,'live')),bytes=Buffer.from('Immutable draft resource'),sha=createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(root,'live','resources'));await writeFile(join(root,'live','resources',sha),bytes);
  const ids=c.unit.reading.blocks.map(b=>b.id),figure={id:'bare-figure-resource',kind:'figure',payload:{asset:'resources/'+sha,alt:'Fixed bare resource'}};
  await core.commitEdit({...c,inputSeq:1,baseRevision:1,operationId:'declare-bare-figure',changes:[],complete:true,patch:{updates:[],correspondence:[],structure:{parentId:c.unit.id,before:ids,after:[...ids,figure.id],inserted:[figure]}}});
  const request={...c,directory:join(root,'backup'),backupId:'marker-fault'};pending=core.backup.create(request);pending.catch(()=>{});
  await until(async()=>Atomics.load(new Int32Array(gate),0),v=>v===1);await mkdir(join(request.directory,'backup-complete.json.partial'));
  release(gate);await assert.rejects(pending,/EISDIR/);assert.equal((await core.backup.status(request)).phase,'unfinished');
  await rm(join(request.directory,'backup-complete.json.partial'),{recursive:true});pending=core.backup.resume(request);const settled:{error?:unknown}={};pending.catch(e=>{settled.error=e;});
  await until(async()=>Atomics.load(new Int32Array(gate),0)===1||!!settled.error,v=>v);release(gate);await pending;
  await core.backup.verify(request);
 }finally{release(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});
test('real copy failure retains the fixed manifest; retry verifies and repairs corrupt destination bytes before completing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-copy-fault-')),gate=new SharedArrayBuffer(4),core=new CourseService(resolve('dist/worker.cjs'),{backupScheduling:{beforeCopy:gate}});let pending:Promise<unknown>|undefined;
 try{
  const c=await core.open(join(root,'live'));await core.extensions.open(c);
  const request={...c,directory:join(root,'backup'),backupId:'copy-fault'};pending=core.backup.create(request);pending.catch(()=>{});
  await until(async()=>Atomics.load(new Int32Array(gate),0),v=>v===1);
  const original=JSON.parse(await readFile(join(request.directory,'backup-manifest.json'),'utf8'));
  const blocked=join(request.directory,original.resources[1].path+'.partial');await mkdir(blocked);
  release(gate);await assert.rejects(pending,/EISDIR/);
  const failed=await core.backup.status(request);assert.equal(failed.phase,'unfinished');assert.deepEqual(failed.snapshot,original.snapshot);
  await writeFile(join(request.directory,original.resources[0].path),'corrupt copy');await rm(blocked,{recursive:true});
  pending=core.backup.resume(request);await until(async()=>Atomics.load(new Int32Array(gate),0),v=>v===1);release(gate);await pending;
  await core.backup.verify(request);
 }finally{release(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});
test('copying a fixed snapshot allows repeated same-course saves and source replacement plus another course reads/saves; later live GC does not change backup history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-concurrent-')),gate=new SharedArrayBuffer(4),clock=new SharedArrayBuffer(8),now=Date.parse('2030-01-01T00:00:00Z');
 Atomics.store(new BigInt64Array(clock),0,BigInt(now));
 const core=new CourseService(resolve('dist/worker.cjs'),{backupScheduling:{afterSnapshot:gate},retentionScheduling:{clock,manual:true}});
 let copy:CourseService|undefined,pending:Promise<unknown>|undefined;
 try{
  const c=await core.open(join(root,'live')),other=await core.open(join(root,'other')),path=join(root,'source.pdf');await sourceFixture(path,'Original fixed PDF');
  const original=(await core.sources.importFile({...c,operationId:'original-source',path,title:'Original fixed PDF'})).version;
  await core.save({...c,operationId:'snapshot-formal-body',inputSeq:1,baseRevision:1,blockId:A,text:'Snapshot historical body'});
  const request={...c,directory:join(root,'backup'),backupId:'concurrent'};pending=core.backup.create(request);
  await until(async()=>Atomics.load(new Int32Array(gate),0),v=>v===1);
  await assert.rejects(access(join(request.directory,'backup-complete.json')));
  for(let i=1;i<=4;i++){
   const work=(async()=>{
    await core.save({...c,operationId:'live-save-'+i,inputSeq:i+1,baseRevision:i+1,blockId:A,text:'Live new body '+i});
    await sourceFixture(path,'Live replacement '+i);
    await core.sources.importFile({...c,operationId:'live-source-'+i,path,title:'Replacement',sourceId:original.sourceId});
    await core.save({...other,operationId:'other-save-'+i,inputSeq:i,baseRevision:i,blockId:A,text:'Other progress '+i});
    assert.equal((await core.read(other.sessionId)).unit.reading.blocks[0].payload.text,'Other progress '+i);
   })();
   await Promise.race([work,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('文件复制占住了 Core 队列')),3000);t.unref();})]);
  }
  release(gate);await pending;
  const manifest=await core.backup.verify(request);
  assert.deepEqual(manifest.resources.map(r=>r.sha256),[original.sha256]);
  Atomics.store(new BigInt64Array(clock),0,BigInt(now+150*86400000));
  let result=await core.retention.run({...c,limit:64});for(let i=0;result.pending&&i<200;i++)result=await core.retention.run({...c,limit:64});
  await assert.rejects(core.formalHistory.detail({...c,operationId:'snapshot-formal-body'}),/过期/);
  await core.close();copy=new CourseService(resolve('dist/worker.cjs'));
  const opened=await copy.open(request.directory);
  assert.equal(opened.unit.reading.blocks[0].payload.text,'Snapshot historical body');
  assert.equal((await copy.history(opened.sessionId)).length,1);
  assert.equal((await copy.sources.list(opened)).versions.length,1);
  assert.match(Buffer.from((await copy.sources.readResource({...opened,versionId:original.versionId,begin:0,end:8})).bytes).toString(),/%PDF/);
 }finally{release(gate);await pending?.catch(()=>{});await copy?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('backup includes uncited registered sources, real parse/correction JSON and every offline extension dependency',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-roots-')),core=new CourseService(resolve('dist/worker.cjs'));let copy:CourseService|undefined;
 try{
  const c=await core.open(join(root,'live')),path=join(root,'source.pdf');await parsingFixture(path);
  const source=(await core.sources.importFile({...c,operationId:'parse-source',path,title:'Uncited registered source'})).version;
  const started=await core.parsing.start({...c,operationId:'parse',versionId:source.versionId});
  const task=await until(()=>core.parsing.get({...c,taskId:started.taskId}),t=>t.status!=='running');assert.equal(task.status,'completed');
  const page=await core.parsing.artifact({...c,artifactId:task.confirmed[0].artifactId});
  const correction=await core.parsing.correct({...c,operationId:'correction',artifactId:task.confirmed[0].artifactId,textId:page.text[0].id,text:'Corrected trusted title',note:'Manual source check'});
  const extension=await core.extensions.open(c);
  const request={...c,directory:join(root,'backup'),backupId:'complete-roots'},manifest=await core.backup.create(request);
  for(const hash of [source.sha256,...task.confirmed.flatMap(r=>[r.resource.sha256,...r.resources.map(r=>r.sha256)]),correction.resource.sha256,...extension.definition.resources.map(r=>r.sha256)])assert.ok(manifest.resources.some(r=>r.sha256===hash),hash);
  await core.backup.verify(request);await core.close();copy=new CourseService(resolve('dist/worker.cjs'));
  const opened=await copy.open(request.directory);
  assert.equal((await copy.parsing.artifact({...opened,artifactId:correction.artifactId})).text[0].text,'Corrected trusted title');
  await copy.extensions.open(opened);
  for(const r of extension.definition.resources)assert.equal((await copy.extensions.resource({...opened,version:extension.definition.packageVersion,path:r.path})).bytes.byteLength,r.byteLength);
 }finally{await copy?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('SIGKILL before completion keeps durable unfinished state and source lease; a new Core retries the original snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-kill-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'live'));await core.save({...c,operationId:'before-kill',inputSeq:1,baseRevision:1,blockId:A,text:'Original interrupted snapshot'});await core.close();
  const child=fork(resolve('dist/tests/backup-process.cjs'),[join(root,'live'),join(root,'backup')],{stdio:['ignore','pipe','pipe','ipc']});
  const [event]=await once(child,'message');assert.deepEqual(event,{point:'beforeMarker'});child.kill('SIGKILL');await once(child,'exit');
  core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(join(root,'live'));
  const unfinished=await core.backup.status({directory:join(root,'backup')});assert.equal(unfinished.phase,'unfinished');
  assert.ok((await core.retention.resourceLeases(reopened)).some(l=>l.id==='backup:killed'&&l.state==='active'));
  await core.save({...reopened,operationId:'after-kill',inputSeq:1,baseRevision:2,blockId:A,text:'New live data after interruption'});
  const done=await core.backup.resume({...reopened,directory:join(root,'backup'),backupId:'killed'});
  assert.deepEqual(done.snapshot,unfinished.snapshot);await core.backup.verify({directory:join(root,'backup')});
  assert.equal((await core.retention.resourceLeases(reopened)).some(l=>l.state==='active'),false);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('retry rejects a changed snapshot resource manifest instead of silently declaring an incomplete copy complete',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-manifest-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'live')),path=join(root,'source.pdf');await sourceFixture(path);
  const source=(await core.sources.importFile({...c,operationId:'manifest-source',path,title:'Required source'})).version;
  await rm(join(root,'live','resources',source.sha256));
  const request={...c,directory:join(root,'backup'),backupId:'changed-manifest'};
  await assert.rejects(core.backup.create(request));
  const manifest=JSON.parse(await readFile(join(request.directory,'backup-manifest.json'),'utf8'));manifest.resources=[];
  await writeFile(join(request.directory,'backup-manifest.json'),JSON.stringify(manifest));
  await assert.rejects(core.backup.resume(request),/清单/);
  await assert.rejects(access(join(request.directory,'backup-complete.json')));
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('a declared missing source leaves a durable unfinished snapshot; retry keeps its old manifest after live replacement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-missing-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'live')),path=join(root,'source.pdf');await sourceFixture(path);
  const source=(await core.sources.importFile({...c,operationId:'source-1',path,title:'Registered but uncited'})).version;
  const resource=join(root,'live','resources',source.sha256),original=await readFile(resource);
  await rm(resource);
  const request={...c,directory:join(root,'backup'),backupId:'missing-declared'};
  await assert.rejects(core.backup.create(request),/ENOENT/);
  const unfinished=await core.backup.status(request);
  assert.equal(unfinished.phase,'unfinished');assert.ok(unfinished.resources.some(r=>r.sha256===source.sha256));
  await assert.rejects(access(join(request.directory,'backup-complete.json')));
  await assert.rejects(core.open(request.directory),/未完成/);
  await sourceFixture(path,'New live source');
  const later=(await core.sources.importFile({...c,operationId:'source-2',path,title:'Later',sourceId:source.sourceId})).version;
  await writeFile(resource,original);
  const done=await core.backup.resume(request);
  assert.deepEqual(done.snapshot,unfinished.snapshot);
  assert.ok(!done.resources.some(r=>r.sha256===later.sha256));
  await core.backup.verify(request);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
