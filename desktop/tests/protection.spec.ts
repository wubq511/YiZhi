import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';

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
    expect(capture.fragments.map((f: any) => f.blockId)).toEqual(before.unit.reading.blocks.filter((b: any) => b.kind === 'paragraph').slice(0, 2).map((b: any) => b.id));
    expect(capture.fragments[0].projection.text).toBe(before.unit.reading.blocks[0].payload.text);
    expect(capture.fragments[0].quote.length).toBeGreaterThan(0);
    expect(capture.fragments[0].contentVersion).toBe(before.blockVersions[before.unit.reading.blocks[0].id]);
    await page.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect(editor.locator('p[data-block-id]').first()).toHaveText('外部已保存，选文仍显示原文');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
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
  } finally { if (!closed) await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('caret pause and application blur retain the same paragraph, independent updates continue, leave integrates latest input and Undo preserves the external suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-caret-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
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
    const checks = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.commands.recheck({ sessionId: c.sessionId }); });
    expect(checks[0].status).toBe('waiting');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    // Type more after the external candidate was made. Releasing must integrate this tail too.
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(1); el.editor.view.focus(); });
    await page.keyboard.insertText('最新 ');
    await page.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect(first).toHaveText('最新 学生前缀 ' + original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await page.getByRole('button', { name: '撤销正文', exact: true }).click();
    await expect(first).toHaveText(original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const saved = await page.evaluate(() => (window as any).yizhi.open());
    await app.close(); app = await launch(); page = await app.firstWindow();
    editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await expect(editor.locator('p[data-block-id]').first()).toHaveText(original.unit.reading.blocks[0].payload.text + ' 外部后缀');
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(saved.unit);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
