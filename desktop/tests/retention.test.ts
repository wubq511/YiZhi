import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp,writeFile,readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { parsingFixture } from './parsing-fixture';
import { createHash } from 'node:crypto';
import { legacyFixture } from './migration-fixture';
const DAY=86_400_000,A='RB-TH-01-01-what-is-positional-notation';
test('retention defaults to 140 positive integer days and follows the course through reopen and a stopped portable copy',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-policy-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(join(root,'course')),api=(core as any).retention;
  assert.equal((await api.get(c)).days,140);
  for(const days of [0,-1,1.2,'140',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(api.set({...c,days}),/正整数/);
  assert.equal((await api.set({...c,days:30})).days,30);
  await core.close();await cp(join(root,'course'),join(root,'portable'),{recursive:true});core=new CourseService(resolve('dist/worker.cjs'));
  const reopened=await core.open(join(root,'portable'));
  assert.equal((await core.retention.get(reopened)).days,30);
  assert.match((await core.retention.set({...reopened,days:365})).notice,/不能找回/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('clock rollback expires by formal time while retained versions still reconstruct through necessary original window references',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-rollback-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});let db:DatabaseSync|undefined;
 try{
  const c=await core.open(root);await core.save({...c,operationId:'window-before-clock-rollback',inputSeq:1,baseRevision:1,blockId:A,text:'Window body before clock rollback'});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t));const old=await core.save({...c,operationId:'backdated-formal-group',inputSeq:2,baseRevision:2,blockId:A,text:'Backdated original bridge body'});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+160*DAY));await core.save({...c,operationId:'current-after-rollback',inputSeq:3,baseRevision:3,blockId:A,text:'Current after rollback'});
  let r=await core.retention.run({...c,limit:2});for(let i=0;r.pending&&i<1000;i++)r=await core.retention.run({...c,limit:2});
  assert.equal((await core.retention.get(c)).pendingGroups,0);await assert.rejects(core.formalHistory.detail({...c,operationId:'backdated-formal-group'}),/过期/);
  const preview=await core.formalHistory.preview({...c,unitId:'KU-001',atOperationId:'window-before-clock-rollback',side:'after'});
  assert.equal(preview.unit!.reading.blocks[0].payload.text,'Window body before clock rollback');await core.formalHistory.release({...c,token:preview.token});
  assert.deepEqual(await core.queryOperation(c.sessionId,'backdated-formal-group'),old);
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+310*DAY));r=await core.retention.run({...c,limit:2});for(let i=0;r.pending&&i<1000;i++)r=await core.retention.run({...c,limit:2});
  db=new DatabaseSync(join(root,'course.sqlite'));assert.equal(Number(db.prepare("SELECT count(*) n FROM operations WHERE after_text LIKE '%Backdated original bridge body%' OR before_text LIKE '%Backdated original bridge body%'").get()!.n),0);
  assert.equal((await core.read(c.sessionId)).unit.reading.blocks[0].payload.text,'Current after rollback');
 }finally{db?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('active selection versions outlive expired detail for annotation capture, then unused protected versions can expire after selection release',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-selection-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});let db:DatabaseSync|undefined;
 try{
  const c=await core.open(root);await core.save({...c,operationId:'selection-unused',inputSeq:1,baseRevision:1,blockId:A,text:'Old unused selection predecessor'});
  await core.save({...c,operationId:'selection-shown',inputSeq:2,baseRevision:2,blockId:A,text:'Selection original body'});const shown=await core.read(c.sessionId),block=shown.unit.reading.blocks[0];
  await core.commands.protect({...c,editorId:'live-selection',sequence:1,inputSeq:2,blockIds:[A],mode:'selection'});
  const attempt=await core.commands.startAttempt({...c,taskId:'selection-independent-producer'}),basis=await core.commands.read({...c,attemptId:attempt.attemptId,objectIds:[A]});
  assert.equal((await core.commands.commit({...c,operationId:'selection-later',attemptId:attempt.attemptId,basisId:basis.basisId,changes:[{objectId:A,value:{...basis.objects.find(o=>o.id===A)!.value,payload:{...block.payload,text:'Current new formal body'}}}]})).status,'committed');await core.commands.stop({...c,attemptId:attempt.attemptId});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));let r=await core.retention.run({...c,limit:16});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:16});
  const note=await core.annotations.create({...c,operationId:'capture-actual-held-selection',text:'Student thought on the actual old selection',selection:{unitId:'KU-001',fragments:[{blockId:A,block,field:'text',formalRevision:shown.revision,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:block.payload.text},from:0,to:9,quote:'Selection'}]}});
  assert.equal(note.original.fragments[0].block.payload.text,'Selection original body');
  await core.commands.protect({...c,editorId:'live-selection',sequence:2,inputSeq:2,blockIds:[],mode:'selection'});
  r=await core.retention.run({...c,limit:16});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:16});
  db=new DatabaseSync(join(root,'course.sqlite'));assert.equal(Number(db.prepare("SELECT count(*) n FROM annotation_versions WHERE block LIKE '%Old unused selection predecessor%'").get()!.n),0);
  assert.equal((await core.annotations.list(c))[0].original.fragments[0].block.payload.text,'Selection original body');
 }finally{db?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('an uncertain course restore durably protects its original scope across cleanup and reopen until exact retry resolves it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-restore-pin-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 let core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});let fault:DatabaseSync|undefined;
 try{
  const c=await core.open(root);await core.save({...c,operationId:'pinned-anchor',inputSeq:1,baseRevision:1,blockId:A,text:'Pinned historical target'});await core.save({...c,operationId:'pinned-later',inputSeq:2,baseRevision:2,blockId:A,text:'Current before uncertain restore'});
  const preview=await core.courseRestore.preview({...c,atOperationId:'pinned-anchor',side:'after',unitIds:['KU-001'],userState:{layout:false,review:false}});
  fault=new DatabaseSync(join(root,'course.sqlite'));fault.exec("CREATE TRIGGER fail_uncertain_restore BEFORE INSERT ON cg_history BEGIN SELECT RAISE(ABORT,'uncertain restore storage fault'); END");
  await assert.rejects(core.courseRestore.apply({...c,operationId:'uncertain-restore',preview}),/uncertain restore storage fault/);fault.exec('DROP TRIGGER fail_uncertain_restore');fault.close();fault=undefined;
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));await core.close();core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});const reopened=await core.open(root);
  let r=await core.retention.run({...reopened,limit:16});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...reopened,limit:16});assert.match(r.blocked??'',/恢复/);
  assert.equal(await core.courseRestore.query({...reopened,operationId:'uncertain-restore'}),null);await core.formalHistory.detail({...reopened,operationId:'pinned-anchor'});
  const receipt=await core.courseRestore.apply({...reopened,operationId:'uncertain-restore',preview});assert.equal(receipt.generation,2);
  r=await core.retention.run({sessionId:receipt.sessionId,limit:16});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({sessionId:receipt.sessionId,limit:16});
  await assert.rejects(core.formalHistory.detail({sessionId:receipt.sessionId,operationId:'pinned-anchor'}),/过期/);
  assert.deepEqual(await core.courseRestore.query({sessionId:receipt.sessionId,operationId:'uncertain-restore'}),receipt);
 }finally{fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('a waiting business task keeps actual recovery reads after model completion; ended reads are later cropped while unresolved candidates, visible messages, retired drafts and runtime roots survive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-purpose-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});let fault:DatabaseSync|undefined;
 try{
  const c=await core.open(root),sessionId=c.sessionId,conversation=await core.agent.create({...c,operationId:'purpose-conversation'});
  const task=await core.agent.submit({...c,operationId:'purpose-task',conversationId:conversation.id,generation:1,intent:'modify',text:'Modify current teaching',target:{unitId:'KU-001'}}),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:1};
  await core.recordAgent({...identity,eventId:'bind',kind:'bind',threadId:'purpose-thread',turnId:'purpose-turn'});
  const read=await core.readAgentMutation(identity);
  await core.recordAgent({...identity,eventId:'read-tool',kind:'tool',tool:{name:'yizhi_read_edit_context',input:{target:'KU-001'},output:read,references:[]}});
  await core.save({...c,operationId:'purpose-student',inputSeq:1,baseRevision:1,blockId:A,text:'Student independently changed current body'});
  const candidate=await core.applyAgentMutation({...identity,input:{operationId:'unprocessed-purpose-candidate',basisId:read.basisId,conclusionOrMethodChanged:false,updates:[{blockId:A,text:'Unprocessed proposed teaching remains explicit'}]}});assert.equal(candidate.status,'retained');
  await core.recordAgent({...identity,eventId:'answer',kind:'message',itemId:'visible',text:'Actual visible explanation stays in conversation'});
  await core.recordAgent({...identity,eventId:'model-completed',kind:'finish',status:'completed'});
  assert.equal((await core.agentTask({sessionId,taskId:task.id})).status,'waiting');
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
  let r=await core.retention.run({...c,limit:8});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:8});
  assert.equal((await core.agent.get({...c,conversationId:conversation.id})).toolFacts[0].hasRecoveryPayload,true);
  await core.save({...c,operationId:'purpose-current-anchor',inputSeq:2,baseRevision:2,blockId:A,text:'Current protected teaching'});
  const draft={sessionId,inputSeq:3,baseRevision:3,complete:false,changes:[],formulaDrafts:[{blockId:A,latex:'\\frac{'}]};await core.saveDraft(draft);
  const p=await core.courseRestore.preview({...c,atOperationId:'purpose-current-anchor',side:'after',unitIds:['KU-001'],userState:{layout:false,review:false}}),restored=await core.courseRestore.apply({...c,operationId:'purpose-epoch',preview:p});
  fault=new DatabaseSync(join(root,'course.sqlite'));fault.exec('CREATE TRIGGER postpone_tool_crop BEFORE UPDATE OF input ON agent_tool_recovery BEGIN SELECT RAISE(IGNORE); END');
  await core.recordAgent({...identity,eventId:'actual-interrupted',kind:'finish',status:'interrupted'});
  assert.ok(fault.prepare('SELECT input FROM agent_tool_recovery LIMIT 1').get()!.input);
  fault.exec('DROP TRIGGER postpone_tool_crop');
  const runtime=await core.experiments.open({sessionId:restored.sessionId,unitId:'KU-057',blockId:'RB-TH-13-057-010-interactive'});
  const scene=await core.experiments.snapshot({sessionId:restored.sessionId,instanceId:runtime.instanceId});
  r=await core.retention.run({sessionId:restored.sessionId,limit:8});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({sessionId:restored.sessionId,limit:8});
  const view=await core.agent.get({sessionId:restored.sessionId,conversationId:conversation.id});assert.equal(view.toolFacts[0].hasRecoveryPayload,false);
  assert.ok(view.messages.some(m=>m.text==='Actual visible explanation stays in conversation'));
  assert.ok((await core.commands.candidates({sessionId:restored.sessionId})).some(v=>v.command.operationId===candidate.operationId&&JSON.stringify(v.command).includes('Unprocessed proposed')));
  assert.deepEqual((await core.courseRestore.drafts({sessionId:restored.sessionId}))[0].input,draft);
  assert.deepEqual(await core.experiments.snapshot({sessionId:restored.sessionId,instanceId:runtime.instanceId}),scene);
 }finally{fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('an unknown executor with active reconciliation retains tool recovery until resolved without regaining write qualification',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-unknown-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{
  const c=await core.open(root),conversation=await core.agent.create({...c,operationId:'unknown-conversation'}),task=await core.agent.submit({...c,operationId:'unknown-task',conversationId:conversation.id,generation:1,intent:'modify',text:'Unknown modification result',target:{unitId:'KU-001'}}),identity={sessionId:c.sessionId,taskId:task.id,attemptId:task.attemptId,generation:1};
  const basis=await core.readAgentMutation(identity);
  await core.recordAgent({...identity,eventId:'unknown-read',kind:'tool',tool:{name:'yizhi_read_edit_context',input:{target:'KU-001'},output:basis,references:[]}});
  await core.recordAgent({...identity,eventId:'transport-unknown',kind:'finish',status:'unknown',recovery:{state:'active',checkedAt:new Date(t).toISOString(),detail:'Original executor turn is still active'}});
  assert.equal((await core.agent.get({...c,conversationId:conversation.id})).toolFacts[0].hasRecoveryPayload,true);
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));let r=await core.retention.run({...c,limit:16});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:16});
  assert.equal((await core.agent.get({...c,conversationId:conversation.id})).toolFacts[0].hasRecoveryPayload,true);
  await assert.rejects(core.applyAgentMutation({...identity,input:{operationId:'unknown-cannot-write',basisId:basis.basisId,conclusionOrMethodChanged:false,updates:[{blockId:A,text:'Must not write'}]}}),/停止|失效|运行|资格/);
  await core.recordAgent({...identity,eventId:'original-resolved',kind:'finish',status:'completed',reconciliation:true,recovery:{state:'resolved',checkedAt:new Date(t+150*DAY).toISOString(),detail:'Original executor result checked'}});
  r=await core.retention.run({...c,limit:16});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:16});
  assert.equal((await core.agent.get({...c,conversationId:conversation.id})).toolFacts[0].hasRecoveryPayload,false);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('automatic idle batches expire the old window without requiring a cleanup call while new input and an independent course continue committing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-auto-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock}});
 try{
  const a=await core.open(join(root,'first')),b=await core.open(join(root,'second'));
  await core.save({...a,operationId:'auto-old',inputSeq:1,baseRevision:1,blockId:A,text:'Expired automatic body'});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
  const current=await core.save({...a,operationId:'auto-current',inputSeq:2,baseRevision:2,blockId:A,text:'Current automatic body'});
  await core.save({...b,operationId:'independent-current',inputSeq:1,baseRevision:1,blockId:A,text:'Independent current body'});
  let status=await core.retention.get(a);for(let i=0;status.pendingGroups&&i<500;i++){await new Promise(r=>setTimeout(r,10));status=await core.retention.get(a);}
  assert.equal(status.pendingGroups,0);await assert.rejects(core.formalHistory.detail({...a,operationId:'auto-old'}),/过期/);
  assert.equal((await core.read(a.sessionId)).confirmedInputSeq,current.inputSeq);assert.equal((await core.read(b.sessionId)).unit.reading.blocks[0].payload.text,'Independent current body');
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('storage categories distinguish disposable search cache from history and clearing cache preserves formal history and original operation results',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-space-')),core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{manual:true}});
 try{
  const c=await core.open(root),receipt=await core.save({...c,operationId:'cache-preserved-history',inputSeq:1,baseRevision:1,blockId:A,text:'Cache rebuildable literal'});
  await core.search.rebuild({...c,batchSize:8});const before=await core.retention.space(c);
  assert.ok(before.categories.find(x=>x.id==='cache')!.bytes>0);assert.ok(before.categories.find(x=>x.id==='history')!.bytes>0);
  let result=await core.retention.clearCache({...c,limit:16});for(let i=0;result.pending&&i<100;i++)result=await core.retention.clearCache({...c,limit:16});assert.equal(result.pending,false);
  const after=await core.retention.space(c);assert.equal(after.categories.find(x=>x.id==='cache')!.bytes,0);
  assert.equal(after.categories.find(x=>x.id==='history')!.bytes,before.categories.find(x=>x.id==='history')!.bytes);
  assert.ok((await core.formalHistory.detail({...c,operationId:receipt.operationId})).changes.length);
  assert.deepEqual(await core.queryOperation(c.sessionId,receipt.operationId),receipt);assert.equal((await core.read(c.sessionId)).confirmedInputSeq,receipt.inputSeq);
  assert.ok((await core.search.query({...c,query:'Cache rebuildable'})).hits.length);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('the legacy whole-unit cache becomes an explicit provenance manifest after its window while current content, unknown metadata and registered resources remain readable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-legacy-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{
  const original=await legacyFixture(join(root,'old'));await core.migration.convert({sourceDirectory:join(root,'old'),directory:join(root,'candidate')});
  const c=await core.open(join(root,'candidate')),imported=await core.migration.content(c);assert.deepEqual(imported.knowledge,original.knowledge);
  const block=c.unit.reading.blocks.find(b=>b.kind==='paragraph')!;await core.save({...c,operationId:'changed-imported-body',inputSeq:1,baseRevision:c.revision,blockId:A,text:'Current replacement after conversion'});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));let r=await core.retention.run({...c,limit:8});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:8});
  const retained=await core.migration.content(c);
  assert.equal(retained.retention?.originalUnitBodies,'expired');assert.ok(!JSON.stringify(retained.knowledge.units).includes(block.payload.text));
  assert.deepEqual(retained.knowledge.extra,original.knowledge.extra);assert.deepEqual(retained.knowledge.questions,original.knowledge.questions);assert.deepEqual(retained.report.sourceHashes,imported.report.sourceHashes);
  assert.equal((await core.read(c.sessionId)).unit.reading.blocks[0].payload.text,'Current replacement after conversion');
  assert.ok((await core.sources.page({...c,versionId:'VER-TEST',pdfPageIndex:0})).projection.text);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('registered uncited sources and real parse products remain roots; a persistent backup lease prevents orphan resource reclamation until explicit release',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-resources-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 let core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{
  let c=await core.open(join(root,'course'));const pdf=join(root,'uncited.pdf');await parsingFixture(pdf);
  await core.save({...c,operationId:'independent-backup-history',inputSeq:1,baseRevision:1,blockId:A,text:'Original stopped backup history'});
  const source=(await core.sources.importFile({...c,generation:1,operationId:'uncited-source',path:pdf,title:'Deferred uncited original'})).version;
  const started=await core.parsing.start({...c,generation:1,operationId:'registered-parse',versionId:source.versionId});
  let parsed=await core.parsing.get({...c,taskId:started.taskId});for(let i=0;parsed.status==='running'&&i<500;i++){await new Promise(r=>setTimeout(r,10));parsed=await core.parsing.get({...c,taskId:started.taskId});}
  assert.equal(parsed.status,'completed');assert.equal(parsed.confirmed.length,2);
  const product=await core.parsing.artifact({...c,artifactId:parsed.confirmed[0].artifactId});
  const bytes=Buffer.from('Complete unregistered resource from an interrupted publication'),hash=createHash('sha256').update(bytes).digest('hex'),orphan=join(root,'course/resources',hash);await writeFile(orphan,bytes);
  await core.retention.resourceLease({...c,id:'backup-copy-1',action:'acquire'});
  await core.close();await cp(join(root,'course'),join(root,'independent-backup'),{recursive:true});
  core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});c=await core.open(join(root,'course'));
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
  let r=await core.retention.run({...c,limit:8});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...c,limit:8});
  assert.deepEqual(await readFile(orphan),bytes);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});const reopened=await core.open(join(root,'course'));
  assert.equal((await core.retention.resourceLeases(reopened)).filter(l=>l.state==='active').length,1);
  await core.retention.resourceLease({...reopened,id:'backup-copy-1',action:'release'});
  r=await core.retention.run({...reopened,limit:8});for(let i=0;r.pending&&i<100;i++)r=await core.retention.run({...reopened,limit:8});
  await assert.rejects(readFile(orphan),{code:'ENOENT'});
  assert.ok((await core.sources.list(reopened)).versions.some(v=>v.versionId===source.versionId));
  assert.deepEqual(await core.parsing.artifact({...reopened,artifactId:parsed.confirmed[0].artifactId}),product);
  assert.ok((await core.sources.page({...reopened,versionId:source.versionId,pdfPageIndex:0})).projection.text);
  await assert.rejects(core.formalHistory.detail({...reopened,operationId:'independent-backup-history'}),/过期/);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});const backup=await core.open(join(root,'independent-backup'));
  // A stopped fixture copy demonstrates retention independence; T26 owns live SQLite backup.
  await core.retention.resourceLease({...backup,id:'backup-copy-1',action:'release'});
  assert.equal((await core.formalHistory.detail({...backup,operationId:'independent-backup-history'})).changes[0].after!.payload.text,'Original stopped backup history');
  assert.deepEqual(await readFile(join(root,'independent-backup/resources',hash)),bytes);
  assert.deepEqual(await core.parsing.artifact({...backup,artifactId:parsed.confirmed[0].artifactId}),product);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
