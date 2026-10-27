import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { spawn } from 'node:child_process';

test('a copied real unit saves one paragraph and reopens with its complete payload and stable identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yizhi-t01-test-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const seed = JSON.parse(await readFile('fixtures/unit-001.json', 'utf8'));
    const opened = await service.open(directory);
    assert.equal(opened.unit.id, 'KU-001');
    assert.deepEqual(opened.unit, seed);
    assert.equal(opened.runtime.pragmas.journalMode, 'wal');
    assert.equal(opened.runtime.pragmas.foreignKeys, 1);
    assert.equal(opened.runtime.pragmas.synchronous, 2);
    const receipt = await service.save({ sessionId: opened.sessionId, operationId: 'first-save',
      inputSeq: 1, baseRevision: opened.revision, blockId: opened.editableBlockId,
      text: '位置记数法：同一个数字，位置不同，位权不同。' });
    assert.equal(receipt.inputSeq, 1);
    assert.equal(receipt.revision, 2);
    await service.close();
    service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(directory);
    assert.equal(reopened.courseId, opened.courseId);
    seed.reading.blocks[0].payload.text = '位置记数法：同一个数字，位置不同，位权不同。';
    assert.deepEqual(reopened.unit, seed);
    assert.equal(reopened.revision, 2);
    console.log('actual runtime', reopened.runtime);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real SQLite rejection rolls back, the same input can retry, and lost-response retry applies only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t01-failure-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let fault: DatabaseSync | undefined;
  try {
    const opened = await service.open(root);
    const command = { sessionId: opened.sessionId, operationId: 'retry-unchanged-input', inputSeq: 1,
      baseRevision: 1, blockId: opened.editableBlockId, text: '写入失败后仍保留的中文输入 📝' };
    // Fault injection at the real storage boundary, never a successful CourseService substitute.
    fault = new DatabaseSync(join(root, 'course.sqlite'));
    fault.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON units BEGIN SELECT RAISE(ABORT, 'test disk write rejected'); END");
    await assert.rejects(service.save(command), /test disk write rejected/);
    const failed = await service.read(opened.sessionId);
    assert.deepEqual(failed.unit, opened.unit);
    assert.equal(failed.revision, 1);
    fault.exec('DROP TRIGGER reject_write');
    const saved = await service.save(command);
    assert.deepEqual(await service.save(command), saved);
    await assert.rejects(service.save({ ...command, text: 'different payload' }), /不同内容/);
    assert.equal((await service.read(opened.sessionId)).revision, 2);
    await service.close();
    const reopened = new CourseService(resolve('dist/worker.cjs'));
    try {
      const result = await reopened.open(root);
      assert.equal(result.unit.reading.blocks[0].payload.text, command.text);
      assert.equal(result.revision, 2);
    } finally { await reopened.close(); }
  } finally { fault?.close(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('another process cannot own an already-open canonical course, then can acquire it after release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t01-owner-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  const child = () => new Promise<string>((resolveOutput, reject) => {
    const proc = spawn(process.execPath, [resolve('dist/tests/ownership-child.cjs'), root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    proc.stdout.on('data', chunk => { output += chunk; });
    proc.stderr.on('data', chunk => { output += chunk; });
    proc.on('error', reject);
    proc.on('exit', () => resolveOutput(output));
  });
  try {
    await service.open(root);
    assert.match(await child(), /第二份写入资格/);
    await service.close();
    assert.match(await child(), /OWNED KU-001/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('reopening a canonical course resumes the confirmed input progress in the same session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t01-alias-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const first = await service.open(join(root, 'course'));
    await service.save({ sessionId: first.sessionId, operationId: 'edit-before-close', inputSeq: 1,
      baseRevision: 1, blockId: first.editableBlockId, text: '关闭窗口后继续阅读' });
    await symlink(join(root, 'course'), join(root, 'alias'));
    const resumed = await service.open(join(root, 'alias'));
    assert.equal(resumed.sessionId, first.sessionId);
    assert.equal(resumed.confirmedInputSeq, 1);
    await service.save({ sessionId: resumed.sessionId, operationId: 'edit-after-reopen',
      inputSeq: resumed.confirmedInputSeq + 1, baseRevision: resumed.revision,
      blockId: resumed.editableBlockId, text: '继续编辑成功' });
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('course navigation exposes the real lightweight graph and reads a selected unit on demand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t04-navigation-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const course = await service.open(root);
    const graph = await service.graph(course.sessionId);
    assert.equal(graph.nodes.length, 84);
    assert.equal(graph.groups.length, 20);
    assert.equal(graph.nodes.find(node => node.id === 'KU-002')?.name, '非十进制与十进制互转');
    assert.equal('reading' in graph.nodes[0], false);
    const unit = await service.readUnit(course.sessionId, 'KU-002');
    assert.equal(unit.id, 'KU-002');
    assert.ok(unit.reading.blocks.length > 3);
    await assert.rejects(service.readUnit(course.sessionId, 'KU-999'));
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('reading state survives reopening the course with disclosure and return position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-reading-state-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const opened = await service.open(root);
    const state = { unitId: 'KU-002', expanded: { 'RB-TH-01-17-next-unit-reference:hint': true }, returnStack: [{ unitId: 'KU-001', blockId: 'RB-TH-01-17-next-unit-reference', scrollTop: 420 }], scrollTop: 20 };
    await service.setReadingState(opened.sessionId, state);
    await service.close(); service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    assert.deepEqual(await service.readingState(reopened.sessionId), state);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
