import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('offline real IPC search reveals a delivered deep answer and restores the original camera and disclosures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const first = page.getByRole('textbox', { name: '编辑首段正文' });
    await revealBoardControl(page, first); await first.click();
    await first.evaluate(el => { const range = document.createRange(); range.setStart(el.firstChild!, 0); range.setEnd(el.firstChild!, 3); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); });
    const selectedText = await page.evaluate(() => getSelection()!.toString());
    const before = await page.locator('.reading-layer[data-unit-id="KU-001"]').getAttribute('style');
    await page.context().setOffline(true);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('0.40625×16');
    const results = page.getByRole('region', { name: '搜索结果' });
    await expect(results.getByRole('button', { name: '定位命中' }).first()).toBeVisible();
    await results.getByRole('button', { name: '定位命中' }).first().click();
    await expect(page.locator('[data-search-current="true"]')).toContainText('0.40625×16');
    await expect(page.locator('[data-unit-id="KU-002"] details.answer')).toHaveAttribute('open', '');
    await page.getByRole('button', { name: '返回搜索前位置', exact: true }).click();
    await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toHaveAttribute('style', before!);
    await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe(selectedText);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('Nibble');
    await results.getByRole('button', { name: '定位命中' }).first().click();
    await expect(page.locator('[data-search-current="true"]')).toContainText('Nibble');
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t15-knowledge-hit.png' });
    await app.close(); app = await launch();
    const reopened = await app.firstWindow(); await resizeBoardWindow(app, reopened);
    await reopened.context().setOffline(true);
    await reopened.getByRole('button', { name: '搜索课程', exact: true }).click();
    await reopened.getByRole('searchbox').fill('Nibble');
    await reopened.getByRole('button', { name: '定位命中' }).first().click();
    await expect(reopened.locator('[data-search-current="true"]')).toContainText('Nibble');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('real saved note and durable message results open their own objects, preserve composer text and work at narrow width', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-personal-ui-'));
  // Seed actual records through the same public CourseService used by the host, never renderer-local search data.
  const { CourseService } = await import('../src/core/course-service');
  const core = new CourseService(resolve('dist/worker.cjs'));
  const c = await core.open(join(root, 'course')), b = c.unit.reading.blocks[0];
  const note = await core.annotations.create({ sessionId: c.sessionId, operationId: 'ui-note', text: '笔记定位独特词', selection: { unitId: c.unit.id, fragments: [{ blockId: b.id, block: b, field: 'text', formalRevision: 1, source: 'formal', projection: { version: 1, encoding: 'unicode-code-points', text: b.payload.text }, from: 0, to: 1, quote: Array.from(b.payload.text)[0] as string }] } });
  const conversation = await core.agent.create({ sessionId: c.sessionId, operationId: 'ui-conversation' });
  const task = await core.agent.submit({ sessionId: c.sessionId, conversationId: conversation.id, operationId: 'ui-question', generation: 1, text: '持久消息定位独特词', target: { unitId: c.unit.id } });
  await core.recordAgent({ sessionId: c.sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'actual-answer', kind: 'message', itemId: 'answer', text: '深层已保存回答的独特词' });
  await core.recordAgent({ sessionId: c.sessionId, taskId: task.id, attemptId: task.attemptId, generation: 1, eventId: 'actual-finish', kind: 'finish', status: 'completed' });
  await core.agent.saveDraft({ sessionId: c.sessionId, conversationId: conversation.id, seq: 1, text: '保留未发送草稿' });
  await core.close();
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('笔记定位独特词');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveValue(note.text);
    await expect(page.getByRole('textbox', { name: '批注内容' })).toHaveAttribute('data-search-current', 'true');
    await page.getByRole('button', { name: '返回搜索前位置' }).click();
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('深层已保存回答');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.locator('[data-search-current="true"]')).toHaveAttribute('data-message-id', `${task.id}:answer`);
    await expect(page.getByRole('textbox', { name: '学习对话草稿' })).toHaveValue('保留未发送草稿');
    await page.getByRole('button', { name: '返回搜索前位置' }).click();
    await resizeBoardWindow(app, page, 700, 700);
    await page.getByRole('button', { name: '关闭目录' }).click();
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '搜索课程', exact: true })).toBeVisible();
    await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
    await page.getByRole('searchbox').fill('不存在的真实查找词');
    await expect(page.getByRole('region', { name: '搜索结果' })).toContainText('无命中');
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t15-search-narrow.png' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '搜索课程', exact: true })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('source result opens the fixed original page without creating an annotation, then returns to the prior source page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-source-ui-'));
  const { sourceFixture } = await import('./source-fixture');
  const { CourseService } = await import('../src/core/course-service');
  const path = join(root, 'source.pdf'); await sourceFixture(path, 'Search original evidence unique phrase');
  const core = new CourseService(resolve('dist/worker.cjs')); const c = await core.open(join(root, 'course'));
  const version = (await core.sources.importFile({ sessionId: c.sessionId, generation: 1, operationId: 'ui-original', path, title: '固定版本测试资料' })).version;
  await core.sources.saveContext({ sessionId: c.sessionId, generation: 1, seq: 1, state: { open: false, versionId: version.versionId, pdfPageIndex: 1, scale: 1.4, scrollTop: 10, scrollLeft: 0 } });
  await core.close();
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.context().setOffline(true);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('original evidence');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.locator('.source-panel canvas')).toBeVisible();
    await expect(page.locator('.source-panel [data-search-current="true"]')).toContainText('original evidence');
    const facts = await page.evaluate(async () => { const c = await window.yizhi.open(); return { citations: await window.yizhi.sources.citations({ sessionId: c.sessionId }), context: await window.yizhi.sources.context({ sessionId: c.sessionId }) }; });
    expect(facts.citations).toEqual([]);
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t15-source-hit.png' });
    await page.getByRole('button', { name: '返回搜索前位置' }).click();
    await page.getByRole('button', { name: '原文资料', exact: true }).click();
    await expect(page.locator('.source-panel canvas')).toHaveAttribute('aria-label', '固定版本测试资料 · PDF 第 2 页');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a changed or unreadable result is rejected, and exact original repair restores searchable source pages', async () => {
  const { sourceFixture } = await import('./source-fixture');
  const { CourseService } = await import('../src/core/course-service');
  const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-search-repair-ui-')), path = join(root, 'original.pdf');
  await sourceFixture(path, 'Literal damaged original evidence');
  const core = new CourseService(resolve('dist/worker.cjs')), c = await core.open(join(root, 'course'));
  const version = (await core.sources.importFile({ sessionId: c.sessionId, operationId: 'repair-source-ui', generation: 1, path, title: '待修复资料' })).version;
  await core.close();
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('damaged original');
    await expect(page.getByRole('button', { name: '定位命中' })).toBeVisible();
    await writeFile(join(root, 'course/resources', version.sha256), 'damaged bytes');
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.getByRole('alert')).toContainText('损坏');
    await page.getByText('未覆盖与不可读内容', { exact: true }).click();
    await expect(page.getByRole('button', { name: '从原件修复此版本' })).toBeVisible();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    await page.getByRole('button', { name: '从原件修复此版本' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: '定位命中' }).click();
    await expect(page.locator('.source-panel [data-search-current="true"]')).toContainText('damaged original');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
