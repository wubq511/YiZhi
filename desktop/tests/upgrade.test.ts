import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,access,realpath,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import {DevelopmentCourseService as CourseService} from '../../tools/desktop/course-service';
import { oldDesktopCourse } from './old-desktop-fixture';
import { fork,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { legacyFixture } from './migration-fixture';
import { prepared as generationFixture,lesson,practice } from './generation-fixture';
const A='RB-TH-01-01-what-is-positional-notation';
async function reached(gate:SharedArrayBuffer){const end=Date.now()+20000;while(Atomics.load(new Int32Array(gate),0)!==1){if(Date.now()>end)throw new Error('升级阶段等待超时');await new Promise(r=>setTimeout(r,5));}}
const release=(gate:SharedArrayBuffer)=>Atomics.store(new Int32Array(gate),0,2);
test('controlled upgrade prepares an independently validated v2 work copy after full backup, freezes source writes, and keeps the original authority until publication',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-prepare-')),core=new CourseService(join(developmentDirectory(), 'worker.cjs'));
 try{
  const c=await oldDesktopCourse(core,join(root,'live'));await core.save({...c,operationId:'latest-before-upgrade',inputSeq:1,baseRevision:1,blockId:A,text:'Latest durable input before upgrade'});
  await core.saveDraft({...c,inputSeq:2,baseRevision:2,changes:[{blockId:A,text:'Acknowledged incomplete upgrade draft'}],complete:false});
  await core.setReviewStatus(c.sessionId,'KU-001','weak');
  const request={...c,directory:join(root,'v2'),backupDirectory:join(root,'before-upgrade'),upgradeId:'controlled-upgrade'};
  const prepared=await (core as any).upgrade.prepare(request);
  assert.equal(prepared.phase,'verified');assert.equal(prepared.kind,'format-upgrade');assert.equal(prepared.courseId,c.courseId);
  const target=await core.format.validate({directory:request.directory});assert.equal(target.capabilities.courseFormat,2);assert.equal(target.capabilities.minimumReader,2);
  assert.equal((await core.format.inspect({directory:join(root,'live')})).courseFormat,1);
  assert.equal((await core.backup.verify({directory:request.backupDirectory})).phase,'complete');
  await assert.rejects(core.save({...c,operationId:'must-not-write',inputSeq:3,baseRevision:2,blockId:A,text:'Forbidden during upgrade'}),/升级|停写/);
  await assert.rejects(core.open(request.directory),/未发布|切换/);
  await access(join(request.directory,'directory-authority.json'));
  await (core as any).upgrade.cancel({sessionId:c.sessionId,upgradeId:request.upgradeId});
  const reopened=await core.open(join(root,'live'));assert.equal(reopened.unit.reading.blocks[0].payload.text,'Latest durable input before upgrade');
  assert.equal(reopened.drafts[0].input.changes[0].text,'Acknowledged incomplete upgrade draft');assert.equal((await core.reviewStates(reopened.sessionId)).units['KU-001'].status,'weak');
  await assert.rejects(core.open(request.directory),/未发布|切换/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('publication through the shared authority admits only v2, preserves current identity/context/history and opens independently after Core restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-publish-'));let core=new CourseService(join(developmentDirectory(), 'worker.cjs'));
 try{
  const sourceDirectory=join(root,'live'),c=await oldDesktopCourse(core,sourceDirectory);
  await core.save({...c,operationId:'preserved-formal',inputSeq:1,baseRevision:1,blockId:A,text:'Preserved full body'});
  const reading={unitId:'KU-001',expanded:{'material:answer':true},returnStack:[],scrollTop:55,camera:{x:12,y:24,zoom:.8}};
  await core.setReadingState(c.sessionId,reading);await core.setReviewStatus(c.sessionId,'KU-001','mastered');
  const request={...c,directory:join(root,'v2'),backupDirectory:join(root,'backup'),upgradeId:'publish-one'};
  await core.upgrade.prepare(request);const decision=await (core as any).upgrade.publish({sessionId:c.sessionId,upgradeId:request.upgradeId});assert.equal(decision.phase,'published');
  await assert.rejects(core.open(sourceDirectory),/迁移|权威|目标/);
  const opened=await core.open(request.directory);assert.equal(opened.courseId,c.courseId);assert.equal(opened.unit.reading.blocks[0].payload.text,'Preserved full body');assert.deepEqual(await core.readingState(opened.sessionId),reading);assert.equal((await core.reviewStates(opened.sessionId)).units['KU-001'].status,'mastered');
  assert.equal((await core.history(opened.sessionId))[0].receipt.operationId,'preserved-formal');
  await core.close();core=new CourseService(join(developmentDirectory(), 'worker.cjs'));const reopened=await core.open(request.directory);assert.equal(reopened.courseId,c.courseId);assert.equal((await core.format.inspect({directory:request.directory})).courseFormat,2);
  const recovered=await core.upgrade.recover({directory:sourceDirectory});assert.equal(recovered.directory,await realpath(request.directory));
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
for(const point of ['beforePublish','afterPublish'])test('SIGKILL '+point+' reconciles one writable directory from the shared source decision',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-kill-'));let core=new CourseService(join(developmentDirectory(), 'worker.cjs'));let child:ReturnType<typeof fork>|undefined;
 try{
  const sourceDirectory=join(root,'live'),c=await oldDesktopCourse(core,sourceDirectory);await core.save({...c,operationId:'before-upgrade-kill',inputSeq:1,baseRevision:1,blockId:A,text:'Durable body at publication boundary'});await core.close();
  child=fork(resolve('dist/tests/upgrade-process.cjs'),[sourceDirectory,join(root,'v2'),join(root,'backup'),point],{stdio:['ignore','pipe','pipe','ipc']});
  const [event]=await once(child,'message');assert.deepEqual(event,{point});child.kill('SIGKILL');await once(child,'exit');child=undefined;
  core=new CourseService(join(developmentDirectory(), 'worker.cjs'));const recovered=await core.upgrade.recover({directory:sourceDirectory});
  if(point==='beforePublish'){
   assert.equal(recovered.directory,await realpath(sourceDirectory));const old=await core.open(sourceDirectory);await assert.rejects(core.open(join(root,'v2')),/未发布|切换/);
   const receipt=await core.upgrade.publish({sessionId:old.sessionId,upgradeId:'kill-upgrade'});assert.equal(receipt.phase,'published');
  }else {assert.equal(recovered.directory,await realpath(join(root,'v2')));await assert.rejects(core.open(sourceDirectory),/迁移|权威|目标/);}
  const target=await core.open(join(root,'v2'));assert.equal(target.unit.reading.blocks[0].payload.text,'Durable body at publication boundary');
  await assert.rejects(core.open(sourceDirectory),/迁移|权威|目标/);await core.backup.verify({directory:join(root,'backup')});
  const exact=await core.upgrade.publish({sourceDirectory,upgradeId:'kill-upgrade'});assert.equal(exact.id,(await core.upgrade.status({directory:join(root,'v2')})).decision!.id);
 }finally{if(child){child.kill('SIGKILL');await once(child,'exit');}await core.close();await rm(root,{recursive:true,force:true});}
});
test('upgrade file staging leaves another course reads/saves progressing while all original-course admissions are stopped',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-progress-')),gate=new SharedArrayBuffer(4),core=new CourseService(join(developmentDirectory(), 'worker.cjs'),{upgradeScheduling:{afterBackup:gate}});let pending:Promise<unknown>|undefined;
 try{
  const c=await oldDesktopCourse(core,join(root,'live')),other=await core.open(join(root,'other'));pending=core.upgrade.prepare({...c,directory:join(root,'v2'),backupDirectory:join(root,'backup'),upgradeId:'other-progress'});pending.catch(()=>{});await reached(gate);
  await assert.rejects(core.save({...c,operationId:'stopped-write',inputSeq:1,baseRevision:1,blockId:A,text:'Must not enter snapshot'}),/停|升级/);
  for(let i=1;i<=4;i++){await core.save({...other,operationId:'progress-'+i,inputSeq:i,baseRevision:i,blockId:A,text:'Other course '+i});assert.equal((await core.read(other.sessionId)).unit.reading.blocks[0].payload.text,'Other course '+i);}
  release(gate);await pending;await core.upgrade.cancel({sessionId:c.sessionId,upgradeId:'other-progress'});
 }finally{release(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});
test('invalid work-copy references retain backup and diagnostics and return to the intact original course',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-invalid-')),gate=new SharedArrayBuffer(4),core=new CourseService(join(developmentDirectory(), 'worker.cjs'),{upgradeScheduling:{beforeValidation:gate}});let pending:Promise<unknown>|undefined;
 try{
  const c=await oldDesktopCourse(core,join(root,'live')),request={...c,directory:join(root,'v2'),backupDirectory:join(root,'backup'),upgradeId:'invalid-copy'};
  pending=core.upgrade.prepare(request);pending.catch(()=>{});await reached(gate);
  const fault=new DatabaseSync(join(request.directory,'course.sqlite'));fault.exec("PRAGMA foreign_keys=OFF; INSERT INTO source_citations VALUES('broken','missing-source','{}')");fault.close();release(gate);
  await assert.rejects(pending,/结构|外键/);assert.equal((await core.backup.verify({directory:request.backupDirectory})).phase,'complete');
  assert.match(await readFile(join(request.directory,'upgrade-diagnostic.json'),'utf8'),/结构|外键/);
  const old=await core.open(join(root,'live'));await core.save({...old,operationId:'after-failed-upgrade',inputSeq:1,baseRevision:1,blockId:A,text:'Original is usable after failed validation'});
  await assert.rejects(core.open(request.directory),/未发布|切换/);
 }finally{release(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});
test('publication lease rechecks unversioned source state from committed WAL rather than trusting a held flag or event cursor',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-source-version-')),gate=new SharedArrayBuffer(4),core=new CourseService(join(developmentDirectory(), 'worker.cjs'),{cutoverScheduling:{beforePublish:gate}});let pending:Promise<unknown>|undefined;
 try{
  const directory=join(root,'live'),c=await oldDesktopCourse(core,directory);await core.upgrade.prepare({...c,directory:join(root,'v2'),backupDirectory:join(root,'backup'),upgradeId:'native-proof'});
  pending=core.upgrade.publish({sessionId:c.sessionId,upgradeId:'native-proof'});pending.catch(()=>{});await reached(gate);
  const fault=new DatabaseSync(join(directory,'course.sqlite'));fault.exec('PRAGMA busy_timeout=1000');fault.prepare('INSERT OR REPLACE INTO reading_state VALUES(1,?)').run(JSON.stringify({unitId:'KU-001',scrollTop:999,expanded:{},returnStack:[]}));fault.close();release(gate);
  await assert.rejects(pending,/源版本/);const old=await core.open(directory);assert.equal((await core.readingState(old.sessionId))!.scrollTop,999);
  await core.upgrade.cancel({sessionId:old.sessionId,upgradeId:'native-proof'});await assert.rejects(core.open(join(root,'v2')),/未发布|切换/);
 }finally{release(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});
test('the controlled upgrade preserves T25 personal/history/source records and real new T30 unit/theme/groups with parse and extension resources',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-t25-t30-')),core=new CourseService(join(developmentDirectory(), 'worker.cjs'));
 try{
  const source=join(root,'legacy'),directory=join(root,'course');await legacyFixture(source);const made=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'state'],{encoding:'utf8'});assert.equal(made.status,0,made.stderr);
  await core.migration.convert({sourceDirectory:source,directory});const initial=await core.open(directory);await core.migration.personal({...initial,sourceDirectory:source});
  const {sessionId,task}=await generationFixture(core,root),identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation},basis=await core.readAgentGeneration(identity);
  const first=await core.publishAgentGeneration({...identity,input:lesson(basis,'upgrade-generation-lesson')});assert.equal(first.status,'committed');
  const next=await core.readAgentGeneration(identity),second=await core.publishAgentGeneration({...identity,input:practice(next,'upgrade-generation-practice')});assert.equal(second.status,'committed');
  const unit=await core.readUnit(sessionId,'KU-GEN-MUX-01'),notes=await core.annotations.list({sessionId}),origins=await core.migration.records({sessionId,namespace:'reading'}),sources=await core.sources.list({sessionId}),extension=await core.extensions.open({sessionId});
  await core.upgrade.prepare({sessionId,directory:join(root,'v2'),backupDirectory:join(root,'backup'),upgradeId:'t25-t30'});await core.upgrade.publish({sessionId,upgradeId:'t25-t30'});
  const c=await core.open(join(root,'v2'));assert.deepEqual(await core.readUnit(c.sessionId,unit.id),unit);assert.deepEqual(await core.annotations.list(c),notes);assert.deepEqual(await core.migration.records({...c,namespace:'reading'}),origins);
  const graph=await core.graph(c.sessionId);assert.ok(graph.nodes.some(n=>n.id===unit.id));assert.ok(graph.groups.some(g=>g.id==='TH-GEN-MUX-01'));
  assert.deepEqual((await core.sources.list(c)).versions,sources.versions);for(const version of sources.versions)await core.sources.page({...c,versionId:version.versionId,pdfPageIndex:0});
  assert.ok((await core.parsing.artifacts({...c,versionId:basis.source.versionId})).length);assert.deepEqual((await core.extensions.open(c)).state,extension.state);
  assert.equal((await core.formalHistory.detail({...c,operationId:first.operationId})).operationId,first.operationId);assert.equal((await core.formalHistory.detail({...c,operationId:second.operationId})).operationId,second.operationId);
  assert.notEqual((await core.agentTask({...c,taskId:task.id})).status,'running');
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
