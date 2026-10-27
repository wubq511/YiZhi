import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';

test('the one prebuilt extension is course-owned, explicitly versioned and unavailable until learning and lifecycle checks pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-extension-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root);
    let v = await core.extensions.open({ sessionId: c.sessionId });
    assert.equal(v.definition.packageId, 'parity-lab');
    assert.equal(v.definition.packageVersion, '1.0.0');
    assert.equal(v.definition.interfaceVersion, 'extension-api-1');
    assert.equal(v.definition.inputVersion, 'bits-3-v1');
    assert.equal(v.definition.stateVersion, 'parity-state-1');
    assert.equal(v.phase, 'needs-check');
    assert.ok(v.definition.resources.every(r => /^[a-f0-9]{64}$/.test(r.sha256) && r.byteLength > 0 && r.license === 'MIT'));
    assert.ok(v.definition.resources.some(r => r.path === 'LICENSE.txt'));
    const request = (action: any) => ({ sessionId: c.sessionId, instanceId: v.instanceId, generation: v.generation, operationId: crypto.randomUUID(), action });
    await assert.rejects(core.extensions.act(request({ kind: 'run', running: true })), /检查/);
    await assert.rejects(core.extensions.act(request({ kind: 'validate', version: '1.0.0', report: { outputs: '00000000', lifecycle: true, migration: true } })), /学习结果/);
    v = await core.extensions.act(request({ kind: 'validate', version: '1.0.0', report: { outputs: '01101001', lifecycle: true, migration: true } }));
    assert.equal(v.phase, 'paused');
    const manifest = v.definition;
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(root);
    v = await core.extensions.open({ sessionId: c.sessionId });
    assert.deepEqual(v.definition, manifest);
    assert.equal(v.phase, 'paused');
    const license = await core.extensions.resource({ sessionId: c.sessionId, version: '1.0.0', path: 'LICENSE.txt' });
    assert.match(Buffer.from(license.bytes).toString(), /MIT License/);
    await assert.rejects(core.extensions.resource({ sessionId: c.sessionId, version: '1.0.0', path: '../course.sqlite' }), /登记/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('complete snapshots fence late instances, in-flight steps and new input, and real failed confirmation never becomes saved', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-extension-scene-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    let v = await core.extensions.open({sessionId});
    const act = async (action: any) => v = await core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action});
    await act({kind:'validate',version:'1.0.0',report:{outputs:'01101001',lifecycle:true,migration:true}});
    await act({kind:'visibility',visible:true}); await act({kind:'run',running:true});
    const late: import('../src/extensions-api').ExtensionCommand = {sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action:{kind:'confirm',mode:'step',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,step:1,simulationTime:250}}};
    await act({kind:'inputs',inputs:{A:1,B:0,C:0}});
    await assert.rejects(core.extensions.act(late), /现场已变化/);
    assert.equal(v.state.step,0);
    await act({kind:'confirm',mode:'input',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,inputs:v.inputs,output:1}});
    assert.equal(v.state.output,1);
    const confirmed = v.state;
    fault = new DatabaseSync(join(root,'course.sqlite'));
    fault.exec("CREATE TRIGGER extension_fault BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT,'extension confirmation fault'); END");
    await assert.rejects(act({kind:'confirm',mode:'step',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,step:1,simulationTime:250}}), /extension confirmation fault/);
    assert.deepEqual((await core.extensions.read({sessionId})).state,confirmed);
    fault.exec('DROP TRIGGER extension_fault'); fault.close(); fault=undefined;
    const priorInstance=v.instanceId, priorGeneration=v.generation;
    await act({kind:'fail',error:'browser Worker did not answer'}); assert.equal(v.phase,'pause-incomplete');
    await act({kind:'recover'}); assert.deepEqual(v.state,confirmed);
    assert.notEqual(v.instanceId,priorInstance); assert.ok(v.generation>priorGeneration);
    await assert.rejects(core.extensions.act({...late,operationId:crypto.randomUUID()}), /实例|代际/);
    assert.equal(v.phase,'paused');
  } finally { fault?.close(); await core.close(); await rm(root,{recursive:true,force:true}); }
});

