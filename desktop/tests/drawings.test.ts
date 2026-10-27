import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';

const rectangle = { kind: 'rectangle' as const, anchor: { space: 'board' as const }, geometry: { x: 80, y: 120, width: 240, height: 100 } };
test('personal shapes persist across reopen with exact receipts and never create formal relationships', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-drawings-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root); const graph = await core.graph(c.sessionId);
    const request = { sessionId: c.sessionId, operationId: 'rectangle', id: 'drawing-1', expectedVersion: 0, value: rectangle };
    const saved = await core.drawings.apply(request);
    assert.deepEqual(saved.value, rectangle); assert.equal(saved.version, 1);
    const history=await core.drawings.history({sessionId:c.sessionId});assert.equal(history[0].actor,'student');assert.match(history[0].committedAt,/^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await core.drawings.apply(request), saved);
    assert.deepEqual(await core.drawings.query({ sessionId: c.sessionId, operationId: 'rectangle' }), saved);
    await assert.rejects(core.drawings.apply({ ...request, value: { ...rectangle, kind: 'arrow' } }), /同一操作/);
    await core.drawings.apply({ ...request, id: 'personal-arrow', operationId: 'arrow', value: { ...rectangle, kind: 'arrow' } });
    assert.deepEqual(await core.graph(c.sessionId), graph); assert.deepEqual((await core.read(c.sessionId)).unit, c.unit);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(root);
    const drawings = await core.drawings.list({ sessionId: c.sessionId });
    assert.equal(drawings.length, 2); assert.deepEqual(drawings[0].value, rectangle); assert.equal(drawings[0].status, 'attached');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('geometry edits, saved inverse operations, deletion and history preserve one identity and immutable original', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-drawing-history-')); const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await core.open(root), sessionId = c.sessionId;
    let saved = await core.drawings.apply({ sessionId, operationId: 'create', id: 'shape', expectedVersion: 0, value: rectangle });
    const moved = { ...rectangle, geometry: { x: 180, y: 200, width: 350, height: 140 } };
    saved = await core.drawings.apply({ sessionId, operationId: 'move', id: saved.id, expectedVersion: saved.version, value: moved });
    saved = await core.drawings.apply({ sessionId, operationId: 'undo-move', id: saved.id, expectedVersion: saved.version, value: rectangle });
    assert.deepEqual(saved.value, rectangle); assert.deepEqual(saved.original, rectangle);
    saved = await core.drawings.apply({ sessionId, operationId: 'delete', id: saved.id, expectedVersion: saved.version, value: null });
    assert.equal(saved.status, 'deleted'); assert.equal(saved.value, null);
    const history = await core.drawings.history({ sessionId, id: saved.id });
    assert.equal(history.length, 4); assert.deepEqual(history[1].before, rectangle); assert.deepEqual(history[1].after, moved);
    assert.deepEqual(history[3].before, rectangle); assert.equal(history[3].after, null);
    saved = await core.drawings.apply({ sessionId, operationId: 'restore', id: saved.id, expectedVersion: saved.version, value: history[3].before });
    assert.deepEqual(saved.value, rectangle); assert.equal(saved.id, 'shape');
    await assert.rejects(core.drawings.apply({ sessionId, operationId: 'stale', id: saved.id, expectedVersion: 1, value: moved }), /图形已变化/);
    assert.equal((await core.drawings.history({ sessionId })).length, 5);
    for (const kind of ['ellipse', 'line', 'wave', 'highlighter'] as const) {
      await core.drawings.apply({ sessionId, operationId: kind, id: kind, expectedVersion: 0, value: { ...rectangle, kind } });
    }
    assert.equal((await core.drawings.list({ sessionId })).length, 5);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('image-relative and object coordinates survive layout changes; removed targets keep their original context and can be recovered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-drawing-anchor-')); let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root); const image = { id: 'image-target', kind: 'figure', payload: { asset: 'ti74153-1.png', alt: 'TI 74153', caption: '原图语境' } };
    const initialIds = c.unit.reading.blocks.map(b => b.id);
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'insert-image', inputSeq: 1, baseRevision: c.revision, changes: [], complete: true, patch: { updates: [], correspondence: [], structure: { parentId: c.unit.id, before: initialIds, after: [...initialIds, image.id], inserted: [image] } } });
    c = await core.read(c.sessionId);
    const value = { kind: 'ellipse' as const, anchor: { space: 'image' as const, unitId: c.unit.id, blockId: image.id, block: image }, geometry: { x: .1, y: .2, width: .35, height: .25 } };
    let saved = await core.drawings.apply({ sessionId: c.sessionId, operationId: 'image-mark', id: 'image-mark', expectedVersion: 0, value });
    const graph = await core.graph(c.sessionId), pos = graph.layout.nodes.find(n => n.unitId === c.unit.id)!;
    await core.setLayout(c.sessionId, [{ ...pos, x: pos.x + 300, y: pos.y + 200, width: 900 }]);
    assert.deepEqual((await core.drawings.list({ sessionId: c.sessionId }))[0].value?.geometry, value.geometry);
    await core.drawings.apply({ sessionId: c.sessionId, operationId: 'object-mark', id: 'object-mark', expectedVersion: 0, value: { ...rectangle, anchor: { space: 'object', unitId: c.unit.id, blockId: image.id, block: image } } });
    const ids = c.unit.reading.blocks.map(b => b.id);
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'remove-image', inputSeq: 2, baseRevision: c.revision, complete: true, changes: [], patch: { updates: [], correspondence: [], structure: { parentId: c.unit.id, before: ids, after: ids.filter(id => id !== image.id), inserted: [] } } });
    const marks = await core.drawings.list({ sessionId: c.sessionId });
    assert.deepEqual(marks.map(m => m.status), ['orphan', 'orphan']); assert.deepEqual(marks[0].original.anchor, value.anchor);
    saved = await core.drawings.apply({ sessionId: c.sessionId, operationId: 'recover-on-board', id: saved.id, expectedVersion: saved.version, value: { ...rectangle, kind: 'ellipse' } });
    assert.equal(saved.status, 'attached'); assert.deepEqual(saved.original, value);
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(root);
    assert.deepEqual((await core.drawings.list({ sessionId: c.sessionId }))[0], saved);
    await assert.rejects(core.drawings.apply({ sessionId: c.sessionId, operationId: 'bad-relative', id: 'bad', expectedVersion: 0, value: { ...value, geometry: { x: 2, y: .2, width: .2, height: .2 } } }), /几何|目标/);
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('text highlighter reuses the proven T07 range and immutable context through edits, deletion, reassociation and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-drawing-text-')); let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    let c = await core.open(root); const b = c.unit.reading.blocks[0], text = String(b.payload.text);
    const selection = { unitId: c.unit.id, fragments: [{ blockId: b.id, block: b, field: 'text' as const, formalRevision: c.revision, source: 'formal' as const, projection: { version: 1 as const, encoding: 'unicode-code-points' as const, text }, from: 1, to: 4, quote: Array.from(text).slice(1, 4).join('') }] };
    const saved = await core.drawings.apply({ sessionId: c.sessionId, operationId: 'highlight', id: 'highlight', expectedVersion: 0, selection, value: { kind: 'highlighter', anchor: { space: 'text', noteId: '' }, geometry: { x: 0, y: 0, width: 1, height: 1 } } });
    assert.equal(saved.value?.anchor.space, 'text');
    const notes = await core.annotations.list({ sessionId: c.sessionId }); assert.equal(notes.length, 1); assert.deepEqual(notes[0].original, selection);
    assert.equal(saved.value?.anchor.space === 'text' && saved.value.anchor.noteId, notes[0].id);
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'prefix', inputSeq: 1, baseRevision: c.revision, changes: [], complete: true, patch: { updates: [{ blockId: b.id, before: b.payload, after: { ...b.payload, text: '新' + text } }], correspondence: [], textEdits: [{ blockId: b.id, before: text, after: '新' + text, from: 0, to: 0, inserted: '新' }] } });
    let note = (await core.annotations.list({ sessionId: c.sessionId }))[0]; assert.equal(note.current.fragments[0].from, 2);
    assert.equal((await core.drawings.list({ sessionId: c.sessionId }))[0].status, 'attached');
    c = await core.read(c.sessionId); const ids = c.unit.reading.blocks.map(b => b.id);
    await core.commitEdit({ sessionId: c.sessionId, operationId: 'delete-text', inputSeq: 2, baseRevision: c.revision, changes: [], complete: true, patch: { updates: [], correspondence: [], structure: { parentId: c.unit.id, before: ids, after: ids.slice(1), inserted: [] } } });
    assert.equal((await core.drawings.list({ sessionId: c.sessionId }))[0].status, 'orphan');
    note = (await core.annotations.list({ sessionId: c.sessionId }))[0]; assert.deepEqual(note.original, selection);
    c = await core.read(c.sessionId); const target = c.unit.reading.blocks.find(b => b.kind === 'paragraph')!, body = String(target.payload.text);
    await core.annotations.reassociate({ sessionId: c.sessionId, operationId: 'reassociate-highlight', id: note.id, expectedVersion: note.version, selection: { unitId: c.unit.id, fragments: [{ ...selection.fragments[0], blockId: target.id, block: target, formalRevision: c.revision, projection: { version: 1, encoding: 'unicode-code-points', text: body }, quote: Array.from(body).slice(1,4).join('') }] } });
    assert.equal((await core.drawings.list({ sessionId: c.sessionId }))[0].status, 'attached');
    await core.close(); core = new CourseService(resolve('dist/worker.cjs')); c = await core.open(root);
    assert.deepEqual((await core.annotations.list({ sessionId: c.sessionId }))[0].original, selection);
    assert.equal((await core.drawings.list({ sessionId: c.sessionId }))[0].status, 'attached');
  } finally { await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('late receipt failure rolls shape, range, history and event back together; retries and cross-domain identity fences remain exact', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-drawing-atomic-')); const core = new CourseService(resolve('dist/worker.cjs')); let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const c = await core.open(root), sessionId = c.sessionId, b = c.unit.reading.blocks[0], text = String(b.payload.text);
    const selection = { unitId: c.unit.id, fragments: [{ blockId: b.id, block: b, field: 'text' as const, formalRevision: c.revision, source: 'formal' as const, projection: { version: 1 as const, encoding: 'unicode-code-points' as const, text }, from: 1, to: 3, quote: Array.from(text).slice(1,3).join('') }] };
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER drawing_receipt_fail BEFORE INSERT ON drawing_operations BEGIN SELECT RAISE(ABORT, 'drawing receipt failure'); END");
    const request = { sessionId, operationId: 'atomic-highlight', id: 'atomic', expectedVersion: 0, selection, value: { ...rectangle, kind: 'highlighter' as const, anchor: { space: 'text' as const, noteId: '' } } };
    const cursor = c.eventCursor;
    await assert.rejects(core.drawings.apply(request), /drawing receipt failure/);
    assert.deepEqual(await core.drawings.list({ sessionId }), []); assert.deepEqual(await core.annotations.list({ sessionId }), []); assert.deepEqual(await core.drawings.history({ sessionId }), []);
    assert.equal(await core.drawings.query({ sessionId, operationId: request.operationId }), null);
    const events = await core.readEvents(sessionId, cursor); assert.equal(events.kind, 'events'); if (events.kind === 'events') assert.deepEqual(events.events, []);
    fault.exec('DROP TRIGGER drawing_receipt_fail');
    const saved = await core.drawings.apply(request); assert.deepEqual(await core.drawings.apply(request), saved);
    assert.equal((await core.annotations.list({ sessionId })).length, 1);
    await assert.rejects(core.commitEdit({ sessionId, operationId: request.operationId, inputSeq: 1, baseRevision: c.revision, complete: true, changes: [{ blockId: b.id, text: '不能盗用图形操作' }] }), /操作身份已用于个人图形/);
    await core.annotations.create({ sessionId, operationId: 'note-owned', selection, text: '独立笔记' });
    await assert.rejects(core.drawings.apply({ sessionId, operationId: 'note-owned', id: 'different', expectedVersion: 0, value: rectangle }), /操作身份已用于个人笔记/);
    await core.commitEdit({ sessionId, operationId: 'body-owned', inputSeq: 1, baseRevision: c.revision, complete: true, changes: [{ blockId: b.id, text: text + '尾' }] });
    await assert.rejects(core.drawings.apply({ sessionId, operationId: 'body-owned', id: 'different', expectedVersion: 0, value: rectangle }), /操作身份已用于正文/);
  } finally { fault?.close(); await core.close(); await rm(root, { recursive: true, force: true }); }
});

