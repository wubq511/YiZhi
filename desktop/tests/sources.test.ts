import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