test('compatible migration commits a copy after the gesture; new input invalidates it, incompatible definitions retain the old scene until explicit restart', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-extension-migrate-'));
  let core=new CourseService(resolve('dist/worker.cjs'));
  try {
    let c=await core.open(root), sessionId=c.sessionId;
    let v=await core.extensions.open({sessionId});
    const act=async(action:any)=>v=await core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action});
    await act({kind:'validate',version:'1.0.0',report:{outputs:'01101001',lifecycle:true,migration:true}});
    await act({kind:'inputs',inputs:{A:1,B:1,C:1}});
    await act({kind:'confirm',mode:'input',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,inputs:v.inputs,output:1}});
    await act({kind:'gesture',active:true});
    await act({kind:'definition',version:'1.1.0'});
    await act({kind:'validate',version:'1.1.0',report:{outputs:'01101001',lifecycle:true,migration:true}});
    const upgrade=()=>({kind:'upgrade',version:'1.1.0',baseRevision:v.revision,state:{...v.state,ones:3}});
    await assert.rejects(act(upgrade()),/操作结束/);
    await act({kind:'gesture',active:false}); const oldMigration=upgrade();
    await act({kind:'inputs',inputs:{A:0,B:1,C:1}});
    await assert.rejects(act(oldMigration),/现场已变化/);
    await act({kind:'confirm',mode:'input',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,inputs:v.inputs,output:0}});
    const old=v.instanceId;
    await act({...upgrade(),state:{...v.state,ones:2}});
    assert.equal(v.definition.packageVersion,'1.1.0'); assert.notEqual(v.instanceId,old);
    assert.equal(v.state.ones,2); assert.deepEqual(v.inputs,{A:0,B:1,C:1});
    const scene=v.state;
    await act({kind:'definition',version:'2.0.0'});
    await act({kind:'validate',version:'2.0.0',report:{outputs:'0110100110010110',lifecycle:true,migration:true}});
    await assert.rejects(act({kind:'upgrade',version:'2.0.0',baseRevision:v.revision,state:scene}),/不兼容/);
    assert.equal((await core.extensions.read({sessionId})).definition.packageVersion,'1.1.0');
    await act({kind:'migrationFailed',error:'输入格式不兼容'});
    assert.deepEqual(v.state,scene); assert.equal(v.phase,'conflict');
    await core.close(); core=new CourseService(resolve('dist/worker.cjs')); c=await core.open(root); sessionId=c.sessionId;
    v=await core.extensions.open({sessionId});
    assert.equal(v.definition.packageVersion,'1.1.0'); assert.equal(v.pending?.packageVersion,'2.0.0'); assert.deepEqual(v.state,scene);
    await act({kind:'restart',version:'2.0.0',baseRevision:v.revision});
    assert.equal(v.definition.packageVersion,'2.0.0'); assert.equal(v.state.step,0); assert.deepEqual(v.inputs,{A:0,B:0,C:0,D:0});
    await assert.rejects(core.agent.create({sessionId,operationId:(await core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'extension-op',action:{kind:'gesture',active:false}}),'extension-op')}),/操作身份/);
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});

