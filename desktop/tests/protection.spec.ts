import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import type { ElectronApplication } from '@playwright/test';

async function finish(app: ElectronApplication) {
  if (app.process().exitCode !== null || app.process().signalCode !== null) return;
  const page = app.windows()[0];
  if (page && await page.getByRole('status', { name: '保存状态' }).innerText({ timeout: 500 }).catch(() => '') === '未保存') {
    const exited = new Promise<void>(done => app.process().once('exit', () => done())); app.process().kill('SIGKILL'); await exited;
  } else await app.close();
}

test('actual cross-paragraph selection holds the shown basis while independent formal changes arrive and aligns only after leaving', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-protected-ui-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    const before = await page.evaluate(() => (window as any).yizhi.open());
    await editor.evaluate((el: any) => {
      let count = 0, end = 0;
      el.editor.state.doc.forEach((node: any, pos: number) => { if (node.type.name === 'paragraph' && ++count === 2) end = pos + 4; });
      el.editor.commands.setTextSelection({ from: 2, to: end });
      el.editor.view.focus();
    });
    const selected = await page.evaluate(() => getSelection()!.toString());
    const changed = await page.evaluate(async () => {
      const b = (window as any).yizhi, c = await b.open(), target = c.unit.reading.blocks[0];
      const a = await b.commands.startAttempt({ sessionId: c.sessionId, taskId: 'selection-update' });
      const basis = await b.commands.read({ sessionId: c.sessionId, attemptId: a.attemptId, objectIds: [target.id] });
      const object = basis.objects.find((o: any) => o.id === target.id);
      return b.commands.commit({ sessionId: c.sessionId, attemptId: a.attemptId, basisId: basis.basisId, operationId: 'selection-update',
        changes: [{ objectId: target.id, value: { ...object.value, payload: { ...target.payload, text: '外部已保存，选文仍显示原文' } } }] });
    });
    expect(changed.status).toBe('committed');
    await expect.poll(() => page.evaluate(() => (window as any).yizhi.open().then((c: any) => c.revision))).toBe(changed.revision);
    // Allow the actual event poll to consume the committed version, without disturbing native selection.
    await expect.poll(() => editor.evaluate((el: any) => el.editor.storage.courseSelection?.capture().latestFormalRevision)).toBe(changed.revision);
    expect(await page.evaluate(() => getSelection()!.toString())).toBe(selected);
    const capture = await editor.evaluate((el: any) => el.editor.storage.courseSelection.capture());
    expect(capture.formalRevision).toBe(before.revision);
    expect(capture.fragments.every((f: any) => f.formalRevision === before.revision)).toBe(true);
    expect(capture.fragments.map((f: any) => f.blockId)).toEqual(before.unit.reading.blocks.filter((b: any) => b.kind === 'paragraph').slice(0, 2).map((b: any) => b.id));
    expect(capture.fragments[0].projection.text).toBe(before.unit.reading.blocks[0].payload.text);
    expect(capture.fragments[0].quote.length).toBeGreaterThan(0);
    expect(capture.fragments[0].contentVersion).toBe(before.blockVersions[before.unit.reading.blocks[0].id]);
    await page.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect(editor.locator('p[data-block-id]').first()).toHaveText('外部已保存，选文仍显示原文');
  } finally { await finish(app); await rm(root, { recursive: true, force: true }); }
});

test('real persisted overlapping versions expose only the conflict and the student choice saves through host IPC without replacing the editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-conflict-ui-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(join(root, 'course')), a = c.unit.reading.blocks[0];
    const attempt = await service.commands.startAttempt({ sessionId: c.sessionId, taskId: 'conflict-ui' });
    const basis = await service.commands.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [a.id] });
    const value = basis.objects.find(o => o.id === a.id)!.value;
    await service.commands.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'conflict-ui',
      changes: [{ objectId: a.id, value: { ...value, payload: { ...a.payload, text: '外部的真实已保存版本' } } }] });
    await service.saveDraft({ sessionId: c.sessionId, inputSeq: 1, baseRevision: 1, complete: true, changes: [], patch: {
      updates: [{ blockId: a.id, before: a.payload, after: { ...a.payload, text: '学生的真实已保存草稿' } }], correspondence: [] } });
  } finally { await service.close(); }
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    const instance = await editor.evaluateHandle((el: any) => el.editor);
    const conflict = page.getByRole('region', { name: '学生草稿冲突', exact: true });
    await expect(conflict).toContainText('外部的真实已保存版本');
    await expect(conflict).toContainText('学生的真实已保存草稿');
    await page.setViewportSize({ width: 700, height: 700 });
    // Viewport emulation only; not physical input/device acceptance.
    const closeDirectory = page.getByRole('button', { name: '关闭目录', exact: true });
    await expect(closeDirectory).toBeVisible();
    await closeDirectory.click();
    await conflict.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t06-conflict-narrow.png' });
    await conflict.getByRole('button', { name: '冲突处保留学生草稿', exact: true }).click();
    await expect(editor.locator('p[data-block-id]').first()).toHaveText('学生的真实已保存草稿');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    expect(await editor.evaluate((el: any, old: any) => el.editor === old, instance)).toBe(true);
    expect((await page.evaluate(() => (window as any).yizhi.open())).drafts).toEqual([]);
    await instance.dispose();
  } finally { await finish(app); await rm(root, { recursive: true, force: true }); }
});

