import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { sourceFixture } from './source-fixture';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';

test('imported PDF versions remain immutable and independently readable after new import and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-sources-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const path = join(root, 'original.pdf');
    await sourceFixture(path);
    const opened = await service.open(join(root, 'course'));
    const sources = service.sources;
    const first = await sources.importFile({ sessionId: opened.sessionId, generation: 1,
      operationId: 'import-first', path, title: 'Course evidence' });
    assert.equal(first.version.pdfPages, 2);
    assert.equal(first.version.mediaType, 'application/pdf');
    assert.deepEqual(await sources.importFile({ sessionId: opened.sessionId, generation: 1,
      operationId: 'import-first', path, title: 'Course evidence' }), first);
    await sourceFixture(path, 'New revision evidence');
    const next = await sources.importFile({ sessionId: opened.sessionId, generation: 1,
      operationId: 'import-new', sourceId: first.version.sourceId, path, title: 'Course evidence' });
    assert.notEqual(next.version.versionId, first.version.versionId);
    assert.notEqual(next.version.sha256, first.version.sha256);
    assert.equal(next.version.sourceId, first.version.sourceId);
    assert.deepEqual((await service.read(opened.sessionId)).unit, opened.unit);
    await assert.rejects(service.save({ sessionId: opened.sessionId, operationId: 'import-first', inputSeq: 1,
      baseRevision: 1, blockId: opened.editableBlockId, text: 'Must not reuse source operation' }), /操作身份/);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(join(root, 'course'));
    const all = await service.sources.list({ sessionId: reopened.sessionId });
    assert.equal(all.versions.length, 2);
    const bytes = await service.sources.readResource({ sessionId: reopened.sessionId,
      versionId: first.version.versionId, begin: 0, end: 8 });
    assert.equal(Buffer.from(bytes.bytes).toString(), '%PDF-1.7');
    assert.deepEqual((await service.read(reopened.sessionId)).unit, opened.unit);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('resource publication and real SQLite failures leave no formal half source; exact retry and repair preserve old citation identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-resource-fault-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  let fault: DatabaseSync | undefined;
  try {
    const path = join(root, 'fixture.pdf'); await sourceFixture(path);
    const opened = await service.open(join(root, 'course'));
    let sessionId = opened.sessionId;
    const command = { sessionId, generation: 1, operationId: 'publish', path, title: 'Evidence' };
    await writeFile(join(root, 'course/resources'), 'real filesystem obstruction');
    await assert.rejects(service.sources.importFile(command));
    assert.deepEqual((await service.sources.list({ sessionId })).versions, []);
    await rm(join(root, 'course/resources'));
    fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    fault.exec("CREATE TRIGGER fail_source_event BEFORE INSERT ON save_events BEGIN SELECT RAISE(ABORT,'source event disk fault'); END");
    await assert.rejects(service.sources.importFile(command), /source event disk fault/);
    assert.deepEqual((await service.sources.list({ sessionId })).versions, []);
    assert.equal(await service.sources.query({ sessionId, operationId: command.operationId }), null);
    fault.exec('DROP TRIGGER fail_source_event');
    fault.close(); fault = undefined;
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    sessionId = (await service.open(join(root, 'course'))).sessionId; command.sessionId = sessionId;
    await assert.rejects(service.sources.importFile({ ...command, title: 'Changed operation identity' }), /不同内容/);
    await sourceFixture(path, 'Changed after the failed import');
    const saved = await service.sources.importFile(command);
    assert.equal((await service.sources.page({ sessionId, versionId: saved.version.versionId, pdfPageIndex: 0 })).projection.text,
      'Original course evidence\nSecond line of evidence');
    await sourceFixture(path);
    const citation = await service.sources.cite({ sessionId, generation: 1, operationId: 'page-citation',
      versionId: saved.version.versionId, pdfPageIndex: 0 });
    await assert.rejects(service.sources.readResource({ sessionId, versionId: saved.version.versionId, begin: 0, end: 2 ** 21 }), /范围/);
    await assert.rejects(service.sources.readResource({ sessionId, versionId: '../../course.sqlite', begin: 0, end: 8 }), /未登记/);
    const blob = join(root, 'course/resources', saved.version.sha256);
    const bytes = await readFile(blob);
    await writeFile(blob, Buffer.alloc(bytes.length, 'x'));
    await assert.rejects(service.sources.page({ sessionId, versionId: citation.versionId, pdfPageIndex: 0 }), /损坏/);
    assert.deepEqual((await service.read(sessionId)).unit, opened.unit);
    await service.sources.repairFile({ sessionId, generation: 1, operationId: 'repair', versionId: citation.versionId, path });
    assert.equal((await service.sources.page({ sessionId, versionId: citation.versionId, pdfPageIndex: 0 })).projection.text,
      'Original course evidence\nSecond line of evidence');
    assert.deepEqual((await service.sources.citations({ sessionId }))[0], citation);
    assert.equal((await service.sources.list({ sessionId })).versions.length, 1);
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('citations retain actual versioned text, verified printed-page mapping and region; update intent never rewrites them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-citation-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const path = join(root, 'first.pdf'); await sourceFixture(path);
    const opened = await service.open(join(root, 'course')), sessionId = opened.sessionId;
    const version = (await service.sources.importFile({ sessionId, generation: 1, operationId: 'first', path, title: 'Evidence' })).version;
    const sources = service.sources;
    const page = await sources.page({ sessionId, versionId: version.versionId, pdfPageIndex: 0 });
    assert.equal(page.printedPage, null); // PDF index is NOT an inferred printed page.
    assert.equal(page.projection.text, 'Original course evidence\nSecond line of evidence');
    const mapping = await sources.mapPrintedPage({ sessionId, generation: 1, operationId: 'map',
      versionId: version.versionId, pdfPageIndex: 0, printedPage: 'iv' });
    const citation = await sources.cite({ sessionId, generation: 1, operationId: 'quote',
      versionId: version.versionId, pdfPageIndex: 0, projectionId: page.projection.id,
      start: 0, end: 8, region: { x0: 32, y0: 235, x1: 110, y1: 260 }, target: { unitId: 'KU-001', blockId: opened.editableBlockId } });
    assert.equal(citation.quote, 'Original');
    assert.ok(citation.printedPage);
    assert.equal(citation.printedPage.label, 'iv');
    assert.equal(citation.printedPage.id, mapping.id);
    assert.equal(citation.coordinateSpace, 'pdf-user-space');
    assert.equal(citation.projection.convention, 'pdfjs-text-items-eol/codepoint-v1');
    assert.deepEqual(citation.target, { unitId: 'KU-001', blockId: opened.editableBlockId });
    assert.equal((await sources.locatePrintedPage({ sessionId, versionId: version.versionId, printedPage: 'iv' }))[0].pdfPageIndex, 0);
    assert.deepEqual(await sources.locatePrintedPage({ sessionId, versionId: version.versionId, printedPage: '100' }), []);
    const scanned = await sources.page({ sessionId, versionId: version.versionId, pdfPageIndex: 1 });
    assert.equal(scanned.projection.text, '');
    const imageCitation = await sources.cite({ sessionId, generation: 1, operationId: 'no-text',
      versionId: version.versionId, pdfPageIndex: 1, region: { x0: 30, y0: 60, x1: 210, y1: 240 } });
    assert.equal(imageCitation.quote, null);
    assert.equal(imageCitation.textStatus, 'no-text-layer');
    await sourceFixture(path, 'New evidence');
    const next = (await service.sources.importFile({ sessionId, generation: 1, operationId: 'next', path, title: 'Evidence', sourceId: version.sourceId })).version;
    await sources.setUpdateIntent({ sessionId, generation: 1, operationId: 'defer', versionId: next.versionId, decision: 'defer' });
    const intent = await sources.setUpdateIntent({ sessionId, generation: 1, operationId: 'request-update', versionId: next.versionId, decision: 'update' });
    assert.equal(intent.decision, 'update');
    assert.deepEqual((await service.read(sessionId)).unit, opened.unit);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(join(root, 'course'));
    const citations = await service.sources.citations({ sessionId: reopened.sessionId });
    assert.deepEqual(citations[0], citation);
    assert.equal((await service.sources.page({ sessionId: reopened.sessionId, versionId: citation.versionId, pdfPageIndex: citation.pdfPageIndex })).projection.text,
      'Original course evidence\nSecond line of evidence');
    await assert.rejects(service.sources.cite({ sessionId: reopened.sessionId, generation: 1, operationId: 'lie',
      versionId: version.versionId, pdfPageIndex: 0, projectionId: 'wrong projection', start: 0, end: 8 }), /投影/);
    await assert.rejects(service.sources.cite({ sessionId: reopened.sessionId, generation: 0, operationId: 'stale',
      versionId: version.versionId, pdfPageIndex: 0 }), /代际/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('image import validates actual image bytes and malformed or missing resources cannot take down the course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-image-source-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(join(root, 'course')), sessionId = opened.sessionId;
    const path = join(root, 'image.png'), canvas = createCanvas(80, 60);
    const context = canvas.getContext('2d'); context.fillStyle = '#6965db'; context.fillRect(0, 0, 80, 60);
    await writeFile(path, canvas.toBuffer('image/png'));
    const version = (await service.sources.importFile({ sessionId, generation: 1, operationId: 'image', path, title: 'Synthetic image fixture' })).version;
    const page = await service.sources.page({ sessionId, versionId: version.versionId, pdfPageIndex: 0 });
    assert.deepEqual(page.view, [0, 0, 80, 60]);
    assert.equal(page.projection.text, '');
    const citation = await service.sources.cite({ sessionId, generation: 1, operationId: 'image-region', versionId: version.versionId,
      pdfPageIndex: 0, region: { x0: 10, y0: 12, x1: 60, y1: 40 } });
    assert.equal(citation.coordinateSpace, 'image-pixels-top-left');
    assert.equal(citation.quote, null);
    await writeFile(path, 'not an image');
    await assert.rejects(service.sources.importFile({ sessionId, generation: 1, operationId: 'bad-image', path, title: 'Invalid fixture' }));
    const brokenPdf = join(root, 'broken.pdf'); await writeFile(brokenPdf, '%PDF-1.7 incomplete');
    await assert.rejects(service.sources.importFile({ sessionId, generation: 1, operationId: 'bad-pdf', path: brokenPdf, title: 'Invalid PDF' }));
    await rm(join(root, 'course/resources', version.sha256));
    await assert.rejects(service.sources.page({ sessionId, versionId: version.versionId, pdfPageIndex: 0 }));
    assert.equal((await service.sources.list({ sessionId })).versions.length, 1);
    assert.deepEqual((await service.read(sessionId)).unit, opened.unit);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('source identities share the formal operation fence and imported versions can support a formal relation without rewriting existing references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-source-domains-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const path = join(root, 'source.pdf'); await sourceFixture(path);
    const opened = await service.open(join(root, 'course')), sessionId = opened.sessionId;
    const originalCatalog = await service.relations.read({ sessionId });
    assert.equal(originalCatalog.sources.reduce((total, source) => total + source.versions.length, 0), 16);
    await service.save({ sessionId, operationId: 'student-edit', inputSeq: 1, baseRevision: 1, blockId: opened.editableBlockId, text: 'Student evidence review' });
    await assert.rejects(service.sources.importFile({ sessionId, generation: 1, operationId: 'student-edit', path, title: 'Evidence' }), /操作身份/);
    const imported = await service.sources.importFile({ sessionId, generation: 1, operationId: 'source-import', path, title: 'Evidence' });
    const attempt = await service.commands.startAttempt({ sessionId, taskId: 'independent-producer' });
    const basis = await service.commands.read({ sessionId, attemptId: attempt.attemptId, objectIds: [opened.editableBlockId] });
    const block = basis.objects.find(object => object.id === opened.editableBlockId)!;
    await assert.rejects(service.commands.commit({ sessionId, attemptId: attempt.attemptId, operationId: 'source-import', basisId: basis.basisId,
      changes: [{ objectId: block.id, value: block.value }] }), /操作身份/);
    const relationBasis = await service.relations.read({ sessionId });
    for (const source of originalCatalog.sources) assert.deepEqual(relationBasis.sources.find(item => item.id === source.id), source);
    assert.deepEqual(relationBasis.graph.edges, originalCatalog.graph.edges);
    await assert.rejects(service.sources.getVersion({ sessionId, versionId: originalCatalog.sources[0].versions[0].id }), /未登记/);
    assert.ok(relationBasis.sources.some(source => source.id === imported.version.sourceId && source.versions.some(version => version.id === imported.version.versionId)));
    const edge = { ...relationBasis.graph.edges[0], value: 'Explicit correction supported by imported immutable evidence',
      sourceRefs: [{ sourceId: imported.version.sourceId, versionId: imported.version.versionId, pdfPages: [1] }] };
    await assert.rejects(service.relations.commit({ sessionId, generation: relationBasis.generation, basisId: relationBasis.basisId,
      operationId: 'source-import', changes: [{ id: edge.id, value: edge }] }), /操作身份/);
    const result = await service.relations.commit({ sessionId, generation: relationBasis.generation, basisId: relationBasis.basisId,
      operationId: 'relation-correction', changes: [{ id: edge.id, value: edge }] });
    assert.equal(result.status, 'committed');
    await assert.rejects(service.sources.setUpdateIntent({ sessionId, generation: 1, operationId: 'relation-correction', versionId: imported.version.versionId, decision: 'update' }), /操作身份/);
    assert.equal((await service.read(sessionId)).unit.reading.blocks[0].payload.text, 'Student evidence review');
    assert.equal((await service.sources.list({ sessionId })).versions.length, 1);
    await service.close();
    const reopenedService = new CourseService(resolve('dist/worker.cjs'));
    try {
      const reopened = await reopenedService.open(join(root, 'course'));
      const next = await reopenedService.relations.read({ sessionId: reopened.sessionId });
      assert.ok(next.sources.some(source => source.id === imported.version.sourceId && source.versions[0].id === imported.version.versionId));
      assert.deepEqual(next.graph.edges.find(item => item.id === edge.id)?.sourceRefs, edge.sourceRefs);
    } finally { await reopenedService.close(); }
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});


test('other course saves while a real validated source is held before publication', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-source-staging-')),gate=new SharedArrayBuffer(4);
  const core=new CourseService(resolve('dist/worker.cjs'),{sourceScheduling:{beforePublish:gate}});
  let pending:Promise<unknown>|undefined;
  try {
    const a=await core.open(join(root,'a')),b=await core.open(join(root,'b')),path=join(root,'real.pdf');await sourceFixture(path);
    pending=core.sources.importFile({sessionId:a.sessionId,generation:a.generation,operationId:'held-import',path,title:'Real validation'});
    for(let i=0;Atomics.load(new Int32Array(gate),0)!==1;i++){assert.ok(i<200,'real validator reaches publication gate');await new Promise(r=>setTimeout(r,5));}
    const save=core.commitEdit({sessionId:b.sessionId,operationId:'during-staging',inputSeq:1,baseRevision:b.revision,complete:true,changes:[{blockId:b.editableBlockId,text:'B保存不依赖A的文件校验完成'}]});
    assert.equal(await Promise.race([save.then(()=>true),new Promise(r=>setTimeout(()=>r(false),500))]),true,'B must save while A publication remains held');
    assert.equal(Atomics.load(new Int32Array(gate),0),1);
    assert.equal((await core.sources.list({sessionId:a.sessionId})).versions.length,0);
    Atomics.store(new Int32Array(gate),0,2);await pending;
    assert.equal((await core.read(b.sessionId)).unit.reading.blocks[0].payload.text,'B保存不依赖A的文件校验完成');
  } finally {Atomics.store(new Int32Array(gate),0,2);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});

async function sourceStage(gate:SharedArrayBuffer) {
  for(let i=0;i<1000;i++) {if(Atomics.load(new Int32Array(gate),0)===1)return;await new Promise(r=>setTimeout(r,5));}
  throw new Error('Source publication gate not reached');
}
const releaseSource=(gate:SharedArrayBuffer)=>Atomics.store(new Int32Array(gate),0,2);

test('a validated import cannot publish through a restored session and exact concurrent staging retries share one receipt', async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-source-session-')),gate=new SharedArrayBuffer(4);
  const core=new CourseService(resolve('dist/worker.cjs'),{sourceScheduling:{beforePublish:gate}});let pending:Promise<unknown>|undefined;
  try {
    const c=await core.open(join(root,'course')),path=join(root,'source.pdf');await sourceFixture(path);
    await core.commitEdit({...c,operationId:'source-reset-anchor',inputSeq:1,baseRevision:c.revision,complete:true,changes:[{blockId:c.editableBlockId,text:'保留恢复锚点'}]});
    const preview=await core.courseRestore.preview({...c,atOperationId:'source-reset-anchor',side:'after',unitIds:[c.unit.id],userState:{layout:false,review:false}});
    const request={sessionId:c.sessionId,generation:c.generation,operationId:'stale-source',path,title:'Staged before reset'};
    pending=core.sources.importFile(request);pending.catch(()=>{});await sourceStage(gate);
    const reset=await core.courseRestore.apply({...c,operationId:'reset-during-source',preview});
    releaseSource(gate);await assert.rejects(pending,/会话|代际|失效/);
    assert.equal((await core.sources.list({sessionId:reset.sessionId})).versions.length,0);
    assert.equal((await readdir(join(root,'course','resources'))).filter(x=>/^[a-f0-9]{64}$/.test(x)).length,0,'stale validation never publishes immutable bytes');
    const fresh={...request,sessionId:reset.sessionId,generation:reset.generation,operationId:'shared-source-stage'};
    const first=core.sources.importFile(fresh),second=core.sources.importFile(fresh);pending=first;
    await sourceStage(gate);releaseSource(gate);
    const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);
    assert.deepEqual(await core.sources.importFile(fresh),a);
    assert.equal((await core.sources.list({sessionId:reset.sessionId})).versions.length,1);
  }finally{releaseSource(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});

test('upgrade freezes staged source publication before snapshot while another course still saves',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-source-upgrade-')),gate=new SharedArrayBuffer(4);
  const core=new CourseService(resolve('dist/worker.cjs'),{sourceScheduling:{beforePublish:gate}});let pending:Promise<unknown>|undefined,upgrade:Promise<unknown>|undefined;
  try {
    const c=await core.open(join(root,'course')),b=await core.open(join(root,'other')),path=join(root,'real.pdf');await sourceFixture(path);
    pending=core.sources.importFile({...c,operationId:'source-at-upgrade',path,title:'May not cross freeze'});pending.catch(()=>{});await sourceStage(gate);
    const request={...c,upgradeId:'freeze-source-stage',directory:join(root,'v2'),backupDirectory:join(root,'backup')};
    upgrade=core.upgrade.prepare(request);upgrade.catch(()=>{});
    for(let i=0;;i++){
      try{await core.read(c.sessionId);}catch(error){assert.match(String(error),/升级|停写/);break;}
      assert.ok(i<1000,'upgrade must reach its actual freeze boundary');await new Promise(r=>setTimeout(r,5));
    }
    await core.commitEdit({...b,operationId:'other-during-source-upgrade',inputSeq:1,baseRevision:b.revision,complete:true,changes:[{blockId:b.editableBlockId,text:'另一课继续'}]});
    releaseSource(gate);await assert.rejects(pending,/升级|停写/);await upgrade;
    assert.equal((await core.format.validate({directory:request.directory})).courseId,c.courseId);
    await core.upgrade.cancel({sessionId:c.sessionId,upgradeId:request.upgradeId});
    const current=await core.open(join(root,'course'));
    assert.equal((await core.sources.list(current)).versions.length,0);
    assert.equal((await core.read(b.sessionId)).unit.reading.blocks[0].payload.text,'另一课继续');
  }finally{releaseSource(gate);await pending?.catch(()=>{});await upgrade?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});

test('exact-hash repair stages outside other course saves and rechecks the shared operation namespace',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-source-repair-stage-')),gate=new SharedArrayBuffer(4);
  const core=new CourseService(resolve('dist/worker.cjs'),{sourceScheduling:{beforePublish:gate}});let pending:Promise<any>|undefined;
  try {
    const c=await core.open(join(root,'course')),b=await core.open(join(root,'other')),path=join(root,'real.pdf');await sourceFixture(path);
    pending=core.sources.importFile({...c,operationId:'repair-stage-source',path,title:'Repair original'});await sourceStage(gate);releaseSource(gate);
    const source=await pending,request={...c,operationId:'held-repair',versionId:source.version.versionId,path};
    await rm(join(root,'course/resources',source.version.sha256));
    pending=core.sources.repairFile(request);await sourceStage(gate);
    await core.commitEdit({...b,operationId:'save-during-repair',inputSeq:1,baseRevision:b.revision,complete:true,changes:[{blockId:b.editableBlockId,text:'修复期间继续保存'}]});
    assert.equal(Atomics.load(new Int32Array(gate),0),1);releaseSource(gate);
    assert.deepEqual(await pending,source.version);
    assert.deepEqual(await core.sources.repairFile(request),source.version);
    assert.equal((await core.sources.page({...c,versionId:source.version.versionId,pdfPageIndex:0})).projection.text,'Original course evidence\nSecond line of evidence');
    const collision={...c,operationId:'claimed-during-stage',path,title:'Must recheck identity'};
    pending=core.sources.importFile(collision);pending.catch(()=>{});await sourceStage(gate);
    await core.commitEdit({...c,operationId:collision.operationId,inputSeq:1,baseRevision:c.revision,complete:true,changes:[{blockId:c.editableBlockId,text:'正式保存先取得身份'}]});
    releaseSource(gate);await assert.rejects(pending,/身份/);
    assert.equal((await core.sources.list(c)).versions.length,1);
  }finally{releaseSource(gate);await pending?.catch(()=>{});await core.close();await rm(root,{recursive:true,force:true});}
});
