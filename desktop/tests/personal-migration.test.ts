import {prepared,lesson} from './generation-fixture';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,realpath } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { CourseService } from '../src/core/course-service';
import { legacyFixture } from './migration-fixture';

test('personal migration preserves original note identity, time and weak object context through the public note API without inventing precise selection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-personal-import-')),source=join(root,'source'),candidate=join(root,'candidate');
 let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);
  const legacy=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(legacy.status,0,legacy.stderr);
  const original=JSON.parse(legacy.stdout);
  await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);
  const report=await (core.migration as any).personal({...c,sourceDirectory:source});
  assert.equal(report.namespaces.notes.imported,1);
  const notes=await core.annotations.list(c);assert.equal(notes.length,1);const note=notes[0] as any;
  assert.equal(note.id,'NOTE-T25-OBJECT');assert.equal(note.text,'SYNTHETIC original thought');assert.equal(note.createdAt,original.note.createdAt);assert.equal(note.updatedAt,original.note.updatedAt);
  assert.equal(note.current.status,'orphan');assert.deepEqual(note.original.fragments,[]);assert.deepEqual(note.legacy.anchor,original.note.anchor);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(candidate);
  assert.deepEqual(await core.annotations.list(reopened),notes);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('verified cutover admits only the published target and permanently fences normal fresh legacy Store writes while the original records stay readable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-directory-cutover-')),source=join(root,'source'),candidate=join(root,'content'),target=join(root,'唯一 new course');
 let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  await core.migration.convert({sourceDirectory:source,directory:candidate});
  const prepared=await (core.migration as any).prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'cutover-one'});
  assert.equal(prepared.phase,'verified');await assert.rejects(core.open(target),/未发布|切换/);
  const receipt=await (core.migration as any).publish({sourceDirectory:source,operationId:'cutover-one'});assert.equal(receipt.phase,'published');
  const opened=await core.open(target);assert.equal((await core.annotations.list(opened))[0].id,'NOTE-T25-OBJECT');
  const probe=spawnSync('python3',['-B','-c',`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom reviewboard.storage import CourseStore\np=Path(sys.argv[2]);m=json.loads((p/'课程.json').read_text())\ntry:\n CourseStore(p/m['state'],m['courseId'])\n print('WRITABLE')\nexcept Exception as e:\n print(str(e))`,resolve('../legacy/review-board'),source],{encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);assert.match(probe.stdout,/迁移|只读|权威/);assert.doesNotMatch(probe.stdout,/WRITABLE/);
  assert.deepEqual((await (core.migration as any).status({directory:source})).decision,receipt);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));assert.equal((await (core.migration as any).recover({directory:source})).directory,await realpath(target));
  assert.equal((await core.open(target)).courseId,opened.courseId);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('migration preserves all six drawing kinds and original color, three-state ownership, layout, per-unit reading positions and fixed-source context in native APIs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-personal-state-')),source=join(root,'source'),candidate=join(root,'candidate'),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'state'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);await core.migration.personal({...c,sourceDirectory:source});
  const states=await core.reviewStates(c.sessionId);assert.equal(states.units['KU-001'].status,'weak');assert.equal(states.units['KU-086'].status,'mastered');
  assert.deepEqual((await core.graph(c.sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,310);
  const reading=await core.readingState(c.sessionId);assert.equal(reading!.unitId,'KU-086');assert.equal(reading!.scrollTop,44);assert.deepEqual(reading!.camera,{x:12,y:34,zoom:.8});
  const drawings=await core.drawings.list(c);assert.equal(drawings.length,6);assert.deepEqual(drawings.map(d=>d.value!.kind).sort(),['arrow','ellipse','highlighter','line','rectangle','wave']);assert.ok(drawings.every(d=>(d as any).legacy.color==='#345d88'));
  assert.equal((await core.sources.context(c))!.pdfPageIndex,0);assert.equal((await core.sources.context(c))!.versionId,'VER-TEST');assert.equal((await core.sources.list(c)).intents[0].decision,'defer');
  const origins=await (core.migration as any).records({...c,namespace:'reading'});assert.deepEqual(origins.records[0].extra.unitScroll,{'KU-001':18,'KU-086':44});assert.equal(origins.records[0].extra.query,'SYNTHETIC prior search');
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('actual legacy runtime partial execution and unsent conversation migrate with original identities, remain stopped on reopen, and continue only through a fresh explicit attempt',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-personal-task-')),source=join(root,'source'),candidate=join(root,'candidate');let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'tasks'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);const report=await core.migration.personal({...c,sourceDirectory:source});
  assert.equal(report.namespaces.tasks.imported,1);const list=await core.agent.list(c);assert.equal(list.conversations.length,1);
  const view=await core.agent.get({...c,conversationId:list.conversations[0].id}),task=view.tasks[0];assert.equal(task.status,'unknown');assert.equal(task.threadId,'THREAD-T25-SYNTHETIC');assert.equal(task.turnId,'TURN-T25-SYNTHETIC');
  assert.ok(view.messages.some(m=>m.text==='SYNTHETIC actual controlled partial reply'));assert.equal((task as any).legacy.attempt,1);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(candidate),again=await core.agent.get({...reopened,conversationId:view.id});assert.equal(again.tasks.length,1);assert.equal(again.tasks[0].status,'unknown');
  const continued=await core.agent.continue({...reopened,taskId:task.id,operationId:'explicit-legacy-continue'});assert.notEqual(continued.attemptId,task.attemptId);assert.equal(continued.continuesTaskId,task.id);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('original receipts and per-record history keep real commit time and identity, then the shared retention window removes old bodies without replaying or losing the current note',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-personal-history-')),source=join(root,'source'),candidate=join(root,'candidate'),clock=new SharedArrayBuffer(8);Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'history'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);const original=JSON.parse(made.stdout);
  await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);await core.migration.personal({...c,sourceDirectory:source});
  const history=await (core.migration as any).history({...c,namespace:'notes'});assert.equal(history.entries.length,2);assert.ok(history.entries.some((e:any)=>e.savedAt===original.receipt.savedAt));
  assert.equal(history.entries[0].before.value.text,'SYNTHETIC original thought');assert.equal(history.entries[0].after.value.text,'SYNTHETIC current edited thought');
  assert.deepEqual((await (core.migration as any).operation({...c,operationId:original.receipt.operationId})).receipt,original.receipt);
  await assert.rejects(core.save({...c,operationId:original.receipt.operationId,inputSeq:99,baseRevision:1,blockId:'RB-TH-01-01-what-is-positional-notation',text:'Never replay migrated identity'}),/旧版|迁移|身份/);
  const before=await core.read(c.sessionId),note=(await core.annotations.list(c))[0];
  Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()+150*86400000));let r=await core.retention.run({...c,limit:16});for(let i=0;r.pending&&i<1000;i++)r=await core.retention.run({...c,limit:16});
  assert.equal((await (core.migration as any).history({...c,namespace:'notes'})).entries.length,0);assert.equal((await (core.migration as any).operation({...c,operationId:original.receipt.operationId})).expired,true);
  assert.deepEqual(await core.read(c.sessionId),before);assert.deepEqual((await core.annotations.list(c))[0],note);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('normal legacy host acknowledges the latest durable input, freezes new admissions and exits releasing its service lock before migration can prepare',async()=>{
 const {spawn}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'yizhi-legacy-stop-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target'),core=new CourseService(resolve('dist/worker.cjs'));
 let host:ReturnType<typeof spawn>|undefined;
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});
  host=spawn('python3',['-B',resolve('../legacy/review-board/start.py'),'--course',source,'--port','0','--no-browser'],{stdio:['ignore','pipe','pipe']});let errors='';host.stderr!.on('data',b=>errors+=b);
  const url=await new Promise<string>((yes,no)=>{let text='';const timer=setTimeout(()=>no(new Error('Legacy host timeout '+errors)),8000);host!.stdout!.on('data',b=>{text+=b;const match=/http:\/\/127\.0\.0\.1:\d+\//.exec(text);if(match){clearTimeout(timer);yes(match[0]);}});host!.once('exit',()=>{clearTimeout(timer);no(new Error('Legacy host exited '+errors));});});
  await assert.rejects(core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'stop-gate'}),/活动写入|仍在写入/);
  const {DatabaseSync}=await import('node:sqlite');const blocker=new DatabaseSync(join(source,'.review-board/state.sqlite3'));blocker.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
  let saved:any,receipt:any;
  try{
   const saving=fetch(url+'api/v1/commands',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:'OP-LATEST-TAIL',actor:'student',kind:'personal.update',generation:1,expectedRevisions:{'editingDrafts:AGENT-new':0},changes:[{namespace:'editingDrafts',key:'AGENT-new',value:{type:'agent',conversationId:null,text:'Latest confirmed legacy tail'}}]})}).then(r=>r.json()) as Promise<any>;
   let state:any;for(let i=0;i<100;i++){const r=await fetch(url+'api/v1/migration/state');assert.equal(r.status,200);state=await r.json();if(state.inflight)break;await new Promise(r=>setTimeout(r,10));}assert.equal(state.inflight,1);
   const exited=once(host,'exit'),stopping=fetch(url+'api/v1/migration/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:'LEGACY-BARRIER',confirmedSequence:JSON.parse(made.stdout).receipt.sequence})});
   for(let i=0;i<100;i++){state=await fetch(url+'api/v1/migration/state').then(r=>r.json());if(state.quiescing)break;await new Promise(r=>setTimeout(r,10));}assert.equal(state.quiescing,true);assert.equal(state.inflight,1);
   blocker.exec('COMMIT');saved=await saving;assert.equal(saved.saved,true);const stop=await stopping;assert.equal(stop.status,200,await stop.clone().text());receipt=await stop.json();assert.equal(receipt.saved,true);assert.ok(receipt.sequence>=saved.sequence);await exited;
  }finally{blocker.close();}
  const prepared=await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'stop-gate'});assert.equal(prepared.sourceVersion.sequence,receipt.sequence);
 }finally{if(host?.exitCode===null&&host.signalCode===null){host.kill('SIGTERM');await once(host,'exit');}await core.close();await rm(root,{recursive:true,force:true});}
});

