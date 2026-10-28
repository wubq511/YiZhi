import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
const A = 'RB-TH-01-01-what-is-positional-notation';
const B = 'RB-TH-01-03-expansion-terms';
async function fixture(run: (s: CourseService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'yizhi-t21-'));
  const s = new CourseService(resolve('dist/worker.cjs'));
  try { await run(s, directory); } finally { await s.close(); await rm(directory, {recursive:true,force:true}); }
}
async function agentEdit(s:CourseService, sessionId:string, taskId:string, operationId:string, blockId:string, text:string) {
  const attempt=await s.commands.startAttempt({sessionId,taskId});
  const basis=await s.commands.read({sessionId,attemptId:attempt.attemptId,objectIds:[blockId]});
  const before=basis.objects.find(o=>o.id===blockId)!.value;
  assert.equal((await s.commands.commit({sessionId,attemptId:attempt.attemptId,basisId:basis.basisId,operationId,changes:[{objectId:blockId,value:{...before,payload:{...before.payload,text}}}]})).status,'committed');
}
test('formal history paginates real student and producer changes with expandable before and after',async()=>fixture(async(s,d)=>{
  const o=await s.open(d), sessionId=o.sessionId;
  await agentEdit(s,sessionId,'task','agent-change',B,'Agent new explanation');
  await s.save({sessionId,operationId:'student-change',inputSeq:1,baseRevision:(await s.read(sessionId)).revision,blockId:A,text:'Student independent C'});
  const page=await s.formalHistory.list({sessionId,unitId:'KU-001',limit:1});
  assert.equal(page.activities.length,1); assert.ok(page.next);
  assert.equal(page.activities[0].actor,'student');
  const next=await s.formalHistory.list({sessionId,unitId:'KU-001',limit:1,before:page.next});
  assert.equal(next.activities[0].actor,'agent');
  const detail=await s.formalHistory.detail({sessionId,operationId:'agent-change'});
  assert.equal(detail.changes.find(c=>c.objectId===B)!.after!.payload.text,'Agent new explanation');
  assert.equal(detail.changes.find(c=>c.objectId===B)!.before!.payload.text,o.unit.reading.blocks.find(b=>b.id===B)!.payload.text);
  assert.ok(detail.committedAt); assert.deepEqual(detail.unitIds,['KU-001']);
}));
test('undo reverses one task in commit order while retaining independent student content and rejects ABA',async()=>fixture(async(s,d)=>{
  const o=await s.open(d),sessionId=o.sessionId,original=o.unit.reading.blocks.find(b=>b.id===B)!.payload.text;
  await agentEdit(s,sessionId,'chain','chain-1',B,'B');
  await agentEdit(s,sessionId,'chain','chain-2',B,'C');
  await s.save({sessionId,operationId:'independent',inputSeq:1,baseRevision:(await s.read(sessionId)).revision,blockId:A,text:'Independent student C'});
  const currentBlock=(await s.read(sessionId)).unit.reading.blocks[0];
  const note=await s.annotations.create({sessionId,operationId:'independent-note',text:'Personal N',selection:{unitId:'KU-001',fragments:[{blockId:A,block:currentBlock,field:'text',formalRevision:(await s.read(sessionId)).revision,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:'Independent student C'},from:0,to:11,quote:'Independent'}]}});
  const placement=(await s.graph(sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!;
  await s.drawings.place({sessionId,operationId:'later-independent-layout',before:{unitId:placement.unitId,x:placement.x,y:placement.y,width:placement.width},after:{unitId:placement.unitId,x:placement.x+77,y:placement.y,width:placement.width}});
  const conversation=await s.agent.create({sessionId,operationId:'preserved-conversation'});
  await s.agent.saveDraft({sessionId,conversationId:conversation.id,seq:1,text:'Current learning conversation draft'});
  const preview=await s.formalHistory.preview({sessionId,selection:{kind:'task',taskId:'chain'}});
  const result=await s.formalHistory.apply({sessionId,operationId:'undo-chain',preview});
  assert.equal(result.status,'committed');assert.deepEqual(result.applied,['chain-2','chain-1']);
  const current=await s.read(sessionId);
  assert.equal(current.unit.reading.blocks.find(b=>b.id===B)!.payload.text,original);
  assert.equal(current.unit.reading.blocks.find(b=>b.id===A)!.payload.text,'Independent student C');
  assert.deepEqual((await s.annotations.list({sessionId}))[0],note);
  assert.equal((await s.graph(sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,placement.x+77);
  assert.equal((await s.agent.get({sessionId,conversationId:conversation.id})).draft.text,'Current learning conversation draft');
  assert.deepEqual(await s.formalHistory.apply({sessionId,operationId:'undo-chain',preview}),result);
  assert.deepEqual(await s.formalHistory.query({sessionId,operationId:'undo-chain'}),result);
  await agentEdit(s,sessionId,'aba','aba-1',B,'same');
  await agentEdit(s,sessionId,'other','other-1',B,'intermediate');
  await agentEdit(s,sessionId,'other','other-2',B,'same');
  const conflict=await s.formalHistory.apply({sessionId,operationId:'aba-undo',preview:await s.formalHistory.preview({sessionId,selection:{kind:'task',taskId:'aba'}})});
  assert.equal(conflict.status,'conflict');assert.ok(conflict.conflicts[0].objectIds.includes(B));
}));
test('student edits and their structural history can be withdrawn with real revisions',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId,old=o.unit.reading.blocks[0].payload.text;
 await s.save({sessionId,operationId:'student-1',inputSeq:1,baseRevision:o.revision,blockId:A,text:'Student version'});
 const p=await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['student-1']}});
 const result=await s.formalHistory.apply({sessionId,operationId:'undo-student',preview:p});
 assert.equal(result.status,'committed');assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,old);
 const undo=await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['undo-student']}});
 assert.equal((await s.formalHistory.apply({sessionId,operationId:'redo-student',preview:undo})).status,'committed');
 assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,'Student version');
}));
test('independent groups undo partially, and interleaved student writes are not erased by a task chain',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await agentEdit(s,sessionId,'mixed','mixed-1',A,'agent A');
 await agentEdit(s,sessionId,'mixed','mixed-2',B,'agent B');
 await s.save({sessionId,operationId:'student-between',inputSeq:1,baseRevision:(await s.read(sessionId)).revision,blockId:A,text:'student between'});
 await agentEdit(s,sessionId,'mixed','mixed-3',A,'agent C');
 const result=await s.formalHistory.apply({sessionId,operationId:'partial',preview:await s.formalHistory.preview({sessionId,selection:{kind:'task',taskId:'mixed'}})});
 assert.equal(result.status,'partial');assert.deepEqual(result.applied,['mixed-3','mixed-2']);assert.equal(result.conflicts[0].operationId,'mixed-1');
 assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,'student between');
 assert.equal((await s.read(sessionId)).unit.reading.blocks.find(b=>b.id===B)!.payload.text,o.unit.reading.blocks.find(b=>b.id===B)!.payload.text);
}));
test('restore previews a real old unit, preserves drafts and personal state, and itself supports undo and exact retry',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await agentEdit(s,sessionId,'versions','version-1',A,'Old A');
 await agentEdit(s,sessionId,'versions','version-2',A,'New A');
 await agentEdit(s,sessionId,'later','version-3',B,'New B');
 await s.setReviewStatus(sessionId,'KU-001','mastered');
 const graph=await s.graph(sessionId),place=graph.layout.nodes.find(n=>n.unitId==='KU-001')!;
 await s.setLayout(sessionId,[{unitId:'KU-001',x:place.x+123,y:place.y,width:place.width}]);
 const draft={sessionId,inputSeq:1,baseRevision:(await s.read(sessionId)).revision,complete:false,changes:[],formulaDrafts:[{blockId:A,latex:'\\frac{'}]};
 await s.saveDraft(draft);
 const preview=await s.formalHistory.preview({sessionId,unitId:'KU-001',atOperationId:'version-1',side:'after'});
 assert.equal(preview.unit!.reading.blocks[0].payload.text,'Old A');assert.equal(preview.drafts,1);
 const result=await s.formalHistory.apply({sessionId,operationId:'restore-old',preview});
 assert.equal(result.status,'committed');assert.deepEqual(await s.formalHistory.apply({sessionId,operationId:'restore-old',preview}),result);
 assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,'Old A');
 assert.equal((await s.read(sessionId)).unit.reading.blocks.find(b=>b.id===B)!.payload.text,o.unit.reading.blocks.find(b=>b.id===B)!.payload.text);
 assert.deepEqual((await s.read(sessionId)).drafts[0].input,draft);
 assert.equal((await s.reviewStates(sessionId)).units['KU-001'].status,'mastered');
 assert.equal((await s.graph(sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,place.x+123);
 const undo=await s.formalHistory.apply({sessionId,operationId:'undo-restore',preview:await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['restore-old']}})});
 assert.equal(undo.status,'committed');assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,'New A');
 assert.equal((await s.read(sessionId)).unit.reading.blocks.find(b=>b.id===B)!.payload.text,'New B');
}));
import { DatabaseSync } from 'node:sqlite';
import { muxCopy, correction, muxId } from './agent-mutation-setup';
test('historical formula, definition, relation and layout restore together, with SQL rollback before runtime publication',async()=>fixture(async(s,d)=>{
 const {sessionId,citation,view}=await muxCopy(s,d);
 // Make the deliberately bad teaching fixture internally consistent before formal history starts.
 const oldFormula='Z=¬S0·¬S1·I0+¬S0·S1·I1+S0·¬S1·I2+S0·S1·I3';
 const setup=new DatabaseSync(join(d,'course.sqlite'));
 const seeded=await s.readUnit(sessionId,'KU-057');seeded.reading.blocks[0].payload.latex=oldFormula;
 setup.prepare('UPDATE units SET payload=? WHERE id=?').run(JSON.stringify(seeded),'KU-057');setup.close();
 const oldGraph=await s.graph(sessionId);
 const corrected=await s.commands.commit(await correction(s,sessionId,citation.id,'aggregate'));
 assert.equal(corrected.status,'committed');
  const aggregate=await s.formalHistory.detail({sessionId,operationId:'aggregate'});
  for(const neighbor of aggregate.changes.filter(c=>c.objectId.startsWith('layout:')).map(c=>c.objectId.slice(7))) {
    assert.ok((await s.formalHistory.list({sessionId,unitId:neighbor})).activities.some(a=>a.operationIds.includes('aggregate')),`affected unit ${neighbor} can find the aggregate in its own history`);
  }
 let live=await s.experiments.read({sessionId,instanceId:view.instanceId});
 live=await s.experiments.act({sessionId,instanceId:live.instanceId,generation:live.generation,operationId:'adopt',action:{kind:'migrate',baseVersion:live.version}});
 const preview=await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['aggregate']}});
 assert.ok(preview.affectedObjectIds.includes(`experiment:KU-057/${muxId}`));
 assert.ok(preview.sourceVersions.includes(citation.versionId));
 const fault=new DatabaseSync(join(d,'course.sqlite'));
 fault.exec("CREATE TRIGGER fail_history_recovery BEFORE INSERT ON cg_history WHEN NEW.operation_id='aggregate-undo' BEGIN SELECT RAISE(ABORT,'history commit fault'); END");
 try {
  await assert.rejects(s.formalHistory.apply({sessionId,operationId:'aggregate-undo',preview}),/history commit fault/);
  assert.deepEqual(await s.experiments.read({sessionId,instanceId:view.instanceId}),live);
  assert.equal(await s.formalHistory.query({sessionId,operationId:'aggregate-undo'}),null);
  fault.exec('DROP TRIGGER fail_history_recovery');
  const result=await s.formalHistory.apply({sessionId,operationId:'aggregate-undo',preview});
  assert.equal(result.status,'committed',JSON.stringify(result));
  assert.deepEqual(await s.readUnit(sessionId,'KU-057'),seeded);
  assert.deepEqual((await s.graph(sessionId)).edges,oldGraph.edges);
  assert.deepEqual((await s.graph(sessionId)).layout,oldGraph.layout);
  const pending=await s.experiments.read({sessionId,instanceId:view.instanceId});
  assert.deepEqual(pending.definition,live.definition);assert.deepEqual(pending.state,live.state);
  assert.deepEqual(pending.pendingDefinition!.config.selectBits,['S0','S1']);
  assert.ok(pending.pendingDefinition!.revision>live.definition.revision);
 }finally{fault.close();}
}));
test('withdrawing a created subtree preserves a later personal original, and undoing that withdrawal restores every child',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId,attempt=await s.commands.startAttempt({sessionId,taskId:'insert-tree'});
 const ids=o.unit.reading.blocks.map(b=>b.id),subtree={id:'new-example',kind:'example',payload:{title:'Example'},children:[{id:'new-child',kind:'paragraph',payload:{text:'Original child context'}}]};
 const basis=await s.commands.read({sessionId,attemptId:attempt.attemptId,objectIds:[`structure:${o.unit.id}`]});
 const create=await s.commands.commit({sessionId,attemptId:attempt.attemptId,operationId:'insert-subtree',basisId:basis.basisId,changes:[],patch:{updates:[],correspondence:[],structure:{parentId:o.unit.id,before:ids,after:[...ids,subtree.id],inserted:[subtree]}}});
 assert.equal(create.status,'committed');
 const current=await s.read(sessionId),child=subtree.children[0];
 const note=await s.annotations.create({sessionId,operationId:'child-note',text:'Personal N',selection:{unitId:o.unit.id,fragments:[{blockId:child.id,block:child,field:'text',formalRevision:current.revision,source:'formal',projection:{version:1,encoding:'unicode-code-points',text:child.payload.text},from:0,to:8,quote:'Original'}]}});
 const result=await s.formalHistory.apply({sessionId,operationId:'remove-subtree',preview:await s.formalHistory.preview({sessionId,selection:{kind:'task',taskId:'insert-tree'}})});
 assert.equal(result.status,'committed',JSON.stringify(result));assert.deepEqual((await s.read(sessionId)).unit,o.unit);
 const retained=(await s.annotations.list({sessionId}))[0];assert.equal(retained.text,'Personal N');assert.deepEqual(retained.original,note.original);assert.equal(retained.current.status,'orphan');
 const restored=await s.formalHistory.apply({sessionId,operationId:'return-subtree',preview:await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['remove-subtree']}})});
 assert.equal(restored.status,'committed',JSON.stringify(restored));assert.deepEqual((await s.read(sessionId)).unit.reading.blocks.at(-1),subtree);
}));
test('a later formal reference prevents removal of its target instead of leaving a dangling reference',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId,ids=o.unit.reading.blocks.map(b=>b.id),added={id:'referenced-new',kind:'paragraph',payload:{text:'Referenced'}};
 await s.commitEdit({sessionId,operationId:'add-referenced',inputSeq:1,baseRevision:o.revision,complete:true,changes:[],patch:{updates:[],correspondence:[],structure:{parentId:o.unit.id,before:ids,after:[...ids,added.id],inserted:[added]}}});
 const a=await s.commands.startAttempt({sessionId,taskId:'references'}),basis=await s.commands.read({sessionId,attemptId:a.attemptId,objectIds:[A,added.id,'reference:later']});
 assert.equal((await s.commands.commit({sessionId,attemptId:a.attemptId,basisId:basis.basisId,operationId:'later-ref',changes:[{objectId:'reference:later',value:{fromBlockId:A,toBlockId:added.id}}]})).status,'committed');
 const result=await s.formalHistory.apply({sessionId,operationId:'try-remove-ref',preview:await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['add-referenced']}})});
 assert.equal(result.status,'conflict');assert.match(result.conflicts[0].reason,/引用|依赖/);
 assert.equal((await s.read(sessionId)).unit.reading.blocks.at(-1)!.id,added.id);
}));
test('continued tasks are one deduplicated logical activity and running qualification is revoked before withdrawal',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId,conversation=await s.agent.create({sessionId,operationId:'conversation'});
 const task=await s.agent.submit({sessionId,operationId:'start',conversationId:conversation.id,generation:1,text:'Modify explanation',target:{unitId:'KU-001'},intent:'modify'});
 await agentEdit(s,sessionId,task.id,'original-group',A,'original task content');
 await s.agent.stop({sessionId,taskId:task.id});
 await s.recordAgent({sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation,eventId:'original-stopped',kind:'finish',status:'interrupted'});
 const continued=await s.agent.continue({sessionId,taskId:task.id,operationId:'continue'});
 await agentEdit(s,sessionId,continued.id,'continued-group',B,'continued task content');
 const basis=await s.commands.read({sessionId,attemptId:continued.attemptId,objectIds:[B]});
 const page=await s.formalHistory.list({sessionId});assert.equal(page.activities.length,1);assert.deepEqual(page.activities[0].operationIds,['original-group','continued-group']);
 const result=await s.formalHistory.apply({sessionId,operationId:'undo-continuation',preview:await s.formalHistory.preview({sessionId,selection:{kind:'task',taskId:continued.id}})});
 assert.equal(result.status,'committed');assert.deepEqual(result.applied,['continued-group','original-group']);
 assert.deepEqual((await s.read(sessionId)).unit,o.unit);
 const old=basis.objects.find(b=>b.id===B)!.value;
 const late=await s.commands.commit({sessionId,attemptId:continued.attemptId,basisId:basis.basisId,operationId:'late-original',changes:[{objectId:B,value:{...old,payload:{...old.payload,text:'Late forbidden'}}}]});
 assert.equal(late.status,'retained');assert.deepEqual((await s.read(sessionId)).unit,o.unit);
}));
test('stale preview cannot overwrite a new relevant revision, while unrelated changes do not invalidate selective withdrawal',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await agentEdit(s,sessionId,'preview-task','preview-1',A,'Preview target');
 const p=await s.formalHistory.preview({sessionId,selection:{kind:'task',taskId:'preview-task'}});
 await agentEdit(s,sessionId,'unrelated','unrelated',B,'Keep unrelated');
 assert.equal((await s.formalHistory.apply({sessionId,operationId:'preview-independent',preview:p})).status,'committed');
 const restore=await s.formalHistory.preview({sessionId,unitId:'KU-001',atOperationId:'preview-1',side:'after'});
 await s.save({sessionId,operationId:'after-preview',inputSeq:1,baseRevision:(await s.read(sessionId)).revision,blockId:A,text:'New after preview'});
 const stale=await s.formalHistory.apply({sessionId,operationId:'stale-restore',preview:restore});
 assert.equal(stale.status,'conflict');assert.match(stale.conflicts[0].reason,/预览后/);assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,'New after preview');
 await assert.rejects(s.formalHistory.apply({sessionId,operationId:'stale-restore',preview:{...restore,side:'before'}}),/同一操作/);
}));
test('explicit layout restore is optional, checked, and reversible without touching the current unit or personal data',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await agentEdit(s,sessionId,'layout-anchor','layout-anchor',A,'Version to restore');
 const g=await s.graph(sessionId),n=g.layout.nodes.find(n=>n.unitId==='KU-001')!,before={unitId:n.unitId,x:n.x,y:n.y,width:n.width},after={...before,x:n.x+140};
 await s.drawings.place({sessionId,operationId:'move-unit',before,after});
 const contentOnly=await s.formalHistory.preview({sessionId,unitId:'KU-001',atOperationId:'layout-anchor',side:'after'});
 assert.equal(contentOnly.affectedObjectIds.includes('layout:KU-001'),false);
 const p=await s.formalHistory.preview({sessionId,unitId:'KU-001',atOperationId:'layout-anchor',side:'after',includeLayout:true});
 assert.ok(p.affectedObjectIds.includes('layout:KU-001'));
 const result=await s.formalHistory.apply({sessionId,operationId:'layout-restore',preview:p});
 assert.equal(result.status,'committed');assert.equal((await s.graph(sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,n.x);
 assert.equal((await s.read(sessionId)).revision,2,'pure layout recovery does not create unrelated body revisions');
 const undo=await s.formalHistory.apply({sessionId,operationId:'layout-restore-undo',preview:await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['layout-restore']}})});
 assert.equal(undo.status,'committed');assert.equal((await s.graph(sessionId)).layout.nodes.find(n=>n.unitId==='KU-001')!.x,after.x);
}));
test('a pre-T21 student record is normalized from its real version chain and remains recoverable after reopen',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await s.save({sessionId,operationId:'old-student',inputSeq:1,baseRevision:o.revision,blockId:A,text:'Before T21'});
 // Remove only the new additive metadata to exercise the real previous operations format.
 const legacy=new DatabaseSync(join(d,'course.sqlite'));
 legacy.prepare("UPDATE operations SET after_text=json_remove(after_text,'$.objectVersions','$.structures') WHERE id=?").run('old-student');legacy.close();
 const p=await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['old-student']}});
 const r=await s.formalHistory.apply({sessionId,operationId:'undo-old-student',preview:p});
 assert.equal(r.status,'committed',JSON.stringify(r));assert.deepEqual((await s.read(sessionId)).unit,o.unit);
 await s.close();const reopened=new CourseService(resolve('dist/worker.cjs'));
 try {const c=await reopened.open(d);assert.deepEqual(await reopened.formalHistory.query({sessionId:c.sessionId,operationId:r.operationId}),r);assert.deepEqual(c.unit,o.unit);}finally{await reopened.close();}
}));
test('history recovery is a new student change delivered to other working tasks atomically',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await agentEdit(s,sessionId,'history-owner','history-original',A,'Before recovery notification');
 const conversation=await s.agent.create({sessionId,operationId:'other-working-conversation'});
 const task=await s.agent.submit({sessionId,operationId:'other-working-start',conversationId:conversation.id,generation:1,text:'Read current explanation',target:{unitId:'KU-001'},intent:'modify'});
 const result=await s.formalHistory.apply({sessionId,operationId:'notified-recovery',preview:await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['history-original']}})});
 assert.equal(result.status,'committed');
 const current=await s.agent.get({sessionId,conversationId:conversation.id});
 assert.ok(current.tasks[0].deliveries?.some(d=>d.kind==='student-change'&&d.change?.operationId==='notified-recovery'),'the live task receives the formal recovery as a new student change');
 assert.equal(current.tasks[0].id,task.id);assert.equal(current.tasks[0].status,'running');
}));
test('old-unit recovery restores the necessary formula experiment and relation together while preserving later layout',async()=>fixture(async(s,d)=>{
 const {sessionId,citation}=await muxCopy(s,d);
 const oldUnit=await s.readUnit(sessionId,'KU-057');oldUnit.reading.blocks[0].payload.latex='Z=¬S0·¬S1·I0+¬S0·S1·I1+S0·¬S1·I2+S0·S1·I3';
 const setup=new DatabaseSync(join(d,'course.sqlite'));setup.prepare('UPDATE units SET payload=? WHERE id=?').run(JSON.stringify(oldUnit),'KU-057');setup.close();
 const graph=await s.graph(sessionId);
 assert.equal((await s.commands.commit(await correction(s,sessionId,citation.id,'restore-aggregate'))).status,'committed');
 const correctedLayout=(await s.graph(sessionId)).layout;
 const preview=await s.formalHistory.preview({sessionId,unitId:'KU-057',atOperationId:'restore-aggregate',side:'before'});
 assert.equal(preview.affectedObjectIds.some(id=>id.startsWith('layout:')),false);
 assert.ok(preview.affectedObjectIds.includes('REL-014'));assert.ok(preview.sourceVersions.includes(citation.versionId));
 const restored=await s.formalHistory.apply({sessionId,operationId:'restore-old-aggregate',preview});
 assert.equal(restored.status,'committed',JSON.stringify(restored));
 assert.deepEqual(await s.readUnit(sessionId,'KU-057'),oldUnit);
 assert.deepEqual((await s.graph(sessionId)).edges,graph.edges);
 assert.deepEqual((await s.graph(sessionId)).layout,correctedLayout);
}));
test('unrecognized structural history stays whole and cannot be silently discarded by old-unit recovery',async()=>fixture(async(s,d)=>{
 const o=await s.open(d),sessionId=o.sessionId;
 await agentEdit(s,sessionId,'future-structure-task','future-structure-group',A,'Published with a future structural domain');
 // Model a later producer's real stored group format without importing its unfinished implementation.
 const producer=new DatabaseSync(join(d,'course.sqlite'));
 const row=producer.prepare('SELECT payload FROM cg_history WHERE operation_id=?').get('future-structure-group')!;
 const group=JSON.parse(String(row.payload));
 for(const objectId of ['future-structure:KU-001']){
  group.changes.push({objectId,before:{name:'Before'},after:{name:'After'},beforeVersion:1,afterVersion:2});
  producer.prepare('INSERT INTO cg_objects VALUES(?,?,?,?)').run(objectId,objectId.split(':')[0],JSON.stringify({name:'After'}),2);
 }
 producer.prepare('UPDATE cg_history SET payload=? WHERE operation_id=?').run(JSON.stringify(group),'future-structure-group');producer.close();
 const preview=await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['future-structure-group']}});
 const result=await s.formalHistory.apply({sessionId,operationId:'do-not-split-future',preview});
 assert.equal(result.status,'conflict');assert.match(result.conflicts[0].reason,/尚不支持.*结构/);
 assert.equal((await s.read(sessionId)).unit.reading.blocks[0].payload.text,'Published with a future structural domain');
 await assert.rejects(s.formalHistory.preview({sessionId,unitId:'KU-001',atOperationId:'future-structure-group',side:'before'}),/尚不支持.*结构/);
}));
test('a historically restored relation is live and editable again without permitting arbitrary retired identity reuse',async()=>fixture(async(s,d)=>{
 const {sessionId}=await s.open(d),basis=await s.relations.read({sessionId}),edge=basis.graph.edges.find(e=>e.id==='REL-001')!;
 await s.relations.commit({sessionId,generation:1,basisId:basis.basisId,operationId:'remove-relation',changes:[{id:edge.id,value:null}]});
 const restored=await s.formalHistory.apply({sessionId,operationId:'restore-relation',preview:await s.formalHistory.preview({sessionId,selection:{kind:'operations',operationIds:['remove-relation']}})});
 assert.equal(restored.status,'committed');
 const live=await s.relations.read({sessionId});
 const edited=await s.relations.commit({sessionId,generation:1,basisId:live.basisId,operationId:'edit-restored-relation',changes:[{id:edge.id,value:{...edge,value:'Historically restored and now updated'}}]});
 assert.equal(edited.status,'committed');
 const newer=await s.relations.read({sessionId});
 await s.relations.commit({sessionId,generation:1,basisId:newer.basisId,operationId:'remove-again',changes:[{id:edge.id,value:null}]});
 const retired=await s.relations.read({sessionId});
 await assert.rejects(s.relations.commit({sessionId,generation:1,basisId:retired.basisId,operationId:'illegal-reuse',changes:[{id:edge.id,value:{...edge,value:'Unrelated replacement'}}]}),/退休/);
}));
