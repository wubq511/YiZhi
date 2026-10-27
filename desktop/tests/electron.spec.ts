import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';

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
