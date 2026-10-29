import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { ParagraphSaveChannel } from '../src/renderer/save-channel';
import { navigateUnit } from './acceptance-study';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('visible body and unfinished formula drafts survive navigation and reopen after an independent formal update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-visible-draft-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  const text = '学生中文标点。english 与纠错后的正文';
  const latex = '\\frac{1}{\\placeholder{}}x';
  let channel: ParagraphSaveChannel | undefined;
  try {
    const course = await service.open(join(root, 'course'));
    const [first, independent] = course.unit.reading.blocks.filter(b => b.kind === 'paragraph');
    const formula = course.unit.reading.blocks.find(b => b.kind === 'formula')!;
    channel = new ParagraphSaveChannel(service, course, () => {}, { pollMs: 0 });
    channel.useContentPatches();
    channel.edit({ changes: [], patch: { updates: [{ blockId: first.id, before: first.payload,
      after: { ...first.payload, text } }], correspondence: [] }, formulaDrafts: [{ blockId: formula.id, latex }] });
    expect(await channel.flush()).toBe(true);
    const attempt = await service.commands.startAttempt({ sessionId: course.sessionId, taskId: 'visible-draft-independent-update' });
    const basis = await service.commands.read({ sessionId: course.sessionId, attemptId: attempt.attemptId, objectIds: [independent.id] });
    const block = basis.objects.find(o => o.id === independent.id)!.value;
    expect((await service.commands.commit({ sessionId: course.sessionId, attemptId: attempt.attemptId,
      basisId: basis.basisId, operationId: 'visible-draft-independent-update',
      changes: [{ objectId: independent.id, value: { ...block, payload: { ...block.payload, text: '独立正式更新仍然存在' } } }] })).status).toBe('committed');
    await service.commands.stop({ sessionId: course.sessionId, attemptId: attempt.attemptId });
  } finally { channel?.dispose(); await service.close(); }

  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-cli') } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resizeBoardWindow(app, page);
    const inspect = async () => {
      const article = page.locator('article[data-unit-id="KU-001"][data-reading-active="true"]');
      await expect(article.locator('.tiptap p[data-block-id]').first()).toHaveText(text);
      const snapshot = await page.evaluate(async () => { const api = (window as any).yizhi, c = await api.open(); return api.read(c.sessionId, 'KU-001'); });
      expect(snapshot.drafts[0].input.baseRevision).toBeLessThan(snapshot.revision);
      expect(snapshot.drafts[0].input.patch.updates[0].after.text).toBe(text);
      expect(snapshot.unit.reading.blocks[0].payload.text).not.toBe(text);
      await expect(article).toContainText('独立正式更新仍然存在');
      await expect(article).toContainText('未完成公式 · 草稿已保留，正式公式保持原值');
      const edit = article.locator('.editor-formula').first().getByRole('button', { name: '编辑公式', exact: true });
      await revealBoardControl(page, edit); await edit.click();
      await expect.poll(() => article.locator('math-field').first().evaluate((field: any) => field.value)).toBe(latex);
      const leave = article.locator('.editor-formula').first().getByRole('button', { name: '返回正文', exact: true });
      await revealBoardControl(page, leave); await leave.click();
    };
    let opened = await page.evaluate(() => (window as any).yizhi.open());
    let graph = await page.evaluate(id => (window as any).yizhi.graph(id), opened.sessionId);
    await navigateUnit(page, graph, 'KU-001'); await inspect();
    await navigateUnit(page, graph, 'KU-002'); await navigateUnit(page, graph, 'KU-001'); await inspect();
    await app.close(); app = await launch(); page = await app.firstWindow(); await resizeBoardWindow(app, page);
    opened = await page.evaluate(() => (window as any).yizhi.open());
    graph = await page.evaluate(id => (window as any).yizhi.graph(id), opened.sessionId);
    await navigateUnit(page, graph, 'KU-001'); await inspect();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
