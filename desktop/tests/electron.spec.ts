import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

async function reveal(window: Page, target: Locator) {
  await expect(window.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  const board = (await window.locator('main.board').boundingBox())!;
  await window.mouse.move(board.x + 10, board.y + board.height / 2);
  for (let i = 0; i < 60; i++) {
    const box = (await target.boundingBox())!;
    const delta = box.y - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 3) return;
    await window.mouse.wheel(0, Math.max(-500, Math.min(500, delta)));
    await window.waitForTimeout(30);
  }
  throw new Error('无法通过画板平移找到阅读位置');
}
import { spawn } from 'node:child_process';

test('controlled producer uses real IPC: stale premise is retained, reread integrates, stop keeps the receipt and rejects late writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-electron-t03-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
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
    await window.screenshot({ path: evidencePath('t03-desktop.png'), fullPage: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 600));
    await window.screenshot({ path: evidencePath('t03-narrow.png'), fullPage: true });
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
    await expect(window.getByRole('status', { name: '保存状态' })).toContainText('未保存');
    await expect(editor).toHaveText('保存失败后保留这段输入，重试仍是它。');
    // A failed save must also prevent a normal close, retaining the live editor.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect(window.getByRole('status', { name: '保存状态' })).toContainText('未保存');
    expect(window.isClosed()).toBe(false);
    await window.screenshot({ path: evidencePath('t01-error.png') });
    fault.exec('DROP TRIGGER reject_write');
    await window.getByRole('button', { name: '重试保存' }).click();
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
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
    await reopened.screenshot({ path: evidencePath('t01-electron.png'), fullPage: true });
    await reopened.setViewportSize({ width: 660, height: 600 });
    await reopened.screenshot({ path: evidencePath('t01-narrow.png') });
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
    await window.screenshot({ path: evidencePath('t04-overview.png') });
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(window.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    await expect(window.getByRole('textbox', { name: '编辑首段正文' })).toBeVisible();
    await window.screenshot({ path: evidencePath('t04-reading.png') });
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
    await reveal(window, window.getByRole('button', { name: /前往.*KU-002/, includeHidden: true }));
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
    await reveal(window, window.getByRole('checkbox', { name: 'S0', includeHidden: true }));
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
    await reveal(window, window.getByRole('button', { name: /前往.*KU-002/, includeHidden: true }));
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
    await window.screenshot({ path: evidencePath('t04-narrow.png') });
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
    const matrix = () => window.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
    const vertical = await matrix();
    await window.keyboard.down('Shift'); await window.mouse.wheel(0, 180); await window.keyboard.up('Shift');
    await expect.poll(async () => (await matrix()).x).not.toBe(vertical.x);
    const afterPan = await matrix();
    expect(Math.abs(afterPan.y - vertical.y)).toBeLessThan(2);
    const pointer = { x: bounds.width - 30, y: 150 };
    const world = { x: (pointer.x - afterPan.x) / afterPan.zoom, y: (pointer.y - afterPan.y) / afterPan.zoom };
    await window.keyboard.down('Meta'); await window.mouse.wheel(0, -100); await window.keyboard.up('Meta');
    await expect.poll(async () => (await matrix()).zoom).toBeGreaterThan(afterPan.zoom);
    const zoomed = await matrix();
    expect(Math.abs((pointer.x - zoomed.x) / zoomed.zoom - world.x)).toBeLessThan(2);
    expect(Math.abs((pointer.y - zoomed.y) / zoomed.zoom - world.y)).toBeLessThan(2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('wheel over reading text moves the board', async () => {
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

test('the local device source opens and returns focus to its reading context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-source-return-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '复用器与分配器', exact: true }).click();
    await window.getByRole('navigation', { name: '课程目录' }).getByRole('button', { name: 'MUX 器件、级联与扩展' }).click();
    const source = window.getByRole('button', { name: '查看 TI 74153 原页', includeHidden: true });
    await reveal(window, source); await source.click();
    await expect(window.getByRole('dialog', { name: 'TI 74153 原页' })).toBeVisible();
    await window.getByRole('button', { name: '返回正文' }).click();
    await expect(source).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('zoomed-out graph does not expose invisible unit nodes to keyboard focus', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-focus-depth-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    const node = window.locator('[data-id="KU-001"]');
    await expect(node).not.toHaveAttribute('tabindex', '0');
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(node).toHaveAttribute('tabindex', '0');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('offscreen reading controls are excluded from keyboard navigation until in view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-reading-focus-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const summary = window.getByText('练习 · 二进制小数与十六进制权展开自测');
    const boundary = summary.locator('xpath=ancestor::*[@data-reading-block][1]');
    await expect(boundary).toHaveAttribute('inert', '');
    await reveal(window, summary);
    await expect(boundary).not.toHaveAttribute('inert', '');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('selection and hand tools offer distinct canvas drag modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-selection-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const select = window.getByRole('button', { name: '选择工具' });
    const hand = window.getByRole('button', { name: '手形工具' });
    const board = (await window.locator('main.board').boundingBox())!;
    const transform = () => window.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform);
    await select.click(); await expect(select).toHaveAttribute('aria-pressed', 'true');
    // Keep the full two-dimensional selection gesture on empty pane, clear of edges that can auto-pan.
    const origin = await window.evaluate(({ x, y, width, height }) => {
      const clear = (px: number, py: number) => document.elementFromPoint(px, py)?.classList.contains('react-flow__pane');
      for (let py = y + 80; py < y + height - 120; py += 24)
        for (let px = x + 80; px < x + width - 140; px += 24)
          if (Array.from({ length: 13 }, (_, step) => step).every(step => clear(px + step * 5, py + step * 40 / 12))) return { x: px, y: py };
      throw new Error(`No clear interior 60x40 pane path: ${JSON.stringify({ x, y, width, height })}`);
    }, board);
    const drag = async () => { await window.mouse.move(origin.x, origin.y); await window.mouse.down(); await window.mouse.move(origin.x + 60, origin.y + 40, { steps: 4 }); await window.mouse.up(); };
    const before = await transform(); await drag(); expect(await transform()).toBe(before);
    await hand.click(); await expect(hand).toHaveAttribute('aria-pressed', 'true');
    await drag(); await expect.poll(transform).not.toBe(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a rejected reading position stays visible and can be retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-reading-fault-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let fault: DatabaseSync | undefined;
  try {
    const window = await app.firstWindow();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    await expect(window.getByRole('button', { name: '数制与数制转换', exact: true }).first()).toBeVisible();
    fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    fault.exec("CREATE TRIGGER reject_reading BEFORE INSERT ON reading_state BEGIN SELECT RAISE(ABORT, 'reading storage unavailable'); END");
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(window.getByRole('status', { name: '阅读状态' })).toContainText('未保存');
    fault.exec('DROP TRIGGER reject_reading');
    await window.getByRole('button', { name: '重试保存阅读位置' }).click();
    await expect(window.getByRole('status', { name: '阅读状态' })).toContainText('已保存');
  } finally { fault?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('wheel inside the relationships panel scrolls it without panning the canvas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-panel-scroll-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '查看关系' }).click();
    const panel = window.getByLabel('关系详情');
    const transform = () => window.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform);
    const before = await transform(); await panel.hover(); await window.mouse.wheel(0, 300);
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await transform()).toBe(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('camera can step from reading through unit overview to theme overview in one board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-depths-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(window.getByRole('heading', { name: '位置记数法与权展开' })).toBeVisible();
    const board = (await window.locator('main.board').boundingBox())!;
    await window.mouse.move(board.x + board.width - 30, board.y + 150);
    await window.keyboard.down('Meta');
    for (let i = 0; i < 3; i++) await window.mouse.wheel(0, 180);
    await window.keyboard.up('Meta');
    await expect(window.getByRole('heading', { name: '位置记数法与权展开' })).toBeHidden();
    await expect(window.locator('[data-id="KU-002"]')).toHaveCSS('opacity', '1');
    await window.getByRole('button', { name: '全图' }).click();
    await expect(window.locator('[data-id="KU-002"]')).toHaveCSS('opacity', '0');
    await expect(window.locator('[data-id="TH-01"]')).toHaveCSS('opacity', '1');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('narrow controlled producer overlay returns focus and isolates the board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-producer-overlay-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow(); await window.setViewportSize({ width: 700, height: 600 });
    await window.getByRole('button', { name: '关闭目录' }).click();
    const entry = window.getByText('可控生产者 · 验证入口', { exact: true }); await entry.click();
    await expect(window.locator('main.board')).toHaveAttribute('inert', '');
    await window.keyboard.press('Escape'); await expect(entry).toBeFocused();
    await expect(window.locator('main.board')).not.toHaveAttribute('inert', '');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('two actual IPC editors save both paragraphs, split once and recover an unfinished draft after abrupt host death', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-electron-t02-'));
  let app: ElectronApplication | undefined;
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    app = await launch();
    let window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const first = window.getByRole('textbox', { name: '编辑首段正文' });
    const second = window.getByRole('textbox', { name: '编辑第二段正文' });
    await first.fill('甲乙丙丁');
    await reveal(window, window.getByRole('textbox', { name: '编辑第二段正文', includeHidden: true }));
    await second.fill('多段输入不能只保存最后一段 📝');
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await reveal(window, window.getByRole('button', { name: '拆分首段为两段', includeHidden: true }));
    await window.getByRole('button', { name: '拆分首段为两段' }).click();
    await expect(first).toHaveText('甲乙');
    // The continuous editor responds immediately; formal structure is checked after its actual autosave receipt.
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
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
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('草稿已保留');
    // Draft text mounts before the local restored projection is ready for real input.
    await expect(window.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await window.getByRole('textbox', { name: '编辑首段正文' }).fill('修正后继续保存');
    await expect(window.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await window.screenshot({ path: evidencePath('t02-electron.png'), fullPage: true });
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('moving among sample units keeps only the active reading and the pinned editor mounted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-bounded-reading-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const window = await app.firstWindow();
    const nav = window.getByRole('navigation', { name: '课程目录' });
    await nav.getByRole('button', { name: '数制与数制转换', exact: true }).click();
    for (const name of ['非十进制与十进制互转', '二进制、八进制与十六进制互转', '位、字节与存储容量单位']) {
      await nav.getByRole('button', { name, exact: true }).click();
      await expect(window.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await window.locator('.reading-layer').count()).toBeLessThanOrEqual(2);
    }
    await nav.getByRole('button', { name: '位置记数法与权展开', exact: true }).click();
    await expect(window.getByRole('textbox', { name: '编辑首段正文' })).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
