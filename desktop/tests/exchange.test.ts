import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { exchangeFixture } from './exchange-fixture';

test('declared content and personal annotations round-trip through an open package into an independent course, then move and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'source') });
    const source = await core.open(join(root, 'source'));
    const block = source.unit.reading.blocks.find((b) => b.kind === 'paragraph')!;
    const text = String(block.payload.text),
      quote = Array.from(text).slice(0, 2).join('');
    let note = await core.annotations.create({
      sessionId: source.sessionId,
      operationId: 'note',
      text: '我的原始批注',
      selection: {
        unitId: 'KU-001',
        fragments: [
          {
            blockId: block.id,
            block,
            formalRevision: source.revision,
            source: 'formal',
            field: 'text',
            projection: { version: 1, encoding: 'unicode-code-points', text },
            from: 0,
            to: 2,
            quote,
          },
        ],
      },
    });
    await core.save({
      sessionId: source.sessionId,
      operationId: 'changed-source',
      inputSeq: 1,
      baseRevision: source.revision,
      blockId: source.editableBlockId,
      text: '正文已改写，原批注继续保留',
    });
    note = (await core.annotations.list({ sessionId: source.sessionId }))[0];
    assert.equal(note.current.status, 'orphan');
    const bundle = join(root, '中文 空格 Exchange');
    const report = await core.exchange.exportPackage({
      sessionId: source.sessionId,
      directory: bundle,
      unitIds: ['KU-001', 'KU-086'],
      annotations: true,
    });
    assert.equal(report.formatVersion, 'yizhi-exchange-1');
    assert.equal(report.kind, 'content-exchange');
    assert.ok(report.excludes.includes('history'));
    await exchangeFixture(join(root, 'legacy-destination'), 'KU-087');
    await core.migration.convert({
      sourceDirectory: join(root, 'legacy-destination'),
      directory: join(root, 'destination'),
    });
    const destination = await core.open(join(root, 'destination'));
    await core.save({
      sessionId: destination.sessionId,
      operationId: 'changed-destination',
      inputSeq: 1,
      baseRevision: destination.revision,
      blockId: destination.editableBlockId,
      text: '正文已改写，原批注继续保留',
    });
    const preview = await core.exchange.inspect({ sessionId: destination.sessionId, directory: bundle });
    const request = {
      sessionId: destination.sessionId,
      operationId: 'import',
      directory: bundle,
      basis: preview.basis,
      packageDigest: preview.packageDigest,
    };
    const receipt = await core.exchange.importPackage(request);
    assert.equal(receipt.status, 'committed');
    const found = await core.search.query({
      sessionId: destination.sessionId,
      query: '末单元完整正文',
      scopes: ['knowledge'],
    });
    assert.ok(found.hits.some((h) => h.unitId === 'KU-086'));
    assert.equal(found.status.unavailable, 0);
    assert.deepEqual(
      await core.readUnit(destination.sessionId, 'KU-086'),
      await core.readUnit(source.sessionId, 'KU-086'),
    );
    assert.deepEqual(await core.annotations.list({ sessionId: destination.sessionId }), [note]);
    assert.match(
      (await core.sources.page({ sessionId: destination.sessionId, versionId: 'VER-EXTRA', pdfPageIndex: 0 }))
        .projection.text,
      /Independent fixed source/,
    );
    assert.ok((await core.graph(destination.sessionId)).edges.some((e) => e.id === 'REL-EXCHANGE'));
    assert.match(
      (await core.sources.page({ sessionId: destination.sessionId, versionId: 'VER-TEST', pdfPageIndex: 0 })).projection
        .text,
      /Fixed legacy source/,
    );
    await core.close();
    await rename(join(root, 'destination'), join(root, '独立 课程'));
    await rm(bundle, { recursive: true });
    await rm(join(root, 'source'), { recursive: true });
    core = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await core.open(join(root, '独立 课程'));
    assert.equal((await core.readUnit(reopened.sessionId, 'KU-086')).name, '持久化末单元');
    assert.deepEqual(await core.exchange.importPackage({ ...request, sessionId: reopened.sessionId }), receipt);
    assert.deepEqual(await core.annotations.list({ sessionId: reopened.sessionId }), [note]);
    const image = await core.migration.resource({
      sessionId: reopened.sessionId,
      asset: '/source-pages/SRC-EXTRA/VER-EXTRA/1.png',
    });
    assert.ok(image.bytes.length > 500);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('unsupported executable payloads are rejected before any declared range can import', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-payload-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'course') });
    const c = await core.open(join(root, 'course'));
    await core.exchange.exportPackage({
      sessionId: c.sessionId,
      directory: join(root, 'package'),
      unitIds: ['KU-001', 'KU-086'],
      annotations: false,
    });
    const path = join(root, 'package/manifest.json'),
      p = JSON.parse(await readFile(path, 'utf8'));
    p.units[1].value.reading.blocks.push({
      id: 'unsupported-runtime',
      kind: 'interactive',
      payload: { component: 'arbitrary-code', source: 'untrusted' },
    });
    await writeFile(path, JSON.stringify(p));
    await assert.rejects(core.exchange.inspect({ sessionId: c.sessionId, directory: join(root, 'package') }), /不支持/);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('whole-range validation rejects missing/hash-mismatched resources, unsafe paths, symlinks and invalid references without formal changes', async () => {
  const { readFile, writeFile, symlink, unlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-invalid-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'course') });
    const c = await core.open(join(root, 'course'));
    const directory = join(root, '包 中文 spaces');
    await core.exchange.exportPackage({
      sessionId: c.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: false,
    });
    const path = join(directory, 'manifest.json'),
      original = await readFile(path, 'utf8'),
      p = JSON.parse(original);
    const before = await core.readUnit(c.sessionId, 'KU-086'),
      cursor = (await core.read(c.sessionId)).eventCursor;
    const resource = join(directory, p.resources[0].path),
      bytes = await readFile(resource);
    await unlink(resource);
    await assert.rejects(core.exchange.inspect({ sessionId: c.sessionId, directory }), /缺失/);
    await writeFile(resource, 'wrong hash');
    await assert.rejects(core.exchange.inspect({ sessionId: c.sessionId, directory }), /摘要不符/);
    await unlink(resource);
    await symlink(join(root, 'course', p.resources[0].path), resource);
    await assert.rejects(core.exchange.inspect({ sessionId: c.sessionId, directory }), /软链/);
    await unlink(resource);
    await writeFile(resource, bytes);
    const mutations = [
      (v: any) => (v.formatVersion = 'future-99'),
      (v: any) => (v.units[1].value.reading.schemaVersion = 'future-reading'),
      (v: any) => (v.units[1].value.reading.blocks[0].kind = 'unknown-block'),
      (v: any) => (v.units[1].value.reading.blocks[1].children[0].payload.columns = null),
      (v: any) =>
        v.units[1].value.reading.blocks.push({
          id: 'bad-ref',
          kind: 'knowledge-reference',
          payload: { targetUnitId: 'KU-MISSING' },
        }),
      (v: any) => (v.graph.edges[0].sourceRefs[0].versionId = 'VER-MISSING'),
      (v: any) => (v.graph.edges[0].fromUnitId = 'KU-MISSING'),
      (v: any) => (v.units[1].value.reading.blocks[2].payload.asset = '/../escape.png'),
      ...[
        '../escape',
        '/absolute',
        'resources/../escape',
        'resources\\escape',
        'resources/CON',
        'resources/name.',
        'resources/' + p.resources[0].sha256.toUpperCase(),
        'resources/中文 空格',
      ].map((name) => (v: any) => (v.resources[0].path = name)),
    ];
    for (const mutate of mutations) {
      const bad = JSON.parse(original);
      mutate(bad);
      await writeFile(path, JSON.stringify(bad));
      await assert.rejects(core.exchange.inspect({ sessionId: c.sessionId, directory }));
    }
    await writeFile(path, original);
    assert.deepEqual(await core.readUnit(c.sessionId, 'KU-086'), before);
    assert.equal((await core.read(c.sessionId)).eventCursor, cursor);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('current basis and existing personal edits are protected; real late SQLite failure rolls back everything and exact retry succeeds', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-atomic-'));
  let core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'source') });
    const source = await core.open(join(root, 'source'));
    const directory = join(root, 'package');
    await core.exchange.exportPackage({
      sessionId: source.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: false,
    });
    await exchangeFixture(join(root, 'legacy-dest'), 'KU-087');
    await core.migration.convert({ sourceDirectory: join(root, 'legacy-dest'), directory: join(root, 'dest') });
    let dest = await core.open(join(root, 'dest'));
    let preview = await core.exchange.inspect({ sessionId: dest.sessionId, directory });
    const original = await core.read(dest.sessionId);
    await core.setReviewStatus(dest.sessionId, 'KU-001', 'weak');
    // A saved personal state is part of the current course basis, even without a content change.
    await core.saveDraft({
      sessionId: dest.sessionId,
      inputSeq: 1,
      baseRevision: dest.revision,
      changes: [{ blockId: dest.editableBlockId, text: '必须保留的未提交输入' }],
      complete: false,
    });
    await assert.rejects(
      core.exchange.importPackage({
        sessionId: dest.sessionId,
        directory,
        operationId: 'stale',
        basis: preview.basis,
        packageDigest: preview.packageDigest,
      }),
      /依据已变化/,
    );
    preview = await core.exchange.inspect({ sessionId: dest.sessionId, directory });
    const request = {
      sessionId: dest.sessionId,
      directory,
      operationId: 'atomic-import',
      basis: preview.basis,
      packageDigest: preview.packageDigest,
    };
    const fault = new DatabaseSync(join(root, 'dest/course.sqlite'));
    fault.exec(
      "CREATE TRIGGER reject_exchange BEFORE INSERT ON exchange_operations BEGIN SELECT RAISE(ABORT,'real import registration failure');END",
    );
    await assert.rejects(core.exchange.importPackage(request), /real import registration failure/);
    assert.equal(await core.exchange.query({ sessionId: dest.sessionId, operationId: request.operationId }), null);
    await assert.rejects(core.readUnit(dest.sessionId, 'KU-086'), /不存在/);
    assert.deepEqual((await core.read(dest.sessionId)).unit, original.unit);
    assert.equal((await core.sources.list({ sessionId: dest.sessionId })).versions.length, 1);
    assert.ok(!(await core.graph(dest.sessionId)).edges.some((e) => e.id === 'REL-EXCHANGE'));
    fault.exec('DROP TRIGGER reject_exchange');
    fault.close();
    await core.close();
    core = new CourseService(resolve('dist/worker.cjs'));
    dest = await core.open(join(root, 'dest'));
    const receipt = await core.exchange.importPackage({ ...request, sessionId: dest.sessionId });
    assert.equal(receipt.status, 'committed');
    assert.equal((await core.read(dest.sessionId)).drafts[0].input.changes[0].text, '必须保留的未提交输入');
    assert.deepEqual((await core.read(dest.sessionId)).unit, original.unit);
    assert.equal((await core.readUnit(dest.sessionId, 'KU-086')).name, '持久化末单元');
    await assert.rejects(
      core.annotations.create({
        sessionId: dest.sessionId,
        operationId: request.operationId,
        selection: { unitId: 'KU-001', fragments: [] },
        text: 'cannot-reuse',
      }),
      /操作身份/,
    );
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('identity conflicts in existing body, block ownership and personal annotation fail the entire range', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-conflict-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'source') });
    const source = await core.open(join(root, 'source'));
    const directory = join(root, 'package');
    await core.exchange.exportPackage({
      sessionId: source.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: false,
    });
    await exchangeFixture(join(root, 'legacy-dest'), 'KU-087');
    await core.migration.convert({ sourceDirectory: join(root, 'legacy-dest'), directory: join(root, 'dest') });
    const dest = await core.open(join(root, 'dest'));
    const path = join(directory, 'manifest.json'),
      original = await readFile(path, 'utf8');
    const malformed = JSON.parse(original);
    malformed.units[1].value.reading.blocks[0].id = 'last-body-other';
    await writeFile(path, JSON.stringify(malformed));
    let p = await core.exchange.inspect({ sessionId: dest.sessionId, directory });
    await assert.rejects(
      core.exchange.importPackage({
        sessionId: dest.sessionId,
        directory,
        operationId: 'block-conflict',
        basis: p.basis,
        packageDigest: p.packageDigest,
      }),
      /身份冲突/,
    );
    await writeFile(path, original);
    await core.save({
      sessionId: dest.sessionId,
      operationId: 'personal-edit',
      inputSeq: 1,
      baseRevision: dest.revision,
      blockId: dest.editableBlockId,
      text: '学生新写的正文',
    });
    p = await core.exchange.inspect({ sessionId: dest.sessionId, directory });
    await assert.rejects(
      core.exchange.importPackage({
        sessionId: dest.sessionId,
        directory,
        operationId: 'body-conflict',
        basis: p.basis,
        packageDigest: p.packageDigest,
      }),
      /身份冲突/,
    );
    assert.equal((await core.read(dest.sessionId)).unit.reading.blocks[0].payload.text, '学生新写的正文');
    await assert.rejects(core.readUnit(dest.sessionId, 'KU-086'), /不存在/);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('forged resource metadata cannot register undecodable image bytes even when its self-declared hash matches', async () => {
  const { readFile, writeFile, unlink } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-decode-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'course') });
    const c = await core.open(join(root, 'course'));
    const directory = join(root, 'package');
    await core.exchange.exportPackage({
      sessionId: c.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: false,
    });
    const path = join(directory, 'manifest.json'),
      p = JSON.parse(await readFile(path, 'utf8')),
      old = p.resources.find((r: any) => r.mediaType === 'image/png').sha256,
      bytes = Buffer.from('This is not an image'),
      hash = createHash('sha256').update(bytes).digest('hex');
    for (const r of p.resources.filter((r: any) => r.sha256 === old)) {
      r.sha256 = hash;
      r.path = `resources/${hash}`;
      r.byteLength = bytes.length;
    }
    await writeFile(join(directory, 'resources', hash), bytes);
    await writeFile(path, JSON.stringify(p));
    await exchangeFixture(join(root, 'legacy-dest'), 'KU-087');
    await core.migration.convert({ sourceDirectory: join(root, 'legacy-dest'), directory: join(root, 'dest') });
    const dest = await core.open(join(root, 'dest'));
    const preview = await core.exchange.inspect({ sessionId: dest.sessionId, directory });
    await assert.rejects(
      core.exchange.importPackage({
        sessionId: dest.sessionId,
        directory,
        operationId: 'forged',
        basis: preview.basis,
        packageDigest: preview.packageDigest,
      }),
      /Invalid|image|图片|decode|Unsupported|format/i,
    );
    assert.equal(await core.exchange.query({ sessionId: dest.sessionId, operationId: 'forged' }), null);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('forged personal annotation projections cannot import as valid personal records', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-note-validation-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'course') });
    const c = await core.open(join(root, 'course'));
    const block = c.unit.reading.blocks[0],
      text = String(block.payload.text);
    await core.annotations.create({
      sessionId: c.sessionId,
      operationId: 'note-validation',
      text: '保留原文',
      selection: {
        unitId: 'KU-001',
        fragments: [
          {
            blockId: block.id,
            block,
            formalRevision: c.revision,
            source: 'formal',
            field: 'text',
            projection: { version: 1, encoding: 'unicode-code-points', text },
            from: 0,
            to: 2,
            quote: Array.from(text).slice(0, 2).join(''),
          },
        ],
      },
    });
    const directory = join(root, 'package');
    await core.exchange.exportPackage({
      sessionId: c.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: true,
    });
    const path = join(directory, 'manifest.json'),
      p = JSON.parse(await readFile(path, 'utf8'));
    p.notes[0].note.original.fragments[0].quote = '这是伪造引文';
    await writeFile(path, JSON.stringify(p));
    await assert.rejects(core.exchange.inspect({ sessionId: c.sessionId, directory }), /批注/);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('incoming note identity cannot overwrite a personal note in the target course', async () => {
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-personal-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'source') });
    await exchangeFixture(join(root, 'legacy-dest'), 'KU-087');
    await core.migration.convert({ sourceDirectory: join(root, 'legacy-dest'), directory: join(root, 'dest') });
    const source = await core.open(join(root, 'source')),
      dest = await core.open(join(root, 'dest'));
    const create = (c: typeof source, text: string) => {
      const block = c.unit.reading.blocks[0],
        body = String(block.payload.text);
      return core.annotations.create({
        sessionId: c.sessionId,
        operationId: 'note-' + c.sessionId,
        text,
        selection: {
          unitId: 'KU-001',
          fragments: [
            {
              blockId: block.id,
              block,
              formalRevision: c.revision,
              source: 'formal',
              field: 'text',
              projection: { version: 1, encoding: 'unicode-code-points', text: body },
              from: 0,
              to: 2,
              quote: Array.from(body).slice(0, 2).join(''),
            },
          ],
        },
      });
    };
    await create(source, '来自包的批注');
    const personal = await create(dest, '目标课程自己的批注');
    const directory = join(root, 'package');
    await core.exchange.exportPackage({
      sessionId: source.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: true,
    });
    const path = join(directory, 'manifest.json'),
      p = JSON.parse(await readFile(path, 'utf8'));
    p.notes[0].note.id = personal.id;
    await writeFile(path, JSON.stringify(p));
    const preview = await core.exchange.inspect({ sessionId: dest.sessionId, directory });
    await assert.rejects(
      core.exchange.importPackage({
        sessionId: dest.sessionId,
        directory,
        operationId: 'personal-conflict',
        basis: preview.basis,
        packageDigest: preview.packageDigest,
      }),
      /身份冲突/,
    );
    assert.deepEqual(await core.annotations.list({ sessionId: dest.sessionId }), [personal]);
    await assert.rejects(core.readUnit(dest.sessionId, 'KU-086'), /不存在/);
    assert.equal((await core.sources.list({ sessionId: dest.sessionId })).versions.length, 1);
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a fixed PNG source version retains its actual image semantics and immutable bytes in the declared package', async () => {
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-exchange-image-source-'));
  const core = new CourseService(resolve('dist/worker.cjs'));
  try {
    await exchangeFixture(join(root, 'legacy'));
    await core.migration.convert({ sourceDirectory: join(root, 'legacy'), directory: join(root, 'course') });
    const c = await core.open(join(root, 'course'));
    const image = await core.migration.resource({
      sessionId: c.sessionId,
      asset: '/source-pages/SRC-EXTRA/VER-EXTRA/1.png',
    });
    const path = join(root, '中文 Image.PNG');
    await writeFile(path, image.bytes);
    const source = await core.sources.importFile({
      sessionId: c.sessionId,
      generation: 1,
      operationId: 'image-source',
      path,
      title: '图片固定来源',
    });
    assert.equal(source.version.pdfPages, 0);
    const attempt = await core.commands.startAttempt({ sessionId: c.sessionId, taskId: 'image-ref' });
    const basis = await core.commands.read({
      sessionId: c.sessionId,
      attemptId: attempt.attemptId,
      objectIds: [c.editableBlockId],
    });
    const before = basis.objects.find((o) => o.id === c.editableBlockId)!.value;
    const receipt = await core.commands.commit({
      sessionId: c.sessionId,
      attemptId: attempt.attemptId,
      operationId: 'image-ref',
      basisId: basis.basisId,
      changes: [
        {
          objectId: c.editableBlockId,
          value: {
            ...before,
            sourceRefs: [
              ...(before.sourceRefs ?? []),
              { sourceId: source.version.sourceId, versionId: source.version.versionId, section: '整张图片' },
            ],
          },
        },
      ],
    });
    assert.equal(receipt.status, 'committed');
    const directory = join(root, 'package');
    await core.exchange.exportPackage({
      sessionId: c.sessionId,
      directory,
      unitIds: ['KU-001', 'KU-086'],
      annotations: false,
    });
    const preview = await core.exchange.inspect({ sessionId: c.sessionId, directory });
    await core.exchange.importPackage({
      sessionId: c.sessionId,
      directory,
      operationId: 'image-package',
      basis: preview.basis,
      packageDigest: preview.packageDigest,
    });
    assert.deepEqual(
      await core.sources.getVersion({ sessionId: c.sessionId, versionId: source.version.versionId }),
      source.version,
    );
  } finally {
    await core.close();
    await rm(root, { recursive: true, force: true });
  }
});
