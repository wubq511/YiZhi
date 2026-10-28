import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
  assert.deepEqual(await (core.migration as any).status({directory:source}),receipt);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));assert.equal((await (core.migration as any).recover({directory:source})).directory,target);
  assert.equal((await core.open(target)).courseId,opened.courseId);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