for(const point of ['beforePublish','afterPublish'])test(`real SIGKILL at ${point} resolves exactly one writable directory from durable completion facts without replay`,async()=>{
 const {fork}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'yizhi-cutover-kill-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target');let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});await core.close();
  const child=fork(resolve('dist/tests/cutover-process.cjs'),[source,candidate,target,point],{stdio:['ignore','ignore','pipe','ipc'],env:process.env});let errors='';child.stderr!.on('data',b=>errors+=b);
  try{const reached=await new Promise<any>((yes,no)=>{const t=setTimeout(()=>no(new Error(errors||'Cutover gate timeout')),10000);child.once('message',m=>{clearTimeout(t);yes(m);});child.once('exit',()=>{clearTimeout(t);no(new Error(errors));});});assert.equal(reached.point,point);const killed=once(child,'exit');child.kill('SIGKILL');await killed;
   core=new CourseService(resolve('dist/worker.cjs'));const restored=await core.migration.recover({directory:source});
   if(point==='beforePublish'){assert.equal(restored.directory,await realpath(source));await assert.rejects(core.open(target),/未发布|切换/);}
   else{assert.equal(restored.directory,await realpath(target));const c=await core.open(target);assert.equal((await core.annotations.list(c))[0].id,'NOTE-T25-OBJECT');assert.deepEqual(await core.migration.publish({sourceDirectory:source,operationId:'process-cutover'}),restored.decision);}
   const writable=spawnSync('python3',['-B','-c',`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom reviewboard.storage import CourseStore\np=Path(sys.argv[2]);m=json.loads((p/'课程.json').read_text())\ntry:\n s=CourseStore(p/m['state'],m['courseId']);s.close();print('yes')\nexcept Exception: print('no')`,resolve('../legacy/review-board'),source],{encoding:'utf8'});assert.equal(writable.status,0,writable.stderr);assert.equal(writable.stdout.trim(),point==='beforePublish'?'yes':'no');
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('publication fences actual held and fresh legacy Store/Service/content entrances, retaining the original database bytes',async()=>{
 const {spawn}=await import('node:child_process');const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'yizhi-cutover-held-')),source=join(root,'source'),candidate=join(root,'content'),target=join(root,'target'),core=new CourseService(resolve('dist/worker.cjs'));let held:ReturnType<typeof spawn>|undefined;
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  held=spawn('python3',['-B',resolve('tests/legacy-held-writer.py'),source],{stdio:['pipe','pipe','pipe']});let errors='';held.stderr!.on('data',b=>errors+=b);await new Promise((yes,no)=>{held!.stdout!.once('data',yes);held!.once('exit',()=>no(new Error(errors)));});
  const bytes=await readFile(join(source,'.review-board/state.sqlite3'));
  await core.migration.convert({sourceDirectory:source,directory:candidate});await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'held-cutover'});await core.migration.publish({sourceDirectory:source,operationId:'held-cutover'});
  const replies=new Promise<any>(yes=>held!.stdout!.once('data',b=>yes(JSON.parse(String(b))))),ended=once(held,'exit');held.stdin!.end('\n');const probes=await replies;assert.equal(probes.length,5);assert.ok(probes.every((p:any)=>!p.accepted),JSON.stringify(probes));await ended;
  assert.deepEqual(await readFile(join(source,'.review-board/state.sqlite3')),bytes);
 }finally{if(held?.exitCode===null&&held.signalCode===null){held.kill('SIGTERM');await once(held,'exit');}await core.close();await rm(root,{recursive:true,force:true});}
});

