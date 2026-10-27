import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { muxId,correctFormula } from './agent-mutation-setup';

test('new formula links and newly inserted experiment/formula pairs cannot evade the public necessary group boundary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-new-links-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root),sessionId=c.sessionId,unit=await core.readUnit(sessionId,'KU-057');
  const view=await core.experiments.open({sessionId,unitId:unit.id,blockId:muxId});
  for(const pair of [false,true]){
   const attempt=await core.commands.startAttempt({sessionId,taskId:`new-links-${pair}`}),basis=await core.commands.read({sessionId,attemptId:attempt.attemptId,unitId:unit.id,objectIds:unit.reading.blocks.map(b=>b.id),context:true});
   const e=structuredClone(unit.reading.blocks.find(b=>b.id===muxId)!);e.id='new-linked-experiment';
   const formula={id:`new-linked-formula-${pair}`,kind:'formula',payload:{latex:'Z=0',experimentBlockId:pair?e.id:muxId}},inserted=pair?[e,formula]:[formula];
   const result=await core.commands.commit({sessionId,unitId:unit.id,attemptId:attempt.attemptId,operationId:`new-link-${pair}`,basisId:basis.basisId,changes:[],bundle:{},patch:{updates:[],correspondence:[],structure:{parentId:unit.id,before:unit.reading.blocks.map(b=>b.id),after:[...unit.reading.blocks.map(b=>b.id),...inserted.map(b=>b.id)],inserted}}});
   assert.equal(result.status,'retained',result.reason??JSON.stringify(result));assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);assert.deepEqual(await core.experiments.read({sessionId,instanceId:view.instanceId}),view);
   assert.deepEqual(await core.commands.query({sessionId,operationId:result.operationId}),result);
  }
  const pdf=join(root,'proof.pdf');await sourceFixture(pdf,'S1 is high, S0 is low; 00:I0,01:I1,10:I2,11:I3.');
  const source=await core.sources.importFile({sessionId,operationId:'source',generation:1,path:pdf,title:'Controlled finite source'}),page=await core.sources.page({sessionId,versionId:source.version.versionId,pdfPageIndex:0});
  const citation=await core.sources.cite({sessionId,operationId:'cite',generation:1,versionId:source.version.versionId,pdfPageIndex:0,projectionId:page.projection.id,start:0,end:Array.from(page.projection.text).length,target:{unitId:unit.id}});
  const a=await core.commands.startAttempt({sessionId,taskId:'valid-new-link'}),basis=await core.commands.read({sessionId,attemptId:a.attemptId,unitId:unit.id,objectIds:unit.reading.blocks.map(b=>b.id),context:true});
  const formula={id:'new-linked-proven-formula',kind:'formula',payload:{latex:correctFormula,experimentBlockId:muxId}};
  const saved=await core.commands.commit({sessionId,unitId:unit.id,attemptId:a.attemptId,operationId:'valid-new-link',basisId:basis.basisId,changes:[],patch:{updates:[],correspondence:[],structure:{parentId:unit.id,before:unit.reading.blocks.map(b=>b.id),after:[...unit.reading.blocks.map(b=>b.id),formula.id],inserted:[formula]}},bundle:{experiments:[{blockId:muxId,formula:correctFormula,formulaBlockId:formula.id,sourceCitationId:citation.id}]}});
  assert.equal(saved.status,'committed',saved.reason??JSON.stringify(saved));assert.equal(saved.related!.definitions[0].proof.assignments,64);assert.deepEqual((await core.readUnit(sessionId,unit.id)).reading.blocks.at(-1),formula);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('paragraph and layout groups must reread a changed formal relation even when the group does not write relations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-read-relation-')),core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const c=await core.open(root),sessionId=c.sessionId,unit=await core.readUnit(sessionId,'KU-057');
  for(const layout of [false,true]){
   const a=await core.commands.startAttempt({sessionId,taskId:`relation-read-${layout}`}),basis=await core.commands.read({sessionId,attemptId:a.attemptId,unitId:unit.id,objectIds:unit.reading.blocks.map(b=>b.id),context:true});
   const r=await core.relations.read({sessionId}),edge=r.graph.edges.find(e=>e.id==='REL-014')!;
   await core.relations.commit({sessionId,basisId:r.basisId,generation:r.generation,operationId:`changed-read-relation-${layout}`,changes:[{id:edge.id,value:{...edge,value:`已审核的最新两级构造依据 ${layout}`}}]});
   const graph=await core.graph(sessionId),block=basis.objects.find(o=>o.id===unit.reading.blocks.find(b=>b.kind==='paragraph')!.id)!;
   const result=await core.commands.commit({sessionId,attemptId:a.attemptId,unitId:unit.id,operationId:`old-read-relation-${layout}`,basisId:basis.basisId,
    changes:layout?[]:[{objectId:block.id,value:{...block.value,payload:{...block.value.payload,text:'依据已过期关系推导的正文不应保存。'}}}],
    ...(layout?{bundle:{layout:basis.context!.layout.map(n=>({unitId:n.unitId,x:n.x+10,y:n.y,width:n.width}))}}:{})});
   assert.equal(result.status,'retained',result.reason??JSON.stringify(result));assert.match(result.reason!,/正式关系.*依据|正式关系.*变化/);assert.deepEqual(await core.readUnit(sessionId,unit.id),unit);assert.deepEqual(await core.graph(sessionId),graph);
  }
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

