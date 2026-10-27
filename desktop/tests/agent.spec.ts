import { DatabaseSync } from 'node:sqlite';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { sourceFixture } from './source-fixture';

async function openAgent(page: Page) {
  await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toBeVisible();
}
const fixture = resolve('dist/tests/agent-executor-fixture.cjs');
test('Agent sidebar keeps drafts, native composer Undo, fixed source selection and conversations through close/reopen without moving camera', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-ui-')); await chmod(fixture, 0o755);
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture } });
  let app: ElectronApplication | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return (await b.readingState(c.sessionId))?.camera?.zoom; })).toBe(0.85);
    const original = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return { body: c.unit, state: await b.readingState(c.sessionId) }; });
    await page.getByRole('textbox', { name: '编辑首段正文' }).evaluate(element => { const range = document.createRange(); const node = element.firstChild!; const at = node.textContent!.indexOf('位置记数法'); range.setStart(node, at); range.setEnd(node, at + 5); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await openAgent(page);
    await expect(page.locator('.agent-attachment')).toContainText('位置记数法');
    const composer = page.getByRole('textbox', { name: '学习对话草稿' });
    await expect(page.getByText('本机 Codex CLI · 已连接', { exact: true })).toBeVisible();
    await composer.fill('解释位权');
    await composer.press('End'); await composer.press('!'); await composer.press('Meta+z');
    await expect(composer).toHaveValue('解释位权');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' })).toHaveText('回答已完成');
    await expect(page.locator('.agent-message.assistant')).toHaveCount(1);
    await expect(page.locator('.agent-message.assistant')).toContainText('补充解释');
    await page.getByRole('button', { name: '非十进制与十进制互转', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return (await b.readingState(c.sessionId))?.camera?.x; })).not.toBe(original.state.camera.x);
    original.state = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return b.readingState(c.sessionId); });
    const submitted = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); const l = await b.agent.list({ sessionId: c.sessionId }); return (await b.agent.get({ sessionId: c.sessionId, conversationId: l.selectedId })).tasks[0].snapshot; });
    expect(submitted.target.unitId).toBe('KU-001'); expect(submitted.target.selectedText).toBe('位置记数法');
    await composer.fill('保留第一段草稿');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await composer.fill('第二段草稿');
    await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    const choices = await page.locator('[aria-label="学习对话列表"] option').evaluateAll(options => options.map(o => ({ id: (o as HTMLOptionElement).value, text: o.textContent })));
    const first = choices.find(o => o.text === '解释位权')!;
    await page.getByLabel('学习对话列表').selectOption(first.id);
    await expect(composer).toHaveValue('保留第一段草稿');
    await expect(page.locator('.agent-message.assistant')).toHaveCount(1);
    const after = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return { body: c.unit, state: await b.readingState(c.sessionId) }; });
    expect(after).toEqual(original);
    await page.getByRole('button', { name: '收起对话', exact: true }).click();
    // Actual PDF selection -> T14 cite -> fixed question request, no renderer-invented quote.
    const pdf = join(root, 'evidence.pdf'); await sourceFixture(pdf, 'Source selection fixed evidence');
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, pdf);
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.locator('.source-pdf canvas')).toBeVisible();
    await expect(page.locator('.textLayer')).toContainText('Source selection fixed evidence');
    await page.locator('.textLayer span').first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await page.getByRole('button', { name: '带此选段向 Agent 提问', exact: true }).click();
    await expect(page.locator('.agent-attachment')).toContainText('Source selection fixed evidence');
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await composer.fill('解释这段来源');
    const other = choices.find(o => o.id !== first.id)!;
    await page.getByLabel('学习对话列表').selectOption(other.id); await expect(composer).toHaveValue('第二段草稿');
    await page.getByLabel('学习对话列表').selectOption(first.id); await expect(composer).toHaveValue('解释这段来源');
    await expect(page.locator('.agent-attachment')).toContainText('Source selection fixed evidence');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' })).toHaveCount(2);
    await expect(page.getByRole('status', { name: '回答状态' }).last()).toHaveText('回答已完成');
    await expect(page.getByLabel('固定课程出处').last()).toContainText('Source selection fixed evidence');
    await composer.fill('重开后接着问'); await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await openAgent(page); await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toHaveValue('重开后接着问');
    await expect(page.getByLabel('固定课程出处').last()).toContainText('Source selection fixed evidence');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(660, 600));
    await expect(page.getByRole('dialog', { name: 'Agent 学习对话' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toBeFocused();
    if (process.env.YIZHI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.YIZHI_EVIDENCE_DIR, 't16-agent-narrow.png') });
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('missing executor retains offline reading; failed composer save blocks close and preserves the exact draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-offline-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'absent') } });
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click(); await openAgent(page);
    await expect(page.getByText(/生成暂不可用/)).toBeVisible(); await expect(page.getByRole('button', { name: '发送问题' })).toBeDisabled();
    await page.getByRole('textbox', { name: '学习对话草稿' }).fill('离线留下问题'); await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    const fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    try {
      fault.exec("CREATE TRIGGER fail_composer BEFORE UPDATE OF draft ON agent_conversations BEGIN SELECT RAISE(ABORT,'composer disk fault'); END");
      await page.getByRole('textbox', { name: '学习对话草稿' }).fill('未保存尾部必须保留');
      await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿未保存');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await expect(page.getByRole('alert')).toContainText('composer disk fault');
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
      await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toHaveValue('未保存尾部必须保留');
      fault.exec('DROP TRIGGER fail_composer');
      await page.getByRole('button', { name: '重试保存对话草稿', exact: true }).click();
      await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    } finally { fault.exec('DROP TRIGGER IF EXISTS fail_composer'); fault.close(); }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('actual installed executor answers a small cited question through the Electron product and reopens the conversation', async () => {
  test.skip(process.env.YIZHI_REAL_EXECUTOR !== '1', 'Opt-in actual local executor acceptance, never replaced with fixture'); test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-actual-'));
  const env: Record<string, string> = { ...process.env, PATH: '/usr/bin:/bin', YIZHI_DATA_HOME: join(root, 'profile') } as Record<string, string>; delete env.YIZHI_CODEX_PATH;
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env });
  let app: ElectronApplication | undefined;
  const evidence: any = { runtime: null, executor: null, tasks: [], assertions: [] };
  try {
    app = await launch(); let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const original = await page.evaluate(async () => (window as any).yizhi.open()); evidence.runtime = original.runtime;
    const pdf = join(root, 'evidence.pdf'); await sourceFixture(pdf, 'Place value depends on position.');
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, pdf);
    await page.getByRole('button', { name: '原文资料', exact: true }).click(); await page.getByRole('button', { name: '导入资料', exact: true }).click();
    await expect(page.locator('.textLayer')).toContainText('Place value depends on position.');
    await page.locator('.textLayer span').first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    await page.getByRole('button', { name: '带此选段向 Agent 提问' }).click();
    await expect(page.locator('.agent-attachment')).toContainText('Place value depends on position.');
    await page.getByRole('button', { name: '返回画板', exact: true }).click();
    evidence.executor = await page.evaluate(() => (window as any).yizhi.agent.status());
    expect(evidence.executor.available, evidence.executor.error).toBe(true);
    await page.getByLabel('问答模型').selectOption({ label: evidence.executor.models.find((m: any) => m.model === 'gpt-6-luna').displayName });
    const composer = page.getByRole('textbox', { name: '学习对话草稿' });
    await composer.fill('请调用 yizhi_read_target 和 yizhi_read_citation，准确引用附带英文原文，再用两句中文解释位权。分别标出课程依据与补充解释。只读，不修改画板。');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' })).toHaveText('回答已完成', { timeout: 90_000 });
    const answer = page.locator('.agent-message.assistant .agent-prose').last();
    await expect(answer).toContainText('课程依据'); await expect(answer).toContainText('补充解释'); await expect(answer).toContainText('Place value depends on position.');
    await expect(page.getByLabel('固定课程出处').last()).toContainText('PDF 第 1 页');
    await composer.fill('真实问答后的草稿'); await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    const saved = await page.evaluate(async () => { const api = (window as any).yizhi.agent; const c = await (window as any).yizhi.open(); const l = await api.list({ sessionId: c.sessionId }); return api.get({ sessionId: c.sessionId, conversationId: l.selectedId }); });
    evidence.toolFacts = saved.toolFacts;
    expect(saved.toolFacts.map((f: any) => f.name)).toEqual(expect.arrayContaining(['yizhi_read_target', 'yizhi_read_citation']));
    expect(saved.toolFacts.every((f: any) => f.hasRecoveryPayload === false)).toBe(true);
    evidence.tasks = saved.tasks; evidence.answer = await answer.textContent(); evidence.assertions.push('actual model completed, cited exact original, course/extra separated, draft saved');
    await page.screenshot({ path: join(process.env.YIZHI_EVIDENCE_DIR ?? root, 't16-actual-electron.png') });
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(original.unit);
    await app.close(); app = await launch(); page = await app.firstWindow(); await openAgent(page);
    await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toHaveValue('真实问答后的草稿');
    await expect(page.locator('.agent-message.assistant .agent-prose').last()).toHaveText(evidence.answer);
    await expect(page.getByLabel('固定课程出处').last()).toContainText('Place value depends on position.');
    evidence.assertions.push('actual app quit/reopen retained answer, immutable citation and composer; board unchanged; reduced Finder PATH passed');
    // A new ephemeral thread continues the Core-visible conversation without a permanent hidden tool-read transcript.
    await page.getByLabel('问答模型').selectOption('gpt-6-luna');
    await page.getByRole('textbox', { name: '学习对话草稿' }).fill('接着刚才的问题，请调用课程目标工具，并准确重复上一条回答引用的英文原句，再用一句中文说明十进制 22 中左边的 2 表示什么。保持课程依据与补充解释分开。');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' }).last()).toHaveText('回答已完成', { timeout: 90_000 });
    await expect(page.getByRole('status', { name: '回答状态' })).toHaveCount(2);
    await expect(page.getByRole('status', { name: '回答状态' }).last()).toHaveText('回答已完成', { timeout: 90_000 });
    const continued = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); const l = await b.agent.list({ sessionId: c.sessionId }); return b.agent.get({ sessionId: c.sessionId, conversationId: l.selectedId }); });
    expect(continued.tasks[1].threadId).not.toBe(saved.tasks[0].threadId);
    await expect(page.locator('.agent-message.assistant .agent-prose').last()).toContainText('Place value depends on position.');
    await expect(page.locator('.agent-message.assistant .agent-prose').last()).toContainText(/20|二十|两个十/);
    expect(continued.tasks[1].turnId).not.toBe(saved.tasks[0].turnId);
    evidence.continuedTask = continued.tasks[1]; evidence.assertions.push('reopened product continued from Core-visible history in a new ephemeral CLI thread, repeated the prior exact quote and completed a new turn');
    evidence.passed = true;
  } catch (error) { evidence.error = String(error); throw error; }
  finally {
    if (process.env.YIZHI_EVIDENCE_DIR) await writeFile(join(process.env.YIZHI_EVIDENCE_DIR, 't16-actual-executor.json'), JSON.stringify(evidence, null, 2));
    await app?.close(); await rm(root, { recursive: true, force: true });
  }
});

test('closing only the learning window keeps the host-owned answer running and the new window rejoins it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-agent-window-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_FIXTURE_MODE: 'linger' } });
  try {
    let page = await app.firstWindow(); await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click(); await openAgent(page);
    await expect(page.getByText('本机 Codex CLI · 已连接', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '学习对话草稿' }).fill('关窗后继续回答'); await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' })).toHaveText('正在回答');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    const next = app.waitForEvent('window'); await app.evaluate(({ app }) => app.emit('activate')); page = await next;
    await openAgent(page); await expect(page.getByRole('status', { name: '回答状态' })).toHaveText('回答已完成', { timeout: 10_000 });
    await expect(page.locator('.agent-message.assistant')).toHaveCount(1);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