test('sealing a migration target rejects missing registered source bytes rather than certifying only the files that happen to remain',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-cutover-root-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target');let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate),v=(await core.sources.list(c)).versions[0];await core.close();await rm(join(candidate,'resources',v.sha256));
  core=new CourseService(resolve('dist/worker.cjs'));await assert.rejects(core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'missing-ref'}),/资源|缺失|ENOENT/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a published portable target opens and public status/recover resolve its own new directory with both original source and target absent',async()=>{
 const {cp,rename}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'yizhi-cutover-portable-')),source=join(root,'source'),candidate=join(root,'content'),target=join(root,'target'),portable=join(root,'另一设备','portable 中文 course');let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'history'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'portable-publish'});const receipt=await core.migration.publish({sourceDirectory:source,operationId:'portable-publish'});const c=await core.open(target),notes=await core.annotations.list(c);await core.close();
  await cp(target,portable,{recursive:true});await rename(source,source+'-hidden');await rename(target,target+'-hidden');
  core=new CourseService(resolve('dist/worker.cjs'));const opened=await core.open(portable);assert.deepEqual(await core.annotations.list(opened),notes);
  const status=await core.migration.status({directory:portable}) as any;assert.equal(status.role,'target');assert.equal(status.directory,await realpath(portable));assert.equal(status.decision.id,receipt.id);assert.equal(status.decision.targetDirectory,receipt.targetDirectory);
  const restored=await core.migration.recover({directory:portable});assert.equal(restored.directory,await realpath(portable));assert.equal(restored.decision!.id,receipt.id);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('personal migration rejects a stale content candidate and preserves the source generation and cursor without replaying its commands',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-migration-basis-')),source=join(root,'source'),candidate=join(root,'candidate');const core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  await core.migration.convert({sourceDirectory:source,directory:candidate});
  const mutate=spawnSync('python3',['-B','-c',`import json,sys,sqlite3\nfrom pathlib import Path\np=Path(sys.argv[1]);m=json.loads((p/'课程.json').read_text());k=p/m['knowledge'];v=json.loads(k.read_text());v['units'][0]['name']='SYNTHETIC changed after conversion';k.write_text(json.dumps(v));db=sqlite3.connect(p/m['state']);db.execute('UPDATE course_metadata SET generation=7,sequence=750');db.commit();db.close()`,source],{encoding:'utf8'});assert.equal(mutate.status,0,mutate.stderr);
  const c=await core.open(candidate);await assert.rejects(core.migration.personal({...c,sourceDirectory:source}),/候选|内容|摘要/);
  const fresh=join(root,'fresh');await core.migration.convert({sourceDirectory:source,directory:fresh});const f=await core.open(fresh);await core.migration.personal({...f,sourceDirectory:source});const current=await core.read(f.sessionId);assert.equal(current.generation,7);assert.ok(current.eventCursor>=750);assert.equal((await core.migration.operation({...f,operationId:JSON.parse(made.stdout).receipt.operationId})).generation,1);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('an interrupted verified preparation can be queried and exactly retried after reopen, while a changed target or operation is refused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-prepare-retry-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target');let core=new CourseService(resolve('dist/worker.cjs'));
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});
  const p={sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'retry-prepare'},original=await core.migration.prepare(p);assert.deepEqual(await core.migration.prepare(p),original);await core.close();core=new CourseService(resolve('dist/worker.cjs'));assert.equal((await core.migration.status({directory:source})).phase,'verified');assert.deepEqual(await core.migration.prepare(p),original);await assert.rejects(core.migration.prepare({...p,operationId:'different-operation'}),/另一|身份|不同/);const receipt=await core.migration.publish({sourceDirectory:source,operationId:p.operationId});assert.equal(receipt.id,original.id);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a complete legacy body change joins the existing formal history with its original time and restores as one checked group without replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-legacy-formal-')),source=join(root,'source'),candidate=join(root,'candidate'),clock=new SharedArrayBuffer(8);Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()));const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{const f=await legacyFixture(source);const previous=f.first.reading.blocks[0].payload.text;const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'content-history'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);await core.migration.personal({...c,sourceDirectory:source});
  assert.ok((await core.formalHistory.list(c)).activities.some(a=>a.operationIds.includes('OP-LEGACY-BODY')));const detail=await core.formalHistory.detail({...c,operationId:'OP-LEGACY-BODY'});const original=await core.migration.operation({...c,operationId:'OP-LEGACY-BODY'});assert.equal(detail.committedAt,original.receipt.savedAt);
  const preview=await core.formalHistory.preview({...c,selection:{kind:'operations',operationIds:['OP-LEGACY-BODY']}});const receipt=await core.formalHistory.apply({...c,operationId:'undo-legacy-body',preview});assert.equal(receipt.status,'committed');assert.equal((await core.readUnit(c.sessionId,'KU-001')).reading.blocks[0].payload.text,previous);assert.deepEqual(await core.formalHistory.apply({...c,operationId:'undo-legacy-body',preview}),receipt);
  Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()+150*86400000));let cleanup=await core.retention.run({...c,limit:8});for(let i=0;cleanup.pending&&i<300;i++)cleanup=await core.retention.run({...c,limit:8});assert.equal(cleanup.blocked,undefined);assert.equal((await core.migration.history({...c,namespace:'knowledge'})).entries.length,0);assert.equal((await core.readUnit(c.sessionId,'KU-001')).reading.blocks[0].payload.text,previous);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('after the old source resumes normal writes an unpublished preparation can be abandoned, preserving its identity while a fresh checked transition publishes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-abandon-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target'),fresh=join(root,'fresh'),newTarget=join(root,'new-target');let core=new CourseService(resolve('dist/worker.cjs'));
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});const p={sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'prepare-A'},a=await core.migration.prepare(p);await core.close();
  const wrote=spawnSync('python3',['-B','-c',`import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom reviewboard.service import CourseService\ns=CourseService(Path(sys.argv[2]));r=s.store.read('review','KU-001');s.apply_command({'operationId':'SYNTHETIC-NORMAL-WRITE-AFTER-A','actor':'student','kind':'personal.edit','generation':s.store.snapshot()['generation'],'expectedRevisions':{'review:KU-001':r['revision']},'changes':[{'namespace':'review','key':'KU-001','value':{'status':'weak'}}]});s.close()`,resolve('../legacy/review-board'),source],{encoding:'utf8'});assert.equal(wrote.status,0,wrote.stderr);
  core=new CourseService(resolve('dist/worker.cjs'));await core.migration.convert({sourceDirectory:source,directory:fresh});const b={sourceDirectory:source,contentCandidateDirectory:fresh,directory:newTarget,operationId:'prepare-B'};await assert.rejects(core.migration.prepare(b),/另一|身份|不同/);
  const abandoned=await (core.migration as any).abandon({sourceDirectory:source,operationId:'prepare-A'});assert.equal(abandoned.id,a.id);assert.ok(abandoned.abandonedAt);await assert.rejects(core.migration.prepare({...b,operationId:'prepare-A'}),/放弃|身份/);
  const prepared=await core.migration.prepare(b);assert.notEqual(prepared.id,a.id);await core.migration.publish({sourceDirectory:source,operationId:'prepare-B'});await assert.rejects(core.open(target),/未发布|切换/);await assert.rejects((core.migration as any).abandon({sourceDirectory:source,operationId:'prepare-B'}),/发布/);assert.equal((await (core.migration as any).transition({sourceDirectory:source,operationId:'prepare-A'})).targetDirectory,a.targetDirectory);const opened=await core.open(newTarget);assert.equal((await core.reviewStates(opened.sessionId)).units['KU-001'].status,'weak');
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a portable publication proof rejects an unrelated course database even though the original published database may receive legitimate later edits',async()=>{
 const {cp}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'yizhi-proof-identity-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target'),unrelated=join(root,'unrelated');let core=new CourseService(resolve('dist/worker.cjs'));
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'proof-identity'});await core.migration.publish({sourceDirectory:source,operationId:'proof-identity'});const c=await core.open(target);await core.setReviewStatus(c.sessionId,'KU-001','weak');await core.open(unrelated);await core.close();await cp(join(unrelated,'course.sqlite'),join(target,'course.sqlite'));
  core=new CourseService(resolve('dist/worker.cjs'));await assert.rejects(core.open(target),/身份|证明/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('another course really saves while a legacy conversion waits for registration, and while publication waits at its commit boundary',async()=>{
 const registration=new SharedArrayBuffer(4),publication=new SharedArrayBuffer(4),root=await mkdtemp(join(tmpdir(),'yizhi-other-course-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target'),core=new CourseService(resolve('dist/worker.cjs'),{migrationScheduling:{beforeRegistration:registration},cutoverScheduling:{beforePublish:publication}});
 const wait=async(buffer:SharedArrayBuffer)=>{for(let i=0;i<500&&Atomics.load(new Int32Array(buffer),0)!==1;i++)await new Promise(r=>setTimeout(r,10));assert.equal(Atomics.load(new Int32Array(buffer),0),1);};
 const bounded=async<T>(promise:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new Error('Other course blocked by migration')),3000);})]);}finally{clearTimeout(timer!);}};
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);const other=await core.open(join(root,'other'));const converting=core.migration.convert({sourceDirectory:source,directory:candidate});
  try{await wait(registration);await bounded(core.save({sessionId:other.sessionId,operationId:'other-during-convert',inputSeq:1,baseRevision:other.revision,blockId:other.editableBlockId,text:'SYNTHETIC other course during conversion'}));}finally{Atomics.store(new Int32Array(registration),0,2);await converting;}
  await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'isolation-publication'});const publishing=core.migration.publish({sourceDirectory:source,operationId:'isolation-publication'});
  try{await wait(publication);const current=await bounded(core.read(other.sessionId));await bounded(core.save({sessionId:other.sessionId,operationId:'other-during-publish',inputSeq:2,baseRevision:current.revision,blockId:current.editableBlockId,text:'SYNTHETIC other course during publication'}));}finally{Atomics.store(new Int32Array(publication),0,2);await publishing;}
 }finally{Atomics.store(new Int32Array(registration),0,2);Atomics.store(new Int32Array(publication),0,2);await core.close();await rm(root,{recursive:true,force:true});}
});