for(const point of ['beforeCommit','afterCommit'] as const)test(`cleanup SIGKILL at ${point} resumes with the whole group and unchanged input/receipt/cursor identities`,async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-process-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 let core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{
  const c=await core.open(root),receipt=await core.save({sessionId:c.sessionId,operationId:'process-old',inputSeq:1,baseRevision:1,blockId:A,text:'Old process body'});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));await core.save({sessionId:c.sessionId,operationId:'process-window',inputSeq:2,baseRevision:2,blockId:A,text:'Current process body'});
  const before=await core.read(c.sessionId);await core.close();
  const child=fork(resolve('dist/tests/retention-process.cjs'),[root,point,String(t+150*DAY)],{stdio:['ignore','ignore','pipe','ipc'],env:process.env});let errors='';child.stderr?.on('data',b=>errors+=b);
  try{
   const reached=await new Promise<any>((yes,no)=>{const timer=setTimeout(()=>no(new Error('Cleanup gate timeout '+errors)),10000);child.once('message',value=>{clearTimeout(timer);yes(value);});child.once('exit',()=>{clearTimeout(timer);no(new Error('Child exited '+errors));});});assert.equal(reached.point,point,JSON.stringify(reached));
   const killed=once(child,'exit');child.kill('SIGKILL');await killed;
   core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});const reopened=await core.open(root);
   assert.equal(reopened.generation,before.generation);assert.equal(reopened.eventCursor,before.eventCursor);assert.deepEqual(reopened.unit,before.unit);
   if(point==='beforeCommit')await core.formalHistory.detail({...reopened,operationId:'process-old'});else await assert.rejects(core.formalHistory.detail({...reopened,operationId:'process-old'}),/过期/);
   let r=await core.retention.run({...reopened,limit:1});for(let i=0;r.pending&&i<50;i++)r=await core.retention.run({...reopened,limit:1});
   assert.deepEqual(await core.queryOperation(reopened.sessionId,'process-old'),receipt);await assert.rejects(core.formalHistory.detail({...reopened,operationId:'process-old'}),/过期/);
   assert.equal((await core.retention.run(reopened)).removed,0);
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('expired duplicate reads and personal edit details are cropped while the current note and its original orphan context remain independent roots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-payload-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});let db:DatabaseSync|undefined;
 try{
  const c=await core.open(root),sessionId=c.sessionId;
  await core.save({sessionId,operationId:'unused-version',inputSeq:1,baseRevision:1,blockId:A,text:'Unused old annotation body'});
  await core.save({sessionId,operationId:'original-note-context',inputSeq:2,baseRevision:2,blockId:A,text:'Original chosen note context'});
  const snapshot=await core.read(sessionId),block=snapshot.unit.reading.blocks[0];
  const note=await core.annotations.create({sessionId,operationId:'note-old-detail',text:'Old note edit detail only',selection:{unitId:'KU-001',fragments:[{blockId:A,block,field:'text',formalRevision:snapshot.revision,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:block.payload.text},from:0,to:8,quote:'Original'}]}});
  await core.annotations.update({sessionId,operationId:'note-current-detail',id:note.id,expectedVersion:note.version,text:'Current student thought'});
  const attempt=await core.commands.startAttempt({sessionId,taskId:'ended-read-purpose'}),basis=await core.commands.read({sessionId,attemptId:attempt.attemptId,objectIds:[A],context:true});
  await core.commands.stop({sessionId,attemptId:attempt.attemptId});
  await core.save({sessionId,operationId:'new-note-context',inputSeq:3,baseRevision:3,blockId:A,text:'Current unrelated replacement'});
  const current=(await core.annotations.list(c))[0];assert.equal(current.current.status,'orphan');
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
  let step=await core.retention.run({sessionId,limit:2});for(let i=0;step.pending&&i<100;i++)step=await core.retention.run({sessionId,limit:2});
  assert.equal(step.blocked,undefined);assert.deepEqual((await core.annotations.list(c))[0],current);
  db=new DatabaseSync(join(root,'course.sqlite'));
  assert.equal(db.prepare('SELECT domain_basis FROM cg_bases WHERE id=?').get(basis.basisId)!.domain_basis,null);
  assert.equal(Number(db.prepare("SELECT count(*) n FROM annotation_operations WHERE result LIKE '%Old note edit detail only%'").get()!.n),0);
  assert.equal(Number(db.prepare("SELECT count(*) n FROM annotation_versions WHERE block LIKE '%Unused old annotation body%'").get()!.n),0);
  assert.ok(Number(db.prepare("SELECT count(*) n FROM annotation_versions WHERE block LIKE '%Original chosen note context%'").get()!.n)>0);
  await assert.rejects(core.annotations.query({sessionId,operationId:'note-old-detail'}),/过期|清理/);
  await assert.rejects(core.annotations.update({sessionId,operationId:'note-old-detail',id:note.id,expectedVersion:current.version,text:'Must not replay'}),/过期|清理/);
 }finally{db?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('an active recovery preview pins its complete aggregate; a real cleanup fault leaves both body and layout history intact before resumed cleanup',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-atomic-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});let fault:DatabaseSync|undefined;
 try{
  const c=await core.open(root),sessionId=c.sessionId,attempt=await core.commands.startAttempt({sessionId,taskId:'retention-aggregate'});
  const basis=await core.commands.read({sessionId,attemptId:attempt.attemptId,objectIds:[A],context:true}),block=basis.objects.find(o=>o.id===A)!.value,n=basis.context!.layout[0];
  const receipt=await core.commands.commit({sessionId,operationId:'old-aggregate',attemptId:attempt.attemptId,basisId:basis.basisId,changes:[{objectId:A,value:{...block,payload:{...block.payload,text:'Aggregate old body'}}}],bundle:{layout:[{unitId:n.unitId,x:n.x+40,y:n.y,width:n.width}]}});
  assert.equal(receipt.status,'committed');await core.commands.stop({sessionId,attemptId:attempt.attemptId});
  const p=await core.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['old-aggregate']}});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
  let r=await core.retention.run({sessionId,limit:1});for(let i=0;r.pending&&i<30;i++)r=await core.retention.run({sessionId,limit:1});
  assert.match(r.blocked??'',/预览|恢复/);assert.equal((await core.formalHistory.detail({sessionId,operationId:'old-aggregate'})).changes.length,2);
  await core.formalHistory.release({sessionId,token:p.token});
  const before=await core.read(sessionId),graph=await core.graph(sessionId);
  fault=new DatabaseSync(join(root,'course.sqlite'));fault.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON history_expired BEGIN SELECT RAISE(ABORT,'retention actual SQLite fault'); END");
  await assert.rejects(core.retention.run({sessionId,limit:1}),/retention actual SQLite fault/);
  assert.equal((await core.formalHistory.detail({sessionId,operationId:'old-aggregate'})).changes.length,2);
  assert.deepEqual(await core.read(sessionId),before);assert.deepEqual(await core.graph(sessionId),graph);
  fault.exec('DROP TRIGGER fail_retention');
  assert.equal((await core.retention.run({sessionId,limit:1})).removed,1);
  await assert.rejects(core.formalHistory.detail({sessionId,operationId:'old-aggregate'}),/过期/);
  assert.deepEqual(await core.commands.query({sessionId,operationId:'old-aggregate'}),receipt);
  assert.deepEqual(await core.read(sessionId),before);assert.deepEqual(await core.graph(sessionId),graph);
 }finally{fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
test('bounded cleanup expires complete groups while the first retained before/after versions reconstruct and original receipts never replay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-retention-window-')),clock=new SharedArrayBuffer(8),t=Date.parse('2030-01-01T00:00:00Z');Atomics.store(new BigInt64Array(clock),0,BigInt(t));
 const core=new CourseService(resolve('dist/worker.cjs'),{retentionScheduling:{clock,manual:true}});
 try{
  const c=await core.open(root),sessionId=c.sessionId;
  const old={sessionId,operationId:'old-1',inputSeq:1,baseRevision:1,blockId:A,text:'Old teaching body before retention'};
  const receipt=await core.save(old);
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+130*DAY));
  await core.save({sessionId,operationId:'window-1',inputSeq:2,baseRevision:2,blockId:A,text:'Window body'});
  Atomics.store(new BigInt64Array(clock),0,BigInt(t+150*DAY));
  await core.save({sessionId,operationId:'current-1',inputSeq:3,baseRevision:3,blockId:A,text:'Current teaching body'});
  const before=await core.read(sessionId),api=core.retention;
  let step=await api.run({sessionId,limit:1});for(let i=0;step.pending&&i<2000;i++)step=await api.run({sessionId,limit:1});
  assert.equal(step.pending,false);assert.equal((await api.get(c)).pendingGroups,0);
  await assert.rejects(core.formalHistory.detail({sessionId,operationId:'old-1'}),/过期|清理/);
  const preview=await core.formalHistory.preview({sessionId,unitId:'KU-001',atOperationId:'window-1',side:'before'});
  assert.equal(preview.unit!.reading.blocks[0].payload.text,old.text);
  assert.deepEqual(await core.save(old),receipt);assert.deepEqual(await core.queryOperation(sessionId,'old-1'),receipt);
  assert.deepEqual(await core.read(sessionId),before);
  assert.equal((await core.formalHistory.list(c)).activities.flatMap(a=>a.operationIds).includes('old-1'),false);
  assert.ok((await api.get(c)).removedBefore);
  await api.set({...c,days:500});await assert.rejects(core.formalHistory.detail({sessionId,operationId:'old-1'}),/过期|清理/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
