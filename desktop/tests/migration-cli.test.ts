import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {legacyFixture} from './migration-fixture';
import {CourseService} from '../src/core/course-service';

test('standalone CLI converts, fully migrates and queries records; formal worker independently reads and restores the published history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-cli-')),source=join(root,'source'),candidate=join(root,'candidate'),target=join(root,'target'),portable=join(root,'portable');
 const core=new CourseService(resolve(process.env.YIZHI_RUNTIME_WORKER??'dist/worker.cjs'),{retentionScheduling:{manual:true}});
 const invoke=(action:string,payload:unknown)=>{const child=spawnSync(process.execPath,[join(developmentDirectory(), 'cli.cjs'),action,JSON.stringify(payload)],{encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);};
 try{
  const original=await legacyFixture(source);
  const fixture=spawnSync('python3',['-B',resolve('tests/personal-migration-fixture.py'),source,'content-history'],{encoding:'utf8'});assert.equal(fixture.status,0,fixture.stderr);
  assert.equal(invoke('convert',{sourceDirectory:source,directory:candidate}).scope,'content-candidate');
  const request={sourceDirectory:source,contentCandidateDirectory:candidate,directory:target,operationId:'cli-full-migration'};
  assert.equal(invoke('migrate',request).phase,'published');
  assert.equal(invoke('migrate',request).phase,'published');
  assert.ok(invoke('records',{directory:target}).records.length>0);
  assert.equal(invoke('operation',{directory:target,operationId:'OP-LEGACY-BODY'}).operationId,'OP-LEGACY-BODY');
  await rename(target,portable);await rm(source,{recursive:true,force:true});await rm(candidate,{recursive:true,force:true});
  const c=await core.open(portable);
  assert.ok((await core.annotations.list(c)).some(n=>n.id==='NOTE-T25-OBJECT'));
  assert.ok((await core.formalHistory.list(c)).activities.some(a=>a.operationIds.includes('OP-LEGACY-BODY')));
  const preview=await core.formalHistory.preview({...c,selection:{kind:'operations',operationIds:['OP-LEGACY-BODY']}});
  const receipt=await core.formalHistory.apply({...c,operationId:'formal-restore-after-cli',preview});
  assert.equal(receipt.status,'committed');
  assert.equal((await core.readUnit(c.sessionId,'KU-001')).reading.blocks[0].payload.text,original.first.reading.blocks[0].payload.text);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
