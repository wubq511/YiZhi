import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';

test('controlled producer uses real IPC: stale premise is retained, reread integrates, stop keeps the receipt and rejects late writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-electron-t03-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    const entry = window.getByText('可控生产者 · 验证入口', { exact: true });
    await expect(entry).toBeVisible({ timeout: 3000 });
    await entry.click();
    await window.getByRole('button', { name: '读取当前依据', exact: true }).click();
    const candidate = window.getByRole('textbox', { name: '可控候选内容' });
    await expect(candidate).not.toHaveValue('');
    const oldCandidate = await candidate.inputValue();
    const editor = window.getByRole('textbox', { name: '编辑首段正文' });
    await editor.fill('学生已修改前提，需要重新读取整合。');
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await window.getByRole('button', { name: '提交可控修改', exact: true }).click();
    const status = window.getByRole('status', { name: '可控生产者状态' });
    await expect(status).toContainText('依据已变化');
    await expect(candidate).toHaveValue(oldCandidate);
    await expect(editor).toHaveText('学生已修改前提，需要重新读取整合。');
    await window.getByRole('button', { name: '重读并整合', exact: true }).click();
    await expect(candidate).toHaveValue(/学生已修改前提，需要重新读取整合。/);
    await window.getByRole('button', { name: '提交可控修改', exact: true }).click();
    await expect(status).toContainText('正式修改已保存');
    // The static reading projection changes, and the original student save channel keeps working afterward.
    await expect(window.getByText(/【可控示例】读取的前提：学生已修改前提/).first()).toBeVisible();
    await editor.fill('可控修改提交后，学生仍可继续自动保存。');
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await window.getByRole('button', { name: '停止本次尝试', exact: true }).click();
    await expect(status).toContainText('已停止');
    await window.getByRole('button', { name: '核对最近提交', exact: true }).click();
    await expect(status).toContainText('原回执已核对');
    await candidate.fill('停止后到达的新候选');
    await window.getByRole('button', { name: '提交可控修改', exact: true }).click();
    await expect(status).toContainText('尝试已停止');
    await expect(candidate).toHaveValue('停止后到达的新候选');
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t03-desktop.png', fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 600));
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t03-narrow.png', fullPage: true });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('real Electron IPC saves, retains failed input, retries, drains quit, reopens; second app rejoins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-electron-t01-'));
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let fault: DatabaseSync | undefined;
  try {
    app = await launch();
    let window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    let editor = window.getByRole('textbox', { name: '编辑首段正文' });
    await expect(editor).toContainText('位置记数法');
    const identity = await window.evaluate(() => (window as any).yizhi.open());
    expect(identity.unit.id).toBe('KU-001');
    expect(identity.runtime.pragmas).toEqual({ journalMode: 'wal', foreignKeys: 1, synchronous: 2 });
    console.log('Electron actual runtime', identity.runtime);
    const contender = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
      env: { ...process.env, YIZHI_DATA_HOME: join(root, 'another-profile') } });
    const contenderProcess = contender.process();
    try {
      const blocked = await contender.firstWindow();
      await expect(blocked.getByRole('alert')).toContainText('第二份写入资格');
      await contender.evaluate(({ app }) => app.quit());
      await expect.poll(() => contenderProcess.exitCode, { timeout: 3000 }).not.toBeNull();
    } finally { if (contenderProcess.exitCode === null) contenderProcess.kill('SIGKILL'); }
    fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    fault.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON units BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END");
    await editor.fill('保存失败后保留这段输入，重试仍是它。');
    await expect(window.getByRole('status')).toContainText('未保存');
    await expect(editor).toHaveText('保存失败后保留这段输入，重试仍是它。');
    // A failed save must also prevent a normal close, retaining the live editor.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(window.getByRole('status')).toContainText('未保存');
    expect(window.isClosed()).toBe(false);
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t01-error.png' });
    fault.exec('DROP TRIGGER reject_write');
    await window.getByRole('button', { name: '重试保存' }).click();
    await expect(window.getByRole('status')).toHaveText('已保存');
    // A duplicate application process must exit, and focus/reuse the existing window.
    const second = spawn(app.process().spawnfile, [resolve('.'), `--course=${join(root, 'course')}`], {
      env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') }, stdio: 'ignore'
    });
    try {
      await expect.poll(() => second.exitCode, { timeout: 8000 }).toBe(0);
    } finally { if (second.exitCode === null) second.kill('SIGKILL'); }
    expect(app.windows()).toHaveLength(1);
    const closedWindow = window.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closedWindow;
    await app.evaluate(async ({ app }) => {
      await new Promise<void>(done => setTimeout(done, 100));
      app.emit('activate');
    });
    window = await app.firstWindow();
    editor = window.getByRole('textbox', { name: '编辑首段正文' });
    await expect(editor).toHaveText('保存失败后保留这段输入，重试仍是它。');
    const resumed = await window.evaluate(() => (window as any).yizhi.open());
    expect(resumed.sessionId).toBe(identity.sessionId);
    expect(resumed.confirmedInputSeq).toBeGreaterThan(0);
    await editor.fill('退出前最后一次输入：位权由位置决定 📝。');
    const exited = new Promise<void>(done => app!.process().once('exit', () => done()));
    await app.evaluate(({ app }) => app.quit());
    await exited;
    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.getByRole('textbox', { name: '编辑首段正文' }))
      .toHaveText('退出前最后一次输入：位权由位置决定 📝。');
    const after = await reopened.evaluate(() => (window as any).yizhi.open());
    expect(after.courseId).toBe(identity.courseId);
    expect(after.unit.id).toBe('KU-001');
    await reopened.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t01-electron.png', fullPage: true });
    await reopened.setViewportSize({ width: 660, height: 600 });
    await reopened.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t01-narrow.png' });
    expect(await reopened.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
  } finally { fault?.close(); await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('two actual IPC editors save both paragraphs, split once and recover an unfinished draft after abrupt host death', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-electron-t02-'));
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    app = await launch();
    let window = await app.firstWindow();
    const first = window.getByRole('textbox', { name: '编辑首段正文' });
    const second = window.getByRole('textbox', { name: '编辑第二段正文' });
    await first.fill('甲乙丙丁');
    await second.fill('多段输入不能只保存最后一段 📝');
    await expect(window.getByRole('status')).toHaveText('已保存');
    await window.getByRole('button', { name: '拆分首段为两段' }).click();
    await expect(first).toHaveText('甲乙');
    const committed = await window.evaluate(() => (window as any).yizhi.open());
    expect(committed.unit.reading.blocks.filter((b: any) => b.kind === 'paragraph').map((b: any) => b.payload.text))
      .toEqual(['甲乙', '丙丁', '多段输入不能只保存最后一段 📝']);
    // Persist incomplete input over actual preload IPC, then kill the host without its close barrier.
    await window.evaluate(async () => {
      const bridge = (window as any).yizhi;
      const course = await bridge.open();
      await bridge.saveDraft({ sessionId: course.sessionId, inputSeq: course.confirmedInputSeq + 1,
        baseRevision: course.revision, complete: false,
        changes: [{ blockId: course.editableBlockId, text: '未完成的输入 \\frac{' }] });
    });
    const proc = app.process();
    const died = new Promise<void>(done => proc.once('exit', () => done()));
    proc.kill('SIGKILL'); await died;
    app = await launch();
    window = await app.firstWindow();
    await expect(window.getByRole('textbox', { name: '编辑首段正文' })).toHaveText('未完成的输入 \\frac{');
    await expect(window.getByRole('status')).toHaveText('草稿已保留');
    await window.getByRole('textbox', { name: '编辑首段正文' }).fill('修正后继续保存');
    await expect(window.getByRole('status')).toHaveText('已保存');
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t02-electron.png', fullPage: true });
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});
