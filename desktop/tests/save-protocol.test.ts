import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CourseService } from '../src/core/course-service';

async function fixture(run: (service: CourseService, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t02-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try { await run(service, root); }
  finally { await service.close(); await rm(root, { recursive: true, force: true }); }
}

test('unfinished input recovers with its original basis; stale sequence, different retry and old session cannot replace it', async () => {
  await fixture(async (service, root) => {
    const opened = await service.open(root);
    const draft = { sessionId: opened.sessionId, inputSeq: 12, baseRevision: 1,
      changes: [{ blockId: opened.editableBlockId, text: '尚未完成的输入 \\frac{' }], complete: false };
    const receipt = await service.saveDraft(draft);
    assert.equal(receipt.inputSeq, 12);
    assert.deepEqual(await service.saveDraft(draft), receipt);
    await assert.rejects(service.saveDraft({ ...draft, inputSeq: 11 }), /过期/);
    await assert.rejects(service.saveDraft({ ...draft, complete: true }), /不同内容/);
    const recovered = await service.read(opened.sessionId);
    assert.equal(recovered.revision, 1);
    assert.deepEqual(recovered.drafts[0].input, draft);
    await service.close();
    const next = new CourseService(resolve('dist/worker.cjs'));
    try {
      const reopened = await next.open(root);
      assert.notEqual(reopened.sessionId, opened.sessionId);
      assert.deepEqual(reopened.drafts[0].input, draft);
      await assert.rejects(next.saveDraft({ ...draft, inputSeq: 13 }), /会话已失效/);
    } finally { await next.close(); }
  });
});

test('a multi-paragraph edit and split commit together, retain newer drafts, and retry/query without overwriting later work', async () => {
  await fixture(async (service, root) => {
    const startedAt = Date.now();
    const opened = await service.open(root);
    const paragraphs = opened.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    const first = paragraphs[0].id, second = paragraphs[1].id;
    const input = { sessionId: opened.sessionId, inputSeq: 12, baseRevision: 1, complete: true,
      changes: [{ blockId: first, text: '甲乙丙丁' }, { blockId: second, text: '第二段修改' }],
      splits: [{ blockId: first, newBlockId: 'new-paragraph', offset: 2 }] };
    const command = { ...input, operationId: 'two-blocks-and-split' };
    await service.saveDraft(input);
    const receipt = await service.commitEdit(command);
    const saved = await service.read(opened.sessionId);
    assert.equal(saved.unit.reading.blocks.find(b => b.id === first)!.payload.text, '甲乙');
    assert.equal(saved.unit.reading.blocks.find(b => b.id === 'new-paragraph')!.payload.text, '丙丁');
    assert.equal(saved.unit.reading.blocks.find(b => b.id === second)!.payload.text, '第二段修改');
    assert.equal(saved.drafts.length, 0);
    assert.deepEqual(await service.queryOperation(opened.sessionId, command.operationId), receipt);
    const newer = { ...input, inputSeq: 13, baseRevision: 2, splits: [],
      changes: [{ blockId: first, text: '后来独立编辑' }] };
    await service.commitEdit({ ...newer, operationId: 'later-edit' });
    assert.deepEqual(await service.commitEdit(command), receipt);
    assert.equal((await service.read(opened.sessionId)).unit.reading.blocks[0].payload.text, '后来独立编辑');
    await assert.rejects(service.commitEdit({ ...command, changes: [] }), /不同内容/);
    const history = await service.history(opened.sessionId);
    assert.deepEqual(history.map((h: any) => h.receipt.operationId), ['two-blocks-and-split', 'later-edit']);
    assert.ok(history.every(entry => entry.committedAt !== null &&
      Date.parse(entry.committedAt) >= startedAt && Date.parse(entry.committedAt) <= Date.now()));
    await service.close();
    const next = new CourseService(resolve('dist/worker.cjs'));
    try {
      const reopened = await next.open(root);
      assert.deepEqual(await next.queryOperation(reopened.sessionId, command.operationId), receipt);
      assert.deepEqual(await next.history(reopened.sessionId), history);
    } finally { await next.close(); }
  });
});

test('input 12 cannot absorb or resurrect 13; an earlier independent commit retains 13 and its original basis', async () => {
  await fixture(async (service, root) => {
    const opened = await service.open(root);
    const [a, b] = opened.unit.reading.blocks.filter(b => b.kind === 'paragraph').map(b => b.id);
    const input12 = { sessionId: opened.sessionId, inputSeq: 12, baseRevision: 1, complete: true,
      changes: [{ blockId: b, text: '独立的十二' }] };
    const input13 = { ...input12, inputSeq: 13, changes: [{ blockId: a, text: '未吸收的十三' }] };
    await service.saveDraft(input12);
    await service.saveDraft(input13);
    await service.commitEdit({ ...input12, operationId: 'independent-12' });
    const state = await service.read(opened.sessionId);
    assert.equal(state.confirmedInputSeq, 12);
    assert.deepEqual(state.drafts[0].input, input13);
    await assert.rejects(service.saveDraft(input12), /过期/);
    await assert.rejects(service.commitEdit({ ...input13, operationId: 'stale-13' }), /版本已变化/);
    assert.equal(await service.queryOperation(opened.sessionId, 'stale-13'), null);
    await service.close();
    const next = new CourseService(resolve('dist/worker.cjs'));
    try {
      const reopened = await next.open(root);
      assert.deepEqual(reopened.drafts[0].input, input13);
      await assert.rejects(next.commitEdit({ ...input13, sessionId: reopened.sessionId,
        inputSeq: 1, baseRevision: 2, operationId: 'bypass-old-draft' }), /草稿仍待整合/);
    } finally { await next.close(); }
  });
});

test('newer same-range draft blocks delayed promotion while the latest valid input can commit', async () => {
  await fixture(async (service, root) => {
    const opened = await service.open(root);
    const old = { sessionId: opened.sessionId, inputSeq: 12, baseRevision: 1, complete: true,
      changes: [{ blockId: opened.editableBlockId, text: '十二' }] };
    const newer = { ...old, inputSeq: 13, changes: [{ blockId: opened.editableBlockId, text: '十三' }] };
    await service.saveDraft(old);
    await service.saveDraft(newer);
    await assert.rejects(service.commitEdit({ ...old, operationId: 'old' }), /草稿仍待整合/);
    const receipt = await service.commitEdit({ ...newer, operationId: 'new' });
    assert.equal(receipt.inputSeq, 13);
    const state = await service.read(opened.sessionId);
    assert.equal(state.unit.reading.blocks[0].payload.text, '十三');
    assert.equal(state.drafts.length, 0);
  });
});

test('a slow client replays monotonically in bounded pages and receives explicit snapshot reset after cursor expiry', async () => {
  await fixture(async (service, root) => {
    const opened = await service.open(root);
    let revision = 1;
    for (let seq = 1; seq <= 5; seq++) {
      await service.commitEdit({ sessionId: opened.sessionId, operationId: `event-${seq}`, inputSeq: seq,
        baseRevision: revision++, complete: true, changes: [{ blockId: opened.editableBlockId, text: `输入${seq}` }] });
    }
    const first = await service.readEvents(opened.sessionId, opened.eventCursor, 2);
    assert.equal(first.kind, 'events');
    assert.deepEqual(first.events.map((e: any) => e.cursor), [1, 2]);
    assert.equal(first.hasMore, true);
    const second = await service.readEvents(opened.sessionId, first.cursor, 2);
    assert.equal(second.kind, 'events');
    assert.deepEqual(second.events.map((e: any) => e.cursor), [3, 4]);
    const third = await service.readEvents(opened.sessionId, second.cursor, 2);
    assert.equal(third.kind, 'events');
    assert.deepEqual(third.events.map((e: any) => e.cursor), [5]);
    assert.equal(third.hasMore, false);
    for (let seq = 6; seq <= 270; seq++) {
      await service.saveDraft({ sessionId: opened.sessionId, inputSeq: seq, baseRevision: revision,
        complete: false, changes: [{ blockId: opened.editableBlockId, text: `草稿${seq}` }] });
    }
    const reset = await service.readEvents(opened.sessionId, third.cursor, 2);
    assert.equal(reset.kind, 'reset');
    assert.equal(reset.reason, 'cursor-expired');
    assert.equal(reset.snapshot.revision, 6);
    assert.equal(reset.snapshot.drafts[0].input.inputSeq, 270);
    assert.equal(reset.cursor, 270);
    const empty = await service.readEvents(opened.sessionId, reset.cursor);
    assert.equal(empty.kind, 'events');
    assert.equal(empty.events.length, 0);
    assert.equal((await service.history(opened.sessionId)).length, 5);
  });
});

test('a real SQLite failure at draft consumption rolls back body/history/receipt/events and recovers the entire draft', async () => {
  await fixture(async (service, root) => {
    const opened = await service.open(root);
    const input = { sessionId: opened.sessionId, inputSeq: 12, baseRevision: 1, complete: true,
      changes: [{ blockId: opened.editableBlockId, text: '全部成功或全部失败' }] };
    await service.saveDraft(input);
    const before = await service.read(opened.sessionId);
    const fault = new DatabaseSync(join(root, 'course.sqlite'));
    try {
      fault.exec("CREATE TRIGGER fail_final_step AFTER DELETE ON drafts BEGIN SELECT RAISE(ABORT, 'actual final write failure'); END");
      await assert.rejects(service.commitEdit({ ...input, operationId: 'atomic-edit' }), /actual final write failure/);
      assert.deepEqual(await service.read(opened.sessionId), before);
      assert.equal(await service.queryOperation(opened.sessionId, 'atomic-edit'), null);
      assert.deepEqual(await service.history(opened.sessionId), []);
      await service.close();
      fault.exec('DROP TRIGGER fail_final_step');
      const next = new CourseService(resolve('dist/worker.cjs'));
      try {
        const reopened = await next.open(root);
        assert.equal(reopened.revision, 1);
        assert.deepEqual(reopened.drafts[0].input, input);
        assert.equal(await next.queryOperation(reopened.sessionId, 'atomic-edit'), null);
        const recovered = { ...input, sessionId: reopened.sessionId, inputSeq: 1,
          replacesDraft: { sessionId: input.sessionId, inputSeq: 12 } };
        await next.saveDraft(recovered);
        await next.commitEdit({ ...recovered, operationId: 'recovered-atomic-edit' });
        assert.equal((await next.read(reopened.sessionId)).drafts.length, 0);
        assert.equal((await next.history(reopened.sessionId)).length, 1);
      } finally { await next.close(); }
    } finally { fault.close(); }
  });
});

for (const phase of ['draft', 'committed']) {
  test(`host death after ${phase} durability but before renderer acknowledgement reopens a coherent state`, async () => {
    await fixture(async (service, root) => {
      const child = spawn(process.execPath, [resolve('dist/tests/save-crash-child.cjs'), root, phase], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostics = '';
      child.stderr.on('data', chunk => { diagnostics += chunk; });
      try {
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => reject(new Error(`child failed to reach durability: ${diagnostics}`)), 5000);
          child.stdout.on('data', chunk => {
            if (String(chunk).includes('DURABLE')) { clearTimeout(timer); done(); }
          });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', () => { clearTimeout(timer); reject(new Error(diagnostics)); });
        });
        const died = new Promise<void>(done => child.once('exit', () => done()));
        child.kill('SIGKILL'); await died;
        const reopened = await service.open(root);
        const history = await service.history(reopened.sessionId);
        const receipt = await service.queryOperation(reopened.sessionId, 'crash-operation');
        if (phase === 'draft') {
          assert.equal(reopened.revision, 1);
          assert.equal(reopened.drafts[0].input.inputSeq, 12);
          assert.equal(reopened.drafts[0].input.baseRevision, 1);
          assert.equal(history.length, 0);
          assert.equal(receipt, null);
        } else {
          assert.equal(reopened.revision, 2);
          assert.equal(reopened.drafts.length, 0);
          assert.equal(reopened.unit.reading.blocks[0].payload.text, '强杀边界前已进入真实 SQLite 的输入');
          assert.equal(history.length, 1);
          assert.deepEqual(receipt, history[0].receipt);
        }
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    });
  });
}
