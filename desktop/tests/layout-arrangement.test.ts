import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

test('an explicit whole-board arrangement is atomic, version-checked, repeatable and recoverable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-layout-arrange-'));
  let core=new CourseService(resolve('dist/worker.cjs'));
  try {
    let sessionId=(await core.open(root)).sessionId;
    const initial=await core.graph(sessionId), a=initial.layout.nodes[0], b=initial.layout.nodes[1];
    await core.setLayout(sessionId,[{unitId:a.unitId,x:a.x+1700,y:a.y+500,width:a.width},
      {unitId:b.unitId,x:b.x-900,y:b.y-200,width:b.width}]);
    const stale=await core.planLayout(sessionId);
    await core.setLayout(sessionId,[{unitId:a.unitId,x:a.x+1750,y:a.y+500,width:a.width}]);
    await assert.rejects(core.arrangeLayout({sessionId,operationId:'stale-arrange',basis:stale.basis}),/变化/);
    const before=await core.graph(sessionId),plan=await core.planLayout(sessionId);
    assert.ok(plan.changes.length>0);
    const receipt=await core.arrangeLayout({sessionId,operationId:'explicit-arrange',basis:plan.basis});
    assert.equal(receipt.status,'committed');
    assert.deepEqual(await core.arrangeLayout({sessionId,operationId:'explicit-arrange',basis:plan.basis}),receipt);
    assert.deepEqual(await core.queryLayout({sessionId,operationId:'explicit-arrange'}),receipt);
    const after=await core.graph(sessionId);
    assert.deepEqual(after.edges,before.edges);
    assert.deepEqual(after.nodes,before.nodes);
    for(const change of plan.changes) {
      const n=after.layout.nodes.find(node=>node.unitId===change.after.unitId)!;
      assert.deepEqual({unitId:n.unitId,x:n.x,y:n.y,width:n.width},change.after);
    }
    const history=await core.formalHistory.detail({sessionId,operationId:'explicit-arrange'});
    assert.equal(history.explanation,'整理画板布局');
    assert.equal(history.changes.length,plan.changes.length);
    const preview=await core.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['explicit-arrange']}});
    const undo=await core.formalHistory.apply({sessionId,operationId:'undo-arrange',preview});
    assert.equal(undo.status,'committed',JSON.stringify(undo.conflicts));
    const restored=await core.graph(sessionId);
    for(const change of plan.changes) {
      const n=restored.layout.nodes.find(node=>node.unitId===change.before.unitId)!;
      assert.deepEqual({unitId:n.unitId,x:n.x,y:n.y,width:n.width},change.before);
    }
    await core.close();core=new CourseService(resolve('dist/worker.cjs'));sessionId=(await core.open(root)).sessionId;
    assert.deepEqual((await core.graph(sessionId)).layout.nodes,restored.layout.nodes);
  } finally {await core.close();await rm(root,{recursive:true,force:true});}
});

test('a layout write failure does not leave a partial arrangement or a successful history record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-layout-arrange-fail-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  let fault:DatabaseSync|undefined;
  try {
    const sessionId=(await core.open(root)).sessionId, graph=await core.graph(sessionId), node=graph.layout.nodes[0];
    await core.setLayout(sessionId,[{unitId:node.unitId,x:node.x+1200,y:node.y,width:node.width}]);
    const before=await core.graph(sessionId), plan=await core.planLayout(sessionId);
    assert.ok(plan.changes.length);
    fault=new DatabaseSync(join(root,'course.sqlite'));
    fault.exec("CREATE TRIGGER reject_arrangement BEFORE INSERT ON layout_baseline BEGIN SELECT RAISE(ABORT,'layout write failed'); END");
    await assert.rejects(core.arrangeLayout({sessionId,operationId:'failed-arrange',basis:plan.basis}),/layout write failed/);
    assert.deepEqual(await core.graph(sessionId),before);
    assert.equal(await core.queryLayout({sessionId,operationId:'failed-arrange'}),null);
  } finally {fault?.exec('DROP TRIGGER IF EXISTS reject_arrangement');fault?.close();await core.close();await rm(root,{recursive:true,force:true});}
});