test('synthetic composition regression uses real IPC: independent range renders, common ancestor waits, and only student input enters student history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-composition-regression-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let closed = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(1); el.editor.view.focus(); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhong' })); });
    await editor.evaluate((el: any) => el.editor.storage.courseSelection.settle());
    await page.keyboard.insertText('中文候选');
    const native = await page.evaluate(() => ({ anchor: getSelection()!.anchorOffset, focus: getSelection()!.focusOffset, active: document.activeElement?.className }));
    const update = await page.evaluate(async () => {
      const api = (window as any).yizhi, c = await api.open(), target = c.unit.reading.blocks.filter((b: any) => b.kind === 'paragraph')[1];
      const attempt = await api.commands.startAttempt({ sessionId: c.sessionId, taskId: 'composition-independent' });
      const basis = await api.commands.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [target.id] });
      const value = basis.objects.find((o: any) => o.id === target.id).value;
      const independent = await api.commands.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId, operationId: 'composition-independent',
        changes: [{ objectId: target.id, value: { ...value, payload: { ...value.payload, text: '组合输入期间的独立更新' } } }] });
      const structure = 'structure:' + c.unit.id;
      const sharedBasis = await api.commands.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [structure] });
      const blockIds = [...sharedBasis.objects.find((o: any) => o.id === structure).value.blockIds];
      [blockIds[blockIds.length - 1], blockIds[blockIds.length - 2]] = [blockIds[blockIds.length - 2], blockIds[blockIds.length - 1]];
      const shared = await api.commands.commit({ sessionId: c.sessionId, attemptId: attempt.attemptId, basisId: sharedBasis.basisId, operationId: 'composition-shared',
        changes: [{ objectId: structure, value: { blockIds } }] });
      return { independent, shared, blockIds };
    });
    expect(update.independent.status).toBe('committed'); expect(update.shared.status).toBe('retained');
    await expect(page.getByRole('textbox', { name: '编辑第二段正文', exact: true })).toHaveText('组合输入期间的独立更新');
    expect(await page.evaluate(() => ({ anchor: getSelection()!.anchorOffset, focus: getSelection()!.focusOffset, active: document.activeElement?.className }))).toEqual(native);
    await editor.evaluate((el: any) => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文候选' })));
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await page.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => { const api = (window as any).yizhi, c = await api.open(); return c.unit.reading.blocks.map((b: any) => b.id); })).toEqual(update.blockIds);
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t06-composition-regression.png' });
    await app.close(); closed = true;
    const service = new CourseService(resolve('dist/worker.cjs'));
    try {
      const c = await service.open(join(root, 'course'));
      const history = await service.history(c.sessionId);
      expect(history).toHaveLength(1);
      expect((history[0].receipt as any).blockIds).toEqual([c.unit.reading.blocks[0].id]);
      expect((history[0].after as any).blocks.map((b: any) => b.id)).toEqual([c.unit.reading.blocks[0].id]);
      expect(c.unit.reading.blocks[0].payload.text).toMatch(/^中文候选/);
    } finally { await service.close(); }
  } catch (error) {
    if (!closed) { const exited = new Promise<void>(done => app.process().once('exit', () => done())); app.process().kill('SIGKILL'); await exited; closed = true; }
    throw error;
  } finally { if (!closed) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('caret pause and application blur retain the same paragraph, independent updates continue, leave integrates latest input and Undo preserves the external suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-caret-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    let editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    const first = page.getByRole('textbox', { name: '编辑首段正文', exact: true });
    const original = await page.evaluate(() => (window as any).yizhi.open());
    // A localized student insertion leaves the rest of this paragraph's history mappable.
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(1); el.editor.view.focus(); });
    await page.keyboard.insertText('学生前缀 ');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await editor.evaluate((el: any) => el.editor.storage.courseSelection.settle());
    const waiting = await page.evaluate(async () => {
      const b = (window as any).yizhi, c = await b.open(), target = c.unit.reading.blocks[0];
      const a = await b.commands.startAttempt({ sessionId: c.sessionId, taskId: 'caret-producer' });
      const basis = await b.commands.read({ sessionId: c.sessionId, attemptId: a.attemptId, objectIds: [target.id] });
      const object = basis.objects.find((o: any) => o.id === target.id);
      return b.commands.commit({ sessionId: c.sessionId, attemptId: a.attemptId, basisId: basis.basisId, operationId: 'caret-producer',
        changes: [{ objectId: target.id, value: { ...object.value, payload: { ...target.payload, text: target.payload.text + ' 外部后缀' } } }] });
    });
    expect(waiting.status).toBe('retained');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].blur());
    // Keep the real pause beyond ProseMirror's 500 ms typing-history grouping window.
    await page.waitForTimeout(600);
    const checks = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.commands.recheck({ sessionId: c.sessionId }); });
    expect(checks[0].status).toBe('waiting');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    // Type more after the external candidate was made. Releasing must integrate this tail too.
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(1); el.editor.view.focus(); });
    await page.keyboard.insertText('最新 ');
    await page.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect(first).toHaveText('最新 学生前缀 ' + original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const undo = page.getByRole('button', { name: '撤销正文', exact: true });
    await revealBoardControl(page, undo);
    await undo.click();
    await expect(first).toHaveText('学生前缀 ' + original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await undo.click();
    await expect(first).toHaveText(original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const saved = await page.evaluate(() => (window as any).yizhi.open());
    await app.close(); app = await launch(); page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await expect(editor.locator('p[data-block-id]').first()).toHaveText(original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(saved.unit);
  } finally { await finish(app); await rm(root, { recursive: true, force: true }); }
});