import { muxCopy,correction } from './agent-mutation-setup';
import { sourceFixture } from './source-fixture';
test('direct formula exploration cannot rewrite an experiment that has a formal body formula link; independent T12 exploration still works',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-linked-formula-act-'));let core=new CourseService(resolve('dist/worker.cjs'));
 try{
  const {sessionId,citation,view}=await muxCopy(core,join(root,'linked'));
  const group=await core.commands.commit(await correction(core,sessionId,citation.id,'correct-linked-fixture'));assert.equal(group.status,'committed',group.reason??JSON.stringify(group));
  let v=await core.experiments.read({sessionId,instanceId:view.instanceId});
  v=await core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'adopt-correct-group',action:{kind:'migrate',baseVersion:v.version}});
  const unit=await core.readUnit(sessionId,'KU-057'),graph=await core.graph(sessionId),snapshot=await core.experiments.snapshot({sessionId,instanceId:v.instanceId});
  await assert.rejects(core.experiments.act({sessionId,instanceId:v.instanceId,generation:v.generation,operationId:'cannot-split-formula-group',action:{kind:'formula',baseRevision:v.definition.revision,formula:'Z=0'}}),/关联.*一致组|完整一致组/);
  assert.deepEqual(await core.experiments.read({sessionId,instanceId:v.instanceId}),v);assert.deepEqual(await core.experiments.snapshot({sessionId,instanceId:v.instanceId}),snapshot);assert.deepEqual(await core.readUnit(sessionId,'KU-057'),unit);assert.deepEqual(await core.graph(sessionId),graph);
  await core.close();core=new CourseService(resolve('dist/worker.cjs'));const reopened=await core.open(join(root,'linked')),confirmed=await core.experiments.open({sessionId:reopened.sessionId,unitId:'KU-057',blockId:muxId});assert.deepEqual(confirmed.definition,v.definition);assert.deepEqual(confirmed.state,v.state);
  const independent=await core.open(join(root,'independent')),free=await core.experiments.open({sessionId:independent.sessionId,unitId:'KU-057',blockId:muxId});
  const explored=await core.experiments.act({sessionId:independent.sessionId,instanceId:free.instanceId,generation:free.generation,operationId:'independent-formula',action:{kind:'formula',baseRevision:free.definition.revision,formula:'Z=0'}});assert.equal(explored.definition.check,'verified');assert.deepEqual(explored.definition.config.dataSignals,['0','0','0','0']);
 }finally{await core.close();await rm(root,{recursive:true,force:true});}
});
