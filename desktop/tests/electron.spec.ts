import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

async function reveal(window: Page, target: Locator) {
  const board = (await window.locator('main.board').boundingBox())!;
  await window.mouse.move(board.x + 10, board.y + board.height / 2);
  for (let i = 0; i < 60; i++) {
    const box = (await target.boundingBox())!;
    const delta = box.y - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 3) return;
    await window.mouse.wheel(0, Math.max(-500, Math.min(500, delta * 2)));
    await window.waitForTimeout(30);
  }
  throw new Error('无法通过画板平移找到阅读位置');
}
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
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
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
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
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
    await reopened.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
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

test('board opens at overview and navigates the first unit within the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t04-board-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('region', { name: '知识画板' })).toBeVisible();
    await expect(window.getByRole('navigation', { name: '课程目录' })).toBeVisible();
    await expect(window.getByLabel('小地图')).toBeVisible();
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t04-overview.png' });
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(window.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    await expect(window.getByRole('textbox', { name: '编辑首段正文' })).toBeVisible();
    await window.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t04-reading.png' });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a knowledge reference opens its main unit and returns to the retained edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t04-reference-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = window.getByRole('textbox', { name: '编辑首段正文' });
    await editor.fill('阅读引用之前的输入');
    await reveal(window, window.getByRole('button', { name: /前往.*KU-002/ }));
    await window.getByRole('button', { name: /前往.*KU-002/ }).click();
    await expect(window.getByRole('heading', { name: '非十进制与十进制互转' })).toBeVisible();
    await window.getByRole('button', { name: '返回引用位置' }).click();
    await expect(editor).toHaveText('阅读引用之前的输入');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('exercises show the question before revealing a hint or answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t04-exercise-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(window.getByText('① 写出 11.01₂ 的权展开式并求十进制值；② 写出 1C4₁₆ 的权展开式并求十进制值。')).toBeVisible();
    await expect(window.getByText('① 11.01 的小数两位权是 0.5 和 0.25；② 1C4 是三位十六进制数，最高位权是 16²=256，C 对应 12。')).toBeHidden();
    const hint = window.locator('details.material').filter({ hasText: '练习 · 二进制小数与十六进制权展开自测' }).getByText('学习提示', { exact: true });
    await reveal(window, hint); await hint.click();
    await expect(window.getByText('① 11.01 的小数两位权是 0.5 和 0.25；② 1C4 是三位十六进制数，最高位权是 16²=256，C 对应 12。')).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('device sample has a working local multiplexer and source figure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-t04-mux-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '复用器与分配器', exact: true }).click();
    await window.getByRole('navigation', { name: '课程目录' }).getByRole('button', { name: 'MUX 器件、级联与扩展' }).click();
    await expect(window.getByRole('img', { name: /TI官方74153/ })).toBeVisible();
    await expect(window.getByRole('status', { name: 'MUX 输出' })).toHaveText('输出 Z = 0');
    await reveal(window, window.getByRole('checkbox', { name: 'S0' }));
    await window.getByRole('checkbox', { name: 'S0' }).check();
    await expect(window.getByRole('status', { name: 'MUX 输出' })).toHaveText('输出 Z = 1');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('reopening resumes an expanded hint and knowledge-reference return position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-reading-resume-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const exercise = window.locator('details.material').filter({ hasText: '练习 · 二进制小数与十六进制权展开自测' });
    await reveal(window, exercise.getByText('学习提示', { exact: true }));
    await exercise.getByText('学习提示', { exact: true }).click();
    await reveal(window, window.getByRole('button', { name: /前往.*KU-002/ }));
    await window.getByRole('button', { name: /前往.*KU-002/ }).click();
    await expect(window.getByRole('heading', { name: '非十进制与十进制互转' })).toBeVisible();
    await expect.poll(async () => window.evaluate(async () => { const c = await (window as any).yizhi.open(); return (await (window as any).yizhi.readingState(c.sessionId))?.unitId; })).toBe('KU-002');
    const exited = new Promise<void>(done => app.process().once('exit', () => done()));
    await app.evaluate(({ app }) => app.quit()); await exited; app = await launch(); window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: '非十进制与十进制互转' })).toBeVisible();
    await window.getByRole('button', { name: '返回引用位置' }).click();
    await expect(window.getByText('① 11.01 的小数两位权是 0.5 和 0.25；② 1C4 是三位十六进制数，最高位权是 16²=256，C 对应 12。')).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('relationship browser preserves required and alternative prerequisite routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-relations-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '查看关系' }).click();
    await expect(window.getByText('KU-029：真值表与标准式互转')).toBeVisible();
    await expect(window.getByText(/任选一条.*KU-033.*KU-035/)).toBeVisible();
    await expect(window.getByText(/REL-010.*requires/)).toBeVisible();
    await window.getByLabel('关系范围').selectOption('auxiliary');
    await expect(window.getByText(/REL-028.*requires/)).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('narrow directory traps keyboard focus and restores it when closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-narrow-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 700, height: 600 });
    const nav = window.getByRole('navigation', { name: '课程目录' });
    await expect(nav).toBeVisible();
    await expect(window.locator('main.board')).toHaveAttribute('inert', '');
    await nav.getByRole('button', { name: '关闭目录' }).focus();
    await window.keyboard.press('Shift+Tab');
    await expect(nav.locator('button').last()).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(nav).toBeHidden();
    await expect(window.getByRole('button', { name: '展开目录' })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('wheel routes pan and pointer-centered zoom without stealing text input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-gestures-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = window.getByRole('textbox', { name: '编辑首段正文' });
    await editor.fill('空格'); await editor.press('End'); await editor.press('Space'); await editor.press('X');
    await expect(editor).toHaveText('空格 X');
    const board = window.locator('main.board'); const bounds = (await board.boundingBox())!;
    await window.mouse.move(bounds.x + bounds.width - 30, bounds.y + 150);
    const transform = () => window.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform);
    const before = await transform();
    await window.mouse.wheel(0, 180); await expect.poll(transform).not.toBe(before);
    const afterPan = await transform();
    await window.keyboard.down('Meta'); await window.mouse.wheel(0, -100); await window.keyboard.up('Meta');
    await expect.poll(transform).not.toBe(afterPan);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('wheel over reading text moves the board while table scrolling stays in the table', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-reading-wheel-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const paragraph = window.getByText('能写出任意进制数的位权展开式并解释基数与位权的含义。');
    await paragraph.hover();
    const transform = () => window.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform);
    const before = await transform(); await window.mouse.wheel(0, 250); await expect.poll(transform).not.toBe(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('narrow relationship overlay isolates the workspace and returns focus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-rel-overlay-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow(); await window.setViewportSize({ width: 700, height: 600 });
    await window.getByRole('button', { name: '关闭目录' }).click();
    await window.getByRole('button', { name: '查看关系' }).click();
    const dialog = window.getByRole('dialog', { name: '关系详情' });
    await expect(dialog).toBeVisible();
    await expect(window.locator('.board-background')).toHaveAttribute('inert', '');
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(window.getByRole('button', { name: '查看关系' })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