test('a draft whose original operation already committed is confirmed without reapplying and its expired payload is pruned while an unresolved draft stays recoverable',async()=>{
 const clock=new SharedArrayBuffer(8);Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()));const root=await mkdtemp(join(tmpdir(),'yizhi-confirmed-draft-')),source=join(root,'source'),candidate=join(root,'candidate'),core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'confirmed-draft'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);await core.migration.personal({...c,sourceDirectory:source});const p=await core.migration.pending(c);assert.equal(p.find(p=>p.id==='confirmed')!.state,'confirmed');assert.equal(p.find(p=>p.id==='unresolved')!.state,'unresolved');assert.equal((await core.annotations.list(c)).length,1);
  Atomics.store(new BigInt64Array(clock),0,BigInt(Date.now()+150*86400000));let clean=await core.retention.run({...c,limit:16});for(let i=0;clean.pending&&i<200;i++)clean=await core.retention.run({...c,limit:16});const after=await core.migration.pending(c);assert.equal(after.find(p=>p.id==='confirmed')!.payload,null);assert.ok(after.find(p=>p.id==='unresolved')!.payload);assert.equal((await core.annotations.list(c)).length,1);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});


test('cutover preserves an actually generated T30 unit, graph/theme lifecycle, original formal group and registered parse/source roots already in the T24 candidate',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-migration-generated-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target');let core=new CourseService(resolve('dist/worker.cjs'));
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});const state=await prepared(core,root,candidate),identity={sessionId:state.sessionId,taskId:state.task.id,attemptId:state.task.attemptId,generation:state.task.generation},basis=await core.readAgentGeneration(identity),receipt=await core.publishAgentGeneration({...identity,input:lesson(basis,'T30-before-cutover')});assert.equal(receipt.status,'committed');const unit=await core.readUnit(state.sessionId,'KU-GEN-MUX-01'),group=await core.formalHistory.detail({sessionId:state.sessionId,operationId:receipt.operationId}),versions=(await core.sources.list({sessionId:state.sessionId})).versions,artifacts=await core.parsing.artifacts({sessionId:state.sessionId,versionId:basis.source.versionId});await core.close();
  core=new CourseService(resolve('dist/worker.cjs'));await core.migration.prepare({sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'T30-containing-cutover'});await core.migration.publish({sourceDirectory:source,operationId:'T30-containing-cutover'});const moved=await core.open(target);assert.deepEqual(await core.readUnit(moved.sessionId,unit.id),unit);const graph=await core.graph(moved.sessionId);assert.ok(graph.nodes.some(n=>n.id===unit.id));assert.ok(graph.groups.some(g=>g.id==='TH-GEN-MUX-01'));assert.deepEqual((await core.formalHistory.detail({...moved,operationId:receipt.operationId})).changes,group.changes);assert.deepEqual((await core.sources.list(moved)).versions,versions);assert.deepEqual(await core.parsing.artifacts({...moved,versionId:basis.source.versionId}),artifacts);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a newer committed WAL tail cannot be mistaken for the already imported personal source when its main database hash is unchanged',async()=>{
 const {spawn}=await import('node:child_process'),{readFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');const root=await mkdtemp(join(tmpdir(),'yizhi-source-wal-')),source=join(root,'source'),candidate=join(root,'candidate'),core=new CourseService(resolve('dist/worker.cjs'));let writer:ReturnType<typeof spawn>|undefined;
 try{await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);await core.migration.convert({sourceDirectory:source,directory:candidate});const c=await core.open(candidate);await core.migration.personal({...c,sourceDirectory:source});const original=await core.annotations.list(c),digest=async()=>createHash('sha256').update(await readFile(join(source,'.review-board/state.sqlite3'))).digest('hex'),before=await digest();
  writer=spawn('python3',['-B','-c',`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom reviewboard.storage import CourseStore\np=Path(sys.argv[2]);m=json.loads((p/'课程.json').read_text());s=CourseStore(p/m['state'],m['courseId']);r=s.read('notes','NOTE-T25-OBJECT');v=r['value'];v['text']='SYNTHETIC newer committed WAL tail';s.apply({'operationId':'NEW-WAL-TAIL','actor':'student','kind':'note.edit','generation':1,'expectedRevisions':{'notes:NOTE-T25-OBJECT':r['revision']},'changes':[{'namespace':'notes','key':'NOTE-T25-OBJECT','value':v}]});print('ready',flush=True);sys.stdin.readline();s.close()`,resolve('../legacy/review-board'),source],{stdio:['pipe','pipe','pipe']});let errors='';writer.stderr!.on('data',b=>errors+=b);await new Promise((yes,no)=>{writer!.stdout!.once('data',yes);writer!.once('exit',()=>no(Error(errors)));});assert.equal(await digest(),before);
  await assert.rejects(core.migration.personal({...c,sourceDirectory:source}),/源个人记录已变化/);assert.deepEqual(await core.annotations.list(c),original);
 }finally{if(writer?.exitCode===null&&writer.signalCode===null){const ended=once(writer,'exit');writer.stdin!.end('\n');await ended;}await core.close();await rm(root,{recursive:true,force:true});}
});