test('restoring a removed personal shape keeps it findable even if its image target was removed in the meantime', async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-drawing-restore-'));const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const c=await core.open(root),sessionId=c.sessionId,b=c.unit.reading.blocks[0],ids=c.unit.reading.blocks.map(b=>b.id);
    const value={...rectangle,anchor:{space:'object' as const,unitId:c.unit.id,blockId:b.id,block:b}};
    let r=await core.drawings.apply({sessionId,operationId:'create',id:'mark',expectedVersion:0,value});
    r=await core.drawings.apply({sessionId,operationId:'delete',id:r.id,expectedVersion:r.version,value:null});
    await core.commitEdit({sessionId,operationId:'remove-target',inputSeq:1,baseRevision:c.revision,complete:true,changes:[],patch:{updates:[],correspondence:[],structure:{parentId:c.unit.id,before:ids,after:ids.slice(1),inserted:[]}}});
    const request={sessionId,operationId:'undo-delete',id:r.id,expectedVersion:r.version,value};
    const restored=await core.drawings.apply(request);assert.equal(restored.status,'orphan');assert.deepEqual(restored.original,value);
    assert.deepEqual(await core.drawings.apply(request),restored);assert.deepEqual(await core.drawings.query({sessionId,operationId:'undo-delete'}),restored);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('manual unit placement uses the T09 baseline with exact durable history and checked inverse; reading projection never becomes manual content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-board-placement-'));let core=new CourseService(resolve('dist/worker.cjs'));
  try{
    let c=await core.open(root),graph=await core.graph(c.sessionId),node=graph.layout.nodes.find(n=>n.unitId===c.unit.id)!;
    const before={unitId:node.unitId,x:node.x,y:node.y,width:node.width},after={...before,x:before.x+100,width:before.width+24};
    const request={sessionId:c.sessionId,operationId:'place',before,after};
    const receipt=await core.drawings.place(request);assert.deepEqual(receipt.before,before);assert.deepEqual(receipt.after,after);
    assert.deepEqual(await core.drawings.place(request),receipt);
    await core.projectLayout(c.sessionId,{[c.unit.id]:{width:after.width,height:5000}});
    assert.equal((await core.drawings.placements({sessionId:c.sessionId})).length,1);
    await core.drawings.place({sessionId:c.sessionId,operationId:'undo-place',before:after,after:before});
    const saved=(await core.graph(c.sessionId)).layout.nodes.find(n=>n.unitId===c.unit.id)!;assert.equal(saved.x,before.x);assert.equal(saved.width,before.width);
    await assert.rejects(core.drawings.place({sessionId:c.sessionId,operationId:'stale-place',before:after,after:before}),/布局已变化/);
    await core.close();core=new CourseService(resolve('dist/worker.cjs'));c=await core.open(root);
    assert.equal((await core.drawings.placements({sessionId:c.sessionId})).length,2);assert.equal((await core.graph(c.sessionId)).layout.nodes.find(n=>n.unitId===c.unit.id)!.x,before.x);
  }finally{await core.close();await rm(root,{recursive:true,force:true});}
});

test('whole-unit object coordinates persist without copying the unit body into a personal drawing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-unit-drawing-'));const core=new CourseService(resolve('dist/worker.cjs'));
 try{const c=await core.open(root);const record=await core.drawings.apply({sessionId:c.sessionId,operationId:'unit-drawing',id:'unit-drawing',expectedVersion:0,value:{...rectangle,anchor:{space:'object',unitId:c.unit.id}}});assert.equal(record.status,'attached');assert.deepEqual(record.value?.anchor,{space:'object',unitId:c.unit.id});}
 finally{await core.close();await rm(root,{recursive:true,force:true});}
});
