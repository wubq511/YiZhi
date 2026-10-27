import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { ParagraphSaveChannel, type SaveState } from '../src/renderer/save-channel';
import type { EditCommand } from '../src/shared';
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('real save channel handles event-before-response 12/13 without false saved state and unions two blocks plus split', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-channel-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  const committed = deferred(); const release = deferred();
  let channel: ParagraphSaveChannel | undefined;
  try {
    const course = await service.open(root);
    const [a, b] = course.unit.reading.blocks.filter(b => b.kind === 'paragraph').map(b => b.id);
    const states: SaveState[] = [];
    const bridge = {
      saveDraft: service.saveDraft.bind(service), queryOperation: service.queryOperation.bind(service),
      readEvents: service.readEvents.bind(service), read: service.read.bind(service),
      commitEdit: async (command: EditCommand) => {
        const receipt = await service.commitEdit(command);
        if (command.inputSeq === 12) { committed.resolve(); await release.promise; }
        return receipt;
      },
    };
    channel = new ParagraphSaveChannel(bridge, { ...course, confirmedInputSeq: 11 }, s => states.push(s));
    channel.input('十二');
    const flushed = channel.flush();
    await committed.promise;
    const at13 = states.length;
    channel.edit({ changes: [{ blockId: a, text: '甲乙丙丁' }] });
    await channel.synchronize(); // formal receipt through real event replay before IPC response
    assert.equal(states.slice(at13).some(s => s.status === 'saved'), false);
    assert.equal(channel.text(a), '甲乙丙丁');
    channel.edit({ changes: [{ blockId: b, text: '第二段十三' }] });
    channel.edit({ changes: [], splits: [{ blockId: a, newBlockId: 'split-from-pending', offset: 2 }] });
    release.resolve();
    assert.equal(await flushed, true);
    const saved = await service.read(course.sessionId);
    assert.equal(saved.confirmedInputSeq, 15);
    assert.equal(saved.unit.reading.blocks.find(x => x.id === a)!.payload.text, '甲乙');
    assert.equal(saved.unit.reading.blocks.find(x => x.id === b)!.payload.text, '第二段十三');
    assert.equal(saved.unit.reading.blocks.find(x => x.id === 'split-from-pending')!.payload.text, '丙丁');
    assert.equal((await service.history(course.sessionId)).length, 2);
    const count = states.filter(s => s.status === 'saved').length;
    await channel.synchronize();
    assert.equal(states.filter(s => s.status === 'saved').length, count);
  } finally { release.resolve(); channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('continuous input saves before idle, and a dropped formal response is queried without duplicating a split', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-bounded-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const course = await service.open(root);
    let lost = true;
    const bridge = {
      saveDraft: service.saveDraft.bind(service), queryOperation: service.queryOperation.bind(service),
      readEvents: service.readEvents.bind(service), read: service.read.bind(service),
      commitEdit: async (command: EditCommand) => {
        const receipt = await service.commitEdit(command);
        if (lost) { lost = false; throw new Error('transport disconnected after durable commit'); }
        return receipt;
      },
    };
    const states: SaveState[] = [];
    channel = new ParagraphSaveChannel(bridge, course, state => states.push(state), { idleMs: 500, maxWaitMs: 40, pollMs: 0 });
    // Genuine timer and Worker execution, with new input arriving much more often than idleMs.
    for (let n = 1; n <= 14; n++) {
      channel.input(`持续输入${n}`);
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok((await service.history(course.sessionId)).length > 0, 'must persist while typing continues');
    assert.ok(states.some(s => s.status === 'error'), 'lost IPC response is visible until reconciled');
    assert.equal(await channel.flush(), true);
    channel.edit({ changes: [{ blockId: course.editableBlockId, text: '甲📝乙丙' }],
      splits: [{ blockId: course.editableBlockId, newBlockId: 'once-only', offset: 2 }] });
    lost = true;
    assert.equal(await channel.flush(), false);
    channel.input('后来的独立输入');
    assert.equal(await channel.flush(), true);
    const saved = await service.read(course.sessionId);
    assert.equal(saved.unit.reading.blocks.filter(b => b.id === 'once-only').length, 1);
    assert.equal(saved.unit.reading.blocks.find(b => b.id === 'once-only')!.payload.text, '乙丙');
    assert.equal(saved.unit.reading.blocks[0].payload.text, '后来的独立输入');
    const history = await service.history(course.sessionId);
    assert.equal(new Set(history.map(h => h.receipt.operationId)).size, history.length);
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('reopened incomplete input is shown and retained as a draft, then corrected input is formally saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-recovery-'));
  let service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const course = await service.open(root);
    await service.saveDraft({ sessionId: course.sessionId, inputSeq: 13, baseRevision: 1, complete: false,
      changes: [{ blockId: course.editableBlockId, text: '尚未完成 \\frac{' }] });
    await service.close();
    service = new CourseService(resolve('dist/worker.cjs'));
    const reopened = await service.open(root);
    const states: SaveState[] = [];
    channel = new ParagraphSaveChannel(service, reopened, state => states.push(state), { pollMs: 0 });
    assert.equal(channel.text(course.editableBlockId), '尚未完成 \\frac{');
    assert.equal(await channel.flush(), true);
    assert.equal(states.at(-1)!.status, 'draft');
    assert.equal((await service.history(reopened.sessionId)).length, 0);
    channel.input('已经修正的完整正文');
    assert.equal(await channel.flush(), true);
    const saved = await service.read(reopened.sessionId);
    assert.equal(saved.unit.reading.blocks[0].payload.text, '已经修正的完整正文');
    assert.equal(saved.drafts.length, 0);
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a complete unabsorbed draft from the same host session is automatically promoted on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-complete-recovery-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const opened = await service.open(root);
    await service.saveDraft({ sessionId: opened.sessionId, inputSeq: 7, baseRevision: 1, complete: true,
      changes: [{ blockId: opened.editableBlockId, text: '窗口消失前已确认的完整草稿' }] });
    const resumed = await service.open(root);
    channel = new ParagraphSaveChannel(service, resumed, () => {}, { pollMs: 0 });
    assert.equal(await channel.flush(), true);
    assert.equal((await service.read(resumed.sessionId)).unit.reading.blocks[0].payload.text, '窗口消失前已确认的完整草稿');
    assert.equal((await service.read(resumed.sessionId)).drafts.length, 0);
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});

test('a disconnected UI catches up on reconnect, explicitly resets an expired cursor and can keep saving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-ui-replay-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  let channel: ParagraphSaveChannel | undefined;
  try {
    const opened = await service.open(root);
    const snapshots: string[] = [];
    let disconnected = true;
    const bridge = {
      saveDraft: service.saveDraft.bind(service), queryOperation: service.queryOperation.bind(service),
      commitEdit: service.commitEdit.bind(service), read: service.read.bind(service),
      readEvents: async (...args: Parameters<CourseService['readEvents']>) => {
        if (disconnected) throw new Error('IPC temporarily disconnected');
        return service.readEvents(...args);
      },
    };
    channel = new ParagraphSaveChannel(bridge, opened, () => {}, { pollMs: 0,
      onSnapshot: snapshot => snapshots.push(String(snapshot.unit.reading.blocks[0].payload.text)) });
    await assert.rejects(channel.synchronize(), /temporarily disconnected/);
    await service.save({ sessionId: opened.sessionId, operationId: 'reconnect-edit', inputSeq: 1,
      baseRevision: 1, blockId: opened.editableBlockId, text: '断联时的正式修改' });
    disconnected = false;
    await channel.synchronize();
    assert.deepEqual(snapshots, ['断联时的正式修改']);
    await channel.synchronize();
    assert.equal(snapshots.length, 1);
    for (let seq = 2; seq <= 260; seq++) {
      await service.save({ sessionId: opened.sessionId, operationId: `offline-${seq}`, inputSeq: seq,
        baseRevision: seq, blockId: opened.editableBlockId, text: `最新正式输入${seq}` });
    }
    await channel.synchronize();
    assert.equal(snapshots.at(-1), '最新正式输入260');
    channel.input('慢窗口赶上后继续输入');
    assert.equal(await channel.flush(), true);
    assert.equal((await service.read(opened.sessionId)).confirmedInputSeq, 261);
  } finally { channel?.dispose(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
