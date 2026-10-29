import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CourseService } from '../src/core/course-service';
test('unknown body payload refuses writable open before any database mutation while understood units remain explicitly readable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-future-body-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root);await core.read(c.sessionId,'KU-002');await core.close();
  const db=new DatabaseSync(join(root,'course.sqlite'));const row=db.prepare("SELECT payload FROM units WHERE id='KU-001'").get()!,unit=JSON.parse(String(row.payload));
  unit.reading.schemaVersion='review-reading-9000';unit.futureField={opaque:['never discard',42]};db.prepare("UPDATE units SET payload=? WHERE id='KU-001'").run(JSON.stringify(unit));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  const before=await readFile(join(root,'course.sqlite'));core=new CourseService(resolve('dist/worker.cjs'));
  await assert.rejects(core.open(root),/正文.*版本|载荷.*版本/);
  assert.deepEqual(await readFile(join(root,'course.sqlite')),before);
  const capabilities=await (core as any).format.inspect({directory:root});assert.equal(capabilities.writable,false);assert.ok(capabilities.readableUnits.includes('KU-002'));
  assert.equal((await (core as any).format.readUnit({directory:root,unitId:'KU-002'})).id,'KU-002');
  await assert.rejects((core as any).format.readUnit({directory:root,unitId:'KU-001'}),/解释|版本/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('a higher declared block payload version is refused even when the surrounding reading schema is known',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-future-block-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  await core.open(root);await core.close();const db=new DatabaseSync(join(root,'course.sqlite')),unit=JSON.parse(String(db.prepare("SELECT payload FROM units WHERE id='KU-001'").get()!.payload));
  unit.reading.blocks[0].payload.schemaVersion='text-payload-999';unit.reading.blocks[0].payload.unknown={original:'preserve me'};db.prepare("UPDATE units SET payload=? WHERE id='KU-001'").run(JSON.stringify(unit));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  const before=await readFile(join(root,'course.sqlite'));core=new CourseService(resolve('dist/worker.cjs'));await assert.rejects(core.open(root),/载荷版本/);assert.deepEqual(await readFile(join(root,'course.sqlite')),before);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('offline work-copy validation rejects a dangling knowledge reference before any upgrade can publish it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-reference-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root);await core.close();
  const db=new DatabaseSync(join(root,'course.sqlite')),unit=JSON.parse(String(db.prepare("SELECT payload FROM units WHERE id='KU-001'").get()!.payload));
  unit.reading.blocks.push({id:'broken-workcopy-ref',kind:'knowledge-reference',payload:{targetUnitId:'MISSING-UNIT'}});
  db.prepare("UPDATE units SET payload=? WHERE id='KU-001'").run(JSON.stringify(unit));
  db.prepare("INSERT INTO metadata VALUES('course-graph',?)").run(JSON.stringify({nodes:[{id:'KU-001',themeId:'TH-1'}],groups:[{id:'TH-1'}],edges:[],requirementGroups:[],layout:{nodes:[{unitId:'KU-001'}]}}));db.close();
  core=new CourseService(resolve('dist/worker.cjs'));await assert.rejects((core as any).format.validate({directory:root}),/引用|目标/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
test('course format, minimum reader, body version and extension interface/input/state are independent admission decisions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-format-axes-'));
 try{
  for(const axis of ['format','reader','interfaceVersion','inputVersion','stateVersion','scene-interfaceVersion','scene-inputVersion','scene-stateVersion']){
   const directory=join(root,axis);let core=new CourseService(resolve('dist/worker.cjs'));
   try{
    const c=await core.open(directory);await core.extensions.open(c);await core.close();
    const db=new DatabaseSync(join(directory,'course.sqlite'));
    if(axis==='format')db.exec('PRAGMA user_version=999');
    else if(axis==='reader')db.prepare("INSERT OR REPLACE INTO metadata VALUES('minimum-reader','999')").run();
    else if(axis.startsWith('scene-')){const scene=JSON.parse(String(db.prepare('SELECT payload FROM extension_scene LIMIT 1').get()!.payload));scene.definition[axis.slice(6)]='future-999';db.prepare('UPDATE extension_scene SET payload=?').run(JSON.stringify(scene));}
    else {const m=JSON.parse(String(db.prepare('SELECT manifest FROM extension_packages LIMIT 1').get()!.manifest));m[axis]='future-999';db.prepare('UPDATE extension_packages SET manifest=?').run(JSON.stringify(m));}
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
    const before=await readFile(join(directory,'course.sqlite'));core=new CourseService(resolve('dist/worker.cjs'));
    const report=await core.format.inspect({directory});assert.equal(report.writable,false,axis);
    await assert.rejects(core.open(directory),/版本|格式|能力/);assert.deepEqual(await readFile(join(directory,'course.sqlite')),before);
   }finally{await core.close();}
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
