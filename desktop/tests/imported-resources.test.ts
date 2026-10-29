import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,rename,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CourseService} from '../src/core/course-service';

test('an existing imported image remains readable, retained and backed up offline; its operation identity cannot be reused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-imported-resource-')),original=join(root,'original'),portable=join(root,'portable');
 let core=new CourseService(resolve(process.env.YIZHI_RUNTIME_WORKER ?? 'dist/worker.cjs'));
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P8sAAAAASUVORK5CYII=','base64'),sha=createHash('sha256').update(bytes).digest('hex'),asset='existing-imported-image';
 try{
  await core.open(original);await core.close();
  await mkdir(join(original,'resources'));await writeFile(join(original,'resources',sha),bytes);
  const db=new DatabaseSync(join(original,'course.sqlite'));
  try{
   const unit=JSON.parse(String(db.prepare("SELECT payload FROM units WHERE id='KU-001'").get()!.payload));
   unit.reading.blocks.push({id:'imported-image-block',kind:'figure',payload:{asset,alt:'已有图片'}});
   db.prepare("UPDATE units SET payload=? WHERE id='KU-001'").run(JSON.stringify(unit));
   db.prepare('INSERT INTO exchange_resources VALUES(?,?)').run(asset,JSON.stringify({asset,path:'resources/'+sha,sha256:sha,byteLength:bytes.length,mediaType:'image/png'}));
   db.prepare('INSERT INTO exchange_operations VALUES(?,?,?)').run('old-import-operation','historical-digest',JSON.stringify({operationId:'old-import-operation',status:'committed'}));
  }finally{db.close();}
  await rename(original,portable);core=new CourseService(resolve(process.env.YIZHI_RUNTIME_WORKER ?? 'dist/worker.cjs'));
  const c=await core.open(portable);
  assert.ok(c.resourceAssets?.includes(asset));
  assert.deepEqual(Buffer.from((await core.resources.read({...c,asset})).bytes),bytes);
  assert.ok((await core.readUnit(c.sessionId,'KU-001')).reading.blocks.some(b=>b.id==='imported-image-block'));
  await assert.rejects(core.save({...c,operationId:'old-import-operation',inputSeq:1,baseRevision:c.revision,blockId:c.editableBlockId,text:'cannot replay'}),/操作身份已用于交换导入/);
  await core.retention.run({...c,limit:64});
  assert.deepEqual(Buffer.from((await core.resources.read({...c,asset})).bytes),bytes);
  const backup=join(root,'backup');await core.backup.create({...c,directory:backup,backupId:'compat-image-backup'});
  await core.backup.verify({directory:backup});
  assert.deepEqual(await readFile(join(backup,'resources',sha)),bytes);
  await writeFile(join(portable,'resources',sha),'corrupted');
  await assert.rejects(core.resources.read({...c,asset}),/损坏|缺失/);
  await core.close();core=new CourseService(resolve(process.env.YIZHI_RUNTIME_WORKER ?? 'dist/worker.cjs'));
  const restored=await core.open(backup);
  assert.deepEqual(Buffer.from((await core.resources.read({...restored,asset})).bytes),bytes);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