test('undeclared fields, invalid learning outputs and corrupted registered resource bytes reject without creating a saved result',async()=>{
 const {writeFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-invalid-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId}=await core.open(root);let v=await core.extensions.open({sessionId});
  const act=(action:any)=>core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action});
  v=await act({kind:'validate',version:'1.0.0',report:{outputs:'01101001',lifecycle:true,migration:true}});
  await assert.rejects(act({kind:'inputs',inputs:{A:0,B:0,C:0,node:1}}),/声明/);
  await assert.rejects(act({kind:'confirm',mode:'input',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,output:1}}),/学习结果/);
  const script=v.definition.resources.find(r=>r.path==='compute.js')!;
  await writeFile(join(root,'resources',script.sha256),'corrupted content');
  await assert.rejects(core.extensions.resource({sessionId,version:'1.0.0',path:'compute.js'}),/损坏/);
  assert.deepEqual((await core.extensions.read({sessionId})).state,v.state);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('failed migration registration retains old definition and scene; exact retry switches only after the common commit succeeds',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-migration-fault-')),core=new CourseService(resolve('dist/worker.cjs'));
 let fault:InstanceType<typeof DatabaseSync>|undefined;
 try{
  const {sessionId}=await core.open(root);let v=await core.extensions.open({sessionId});
  const act=async(action:any)=>v=await core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action});
  for(const version of ['1.0.0','1.1.0']){
   if(version==='1.1.0')await act({kind:'definition',version});
   await act({kind:'validate',version,report:{outputs:'01101001',lifecycle:true,migration:true}});
  }
  const before=v;
  const command={sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'migration-retry',action:{kind:'upgrade' as const,version:'1.1.0' as const,baseRevision:v.revision,state:{...v.state,ones:0}}};
  fault=new DatabaseSync(join(root,'course.sqlite'));
  fault.exec("CREATE TRIGGER migration_fault BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT,'migration disk fault'); END");
  await assert.rejects(core.extensions.act(command),/migration disk fault/);
  assert.deepEqual(await core.extensions.read({sessionId}),before);
  fault.exec('DROP TRIGGER migration_fault');fault.close();fault=undefined;
  const upgraded=await core.extensions.act(command);assert.equal(upgraded.definition.packageVersion,'1.1.0');
  assert.deepEqual(await core.extensions.act(command),upgraded);
  await assert.rejects(core.extensions.act({...command,action:{...command.action,state:{...command.action.state,step:1,simulationTime:250}}}),/不同内容/);
 }finally{fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});

test('host renderer recovery revokes every old instance and retains confirmed content without restarting generated code in Core',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-host-reset-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId}=await core.open(root),v=await core.extensions.open({sessionId});
  let builtin=await core.experiments.open({sessionId,unitId:'KU-057',blockId:'RB-TH-13-057-010-interactive'});
  for(const action of [{kind:'background',enabled:true},{kind:'run',running:true}] as const)builtin=await core.experiments.act({sessionId,instanceId:builtin.instanceId,generation:builtin.generation,operationId:crypto.randomUUID(),action});
  await core.recoverExtensionRenderers();
  await new Promise(r=>setTimeout(r,350));
  const paused=await core.experiments.read({sessionId,instanceId:builtin.instanceId});assert.equal(paused.phase,'paused');assert.deepEqual(paused.state,builtin.state);
  const next=await core.extensions.read({sessionId});
  assert.deepEqual(next.state,v.state);assert.ok(next.generation>v.generation);assert.notEqual(next.instanceId,v.instanceId);
  await assert.rejects(core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'late-renderer',action:{kind:'inputs',inputs:{A:1,B:0,C:0}}}),/实例|代际/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('a confirmed scene accepts only declared model fields, never a serialized heap or a mismatched definition schema',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-extension-schema-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId}=await core.open(root);let v=await core.extensions.open({sessionId});
  const act=(action:any)=>core.extensions.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:crypto.randomUUID(),action});
  v=await act({kind:'validate',version:'1.0.0',report:{outputs:'01101001',lifecycle:true,migration:true}});
  await assert.rejects(act({kind:'confirm',mode:'input',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,heap:{secret:'not a model field'}}}),/字段/);
  await assert.rejects(act({kind:'confirm',mode:'input',baseRevision:v.revision,definitionVersion:'1.0.0',state:{...v.state,ones:0}}),/字段/);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
