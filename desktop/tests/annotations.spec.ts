import { controlledElectron } from './controlled-launch';
import type { DatabaseSync } from 'node:sqlite';
import { openFaultDatabase } from './fault-database';
import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { resizeBoardWindow } from './board-test-helpers';

test('actual displayed Unicode selection creates one note; note Undo/autosave/reopen leaves the continuous editor intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-note-ui-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try { const c = await service.open(join(root, 'course')); await service.commitEdit({ sessionId: c.sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'note-fixture', complete: true,
    changes: c.unit.reading.blocks.filter(b => b.kind === 'paragraph').slice(0, 2).map(b => ({ blockId: b.id, text: '中文𠮷重复重复句' })) }); } finally { await service.close(); }
  let app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    const instance = await editor.evaluateHandle((el: any) => el.editor);
    await editor.evaluate((el: any) => { let end = 0, n = 0; el.editor.state.doc.forEach((node: any, pos: number) => { if (node.type.name === 'paragraph' && ++n === 2) end = pos + 5; }); el.editor.commands.setTextSelection({ from: 2, to: end }); el.editor.view.focus(); });
    await page.getByRole('button', { name: '批注所选文字', exact: true }).click();
    const note = page.getByRole('textbox', { name: '批注内容', exact: true });
    await note.fill('第一版理解');
    await page.getByRole('button', { name: '关闭批注', exact: true }).click();
    await expect(page.getByRole('region', { name: '个人批注', exact: true })).toBeHidden();
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.annotations.list({ sessionId: c.sessionId }))[0]?.text; })).toBe('第一版理解');
    await page.getByRole('button', { name: '个人批注', exact: true }).click();
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    await note.fill('第二版理解');
    await note.press('Meta+z');
    await expect(note).toHaveValue('第一版理解');
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.annotations.list({ sessionId: c.sessionId }))[0]?.text; })).toBe('第一版理解');
    expect(await editor.evaluate((el: any, original: any) => el.editor === original, instance)).toBe(true);
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(el.editor.state.doc.firstChild.nodeSize - 1); el.editor.view.focus(); });
    await page.keyboard.insertText('尾');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.annotations.list({ sessionId: c.sessionId }))[0]?.current.status; })).toBe('attached');
    const snapshot = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return { c, notes: await b.annotations.list({ sessionId: c.sessionId }) }; });
    expect(snapshot.notes).toHaveLength(1); expect(snapshot.notes[0].original.fragments).toHaveLength(2);
    expect(snapshot.notes[0].original.fragments[0].quote).toBe('文𠮷重复重复句');
    expect(snapshot.c.unit.reading.blocks[0].payload.text).toBe('中文𠮷重复重复句尾');
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(5); el.editor.view.focus(); });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.annotations.list({ sessionId: c.sessionId }))[0]?.current.fragments.length; })).toBe(3);
    await page.keyboard.press('Meta+z');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.annotations.list({ sessionId: c.sessionId }))[0]?.current.status; })).toBe('attached');
    await page.getByRole('button', { name: '定位当前选段', exact: true }).click();
    await expect.poll(async () => (await editor.locator('.annotation-highlight').allTextContents()).join('')).toBe('文𠮷重复重复句中文𠮷');
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    await page.screenshot({ path: evidencePath('t07-notes-desktop.png') });
    await app.close();
    app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
    page = await app.firstWindow(); await page.getByRole('button', { name: '个人批注', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '批注内容', exact: true })).toHaveValue('第一版理解');
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('real MathLive nested selection uses a lazy reading field, proven independent edit, rewrite orphan, Undo and fresh copy identity', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-formula-note-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  try {
    const c = await service.open(join(root, 'course')), f = c.unit.reading.blocks.find(b => b.kind === 'formula')!, first = c.unit.reading.blocks[0], ids = c.unit.reading.blocks.map(b => b.id);
    await service.commitEdit({ sessionId: c.sessionId, operationId: 'formula-note-fixture', inputSeq: 1, baseRevision: c.revision, changes: [], complete: true, patch: {
      updates: [{ blockId: f.id, before: f.payload, after: { ...f.payload, latex: '\\frac{x+x}{y}' } }, { blockId: first.id, before: first.payload, after: { ...first.payload, text: '公式批注保留原来的结构语境。' } }],
      structure: { parentId: c.unit.id, before: ids, after: [first.id, f.id, ...ids.filter(id => id !== first.id && id !== f.id)], inserted: [] }, correspondence: [{ kind: 'move', sourceId: f.id, targetId: f.id }] } });
  } finally { await service.close(); }
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  let page = await app.firstWindow();
  try {
    // Use a real Electron window at the compact macOS CI size.
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(page.locator('math-field')).toHaveCount(0);
    const formula = page.locator('.editor-formula').first();
    await formula.getByRole('button', { name: '选择公式片段', exact: true }).click();
    let field = formula.locator('math-field');
    expect(await field.evaluate((el: any) => el.readOnly)).toBe(true);
    const range = await field.evaluate((el: any) => { const xs: number[] = []; for (let i = 0; i < el.lastOffset; i++) if (el.getValue([i, i + 1]) === 'x') xs.push(i); if (xs.length !== 2) throw new Error('Expected actual repeated numerator'); el.selection = { ranges: [[xs[1], xs[1] + 1]] }; return [xs[1], xs[1] + 1]; });
    await formula.getByRole('button', { name: '批注公式选段', exact: true }).click();
    await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('分子里的第二个 x');
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    const getNotes = () => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.annotations.list({ sessionId: c.sessionId }); });
    const original = (await getNotes())[0];
    expect(original.original.fragments[0].projection.encoding).toBe('mathlive-model');
    expect([original.original.fragments[0].from, original.original.fragments[0].to]).toEqual(range);
    expect(original.original.fragments[0].projection.cells.some((c: any) => c.depth > 0)).toBe(true);
    await formula.getByRole('button', { name: '返回正文', exact: true }).click();
    await expect(page.locator('math-field')).toHaveCount(0);
    await page.getByRole('button', { name: '关闭批注', exact: true }).click();
    await formula.getByRole('button', { name: '编辑公式', exact: true }).click();
    field = formula.locator('math-field'); const stable = await field.elementHandle();
    await field.evaluate((el: any) => { for (let a = 0; a < el.lastOffset; a++) for (let b = a + 1; b <= el.lastOffset; b++) if (el.getValue([a, a + 1]) && el.getValue([b - 1, b]) && el.getValue([a, b]) === 'x+x') { el.selection = { ranges: [[a, b]] }; return; } throw new Error('No nested numerator'); });
    await formula.getByRole('button', { name: '批注公式选段', exact: true }).click();
    await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('分子整体的子表达式');
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    expect(await getNotes()).toHaveLength(2);
    expect((await getNotes())[1].original.fragments[0].quote).toBe('x+x');
    await page.getByRole('button', { name: '关闭批注', exact: true }).click();

    await field.evaluate((el: any) => {
      const events: unknown[] = [];
      const record = (event: any) => {
        events.push({ type: event.type, key: event.key, inputType: event.inputType, data: event.data,
          value: el.getValue(), selection: el.selection, focused: el.hasFocus(), active: document.activeElement?.tagName });
        if (events.length > 24) events.shift();
      };
      const types = ['focus', 'blur', 'keydown', 'beforeinput', 'input'];
      for (const type of types) el.addEventListener(type, record, true);
      (window as any).__yizhiFormulaNoteEvidence = { events, stop() { for (const type of types) el.removeEventListener(type, record, true); } };
    });
    await field.focus();
    await expect.poll(() => field.evaluate((el: any) => el.hasFocus())).toBe(true);
    await field.evaluate((el: any) => { for (let i = 0; i < el.lastOffset; i++) if (el.getValue([i, i + 1]) === 'y') { el.selection = { ranges: [[i, i + 1]] }; return; } throw new Error('No denominator'); });
    await field.press('z');
    // Prove the intended native edit before using its value as the persistence oracle.
    const changedFormula = '\\frac{x+x}{z}';
    await expect.poll(() => field.evaluate((el: any) => el.getValue())).toBe(changedFormula);
    await expect.poll(() => page.evaluate(async () => (await (window as any).yizhi.open()).unit.reading.blocks.find((b: any) => b.kind === 'formula').payload.latex)).toBe(changedFormula);
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(async () => (await getNotes())[0].current.status).toBe('attached');
    expect(await field.evaluate((el: any, original: any) => el === original, stable)).toBe(true);
    const beforeRewrite = await field.evaluate((el: any) => el.getValue());
    // Real navigation ends MathLive's current typing group before the next structural edit.
    await field.press('ArrowLeft');
    await expect.poll(() => field.evaluate((el: any) => el.hasFocus())).toBe(true);
    await field.evaluate((el: any) => { for (let a = 0; a < el.lastOffset; a++) for (let b = a + 1; b <= el.lastOffset; b++) if (el.getValue([a, a + 1]) && el.getValue([b - 1, b]) && el.getValue([a, b]) === 'x+x') { el.selection = { ranges: [[a, b]] }; return; } throw new Error('No exact actual numerator range'); });
    await field.press('2'); await field.press('x');
    await expect.poll(() => field.evaluate((el: any) => el.getValue())).toBe('\\frac{2x}{z}');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(async () => (await getNotes())[0].current.status).toBe('orphan');
    expect((await getNotes())[0].original).toEqual(original.original);
    expect((await getNotes()).every((n: any) => n.current.status === 'orphan')).toBe(true);
    await page.getByRole('button', { name: '个人批注', exact: true }).click();
    await expect(page.getByRole('region', { name: '个人批注', exact: true })).toContainText('待重新关联');
    await page.screenshot({ path: evidencePath('t07-formula-orphan.png') });
    await page.getByRole('button', { name: '关闭批注', exact: true }).click();
    await field.press('Meta+z');
    if (await field.evaluate((el: any) => el.getValue()) !== beforeRewrite) {
      expect((await getNotes())[0].current.status).toBe('orphan');
      await field.press('Meta+z');
    }
    await expect.poll(() => field.evaluate((el: any) => el.getValue())).toBe(beforeRewrite);
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(async () => (await getNotes())[0].current.status).toBe('attached');
    // Duplicate insertion runs through the actual installed ProseMirror identity plugin.
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    const copied = await editor.evaluate((el: any) => { const e = el.editor; let source: any, end = e.state.doc.content.size; e.state.doc.forEach((n: any) => { if (!source && n.type.name === 'formula') source = n.toJSON(); }); e.commands.insertContentAt(end, source); return source.attrs.block.id; });
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const formal = await page.evaluate(() => (window as any).yizhi.open());
    const duplicates = formal.unit.reading.blocks.filter((b: any) => b.kind === 'formula' && b.payload.latex === beforeRewrite);
    expect(duplicates).toHaveLength(2); expect(new Set(duplicates.map((b: any) => b.id)).size).toBe(2);
    expect((await getNotes())[0].current.fragments.every((f: any) => f.blockId === copied)).toBe(true);
    // A retained formula selection must not override a later actual text selection.
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection({ from: 2, to: 6 }); el.editor.view.focus(); });
    const annotateText = page.getByRole('button', { name: '批注所选文字', exact: true });
    const board = (await page.locator('main.board').boundingBox())!, button = (await annotateText.boundingBox())!;
    // Bring the toolbar back into the canvas without changing the held text selection.
    await page.mouse.move(board.x + 8, board.y + board.height / 2);
    await page.mouse.wheel(0, button.y + button.height / 2 - board.y - board.height / 2);
    await expect(annotateText).toBeInViewport({ ratio: 0.99 });
    await annotateText.click();
    await expect.poll(async () => (await getNotes()).length).toBe(3);
    expect((await getNotes())[2].original.fragments[0].field).toBe('text');
    expect((await getNotes())[2].original.fragments[0].quote).toBe('式批注保');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole('button', { name: '个人批注', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '批注内容', exact: true })).toHaveValue('分子里的第二个 x');
    expect((await getNotes())[0].id).toBe(original.id); expect((await getNotes())[0].original).toEqual(original.original);
  } catch (error) {
    if (!page.isClosed()) {
      const observed = await page.evaluate(async () => {
        const api = window.yizhi, course = await api.open(), field = document.querySelector('math-field') as any;
        return { events: (window as any).__yizhiFormulaNoteEvidence?.events ?? [],
          current: field ? { value: field.getValue(), selection: field.selection, focused: field.hasFocus() } : null,
          active: document.activeElement?.tagName, visibility: document.visibilityState,
          formal: { revision: course.revision, formulas: course.unit.reading.blocks.filter(b => b.kind === 'formula').map(b => ({ id: b.id, latex: b.payload.latex })) },
          notes: (await api.annotations.list({ sessionId: course.sessionId })).map(n => ({ id: n.id, status: n.current.status })) };
      }).catch(captureError => ({ captureError: String(captureError) }));
      await writeFile(testInfo.outputPath('formula-selection-failure.json'), JSON.stringify(observed, null, 2)).catch(() => {});
      await page.screenshot({ path: testInfo.outputPath('formula-selection-failure.png') }).catch(() => {});
    }
    throw error;
  } finally {
    if (!page.isClosed()) await page.evaluate(() => { (window as any).__yizhiFormulaNoteEvidence?.stop(); delete (window as any).__yizhiFormulaNoteEvidence; }).catch(() => {});
    await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('held displayed selection creates an old-version orphan and explicit reassociation keeps its immutable original context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-held-note-'));
  const app = await controlledElectron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection({ from: 2, to: 7 }); el.editor.view.focus(); });
    const captured = await editor.evaluate((el: any) => el.editor.storage.courseSelection.capture());
    const result = await page.evaluate(async () => {
      const b = (window as any).yizhi, c = await b.open(), target = c.unit.reading.blocks[0];
      const attempt = await window.yizhiControlled.startAttempt({ sessionId: c.sessionId, taskId: 'held-note-producer' });
      const basis = await window.yizhiControlled.read({ sessionId: c.sessionId, attemptId: attempt.attemptId, objectIds: [target.id] });
      const object = basis.objects.find((o: any) => o.id === target.id)!;
      return window.yizhiControlled.commit({ sessionId: c.sessionId, operationId: 'held-note-rewrite', attemptId: attempt.attemptId, basisId: basis.basisId,
        changes: [{ objectId: target.id, value: { ...object.value, payload: { ...target.payload, text: '外部已改写当前原文' } } }] });
    });
    await expect.poll(() => editor.evaluate((el: any) => el.editor.storage.courseSelection.capture().latestFormalRevision)).toBe(result.revision!);
    await page.getByRole('button', { name: '批注所选文字', exact: true }).click();
    await expect(page.getByRole('region', { name: '个人批注', exact: true })).toContainText('待重新关联');
    const getNotes = () => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.annotations.list({ sessionId: c.sessionId }); });
    const note = (await getNotes())[0];
    expect(note.original.fragments).toEqual(captured.fragments);
    expect(note.original.fragments[0].formalRevision).toBeLessThan(result.revision!);
    await editor.evaluate((el: any) => { let n = 0; el.editor.state.doc.forEach((node: any, pos: number) => { if (node.type.name === 'paragraph' && ++n === 2) el.editor.commands.setTextSelection({ from: pos + 1, to: pos + 5 }); }); el.editor.view.focus(); });
    await page.getByRole('button', { name: '关联到当前选段', exact: true }).click();
    await expect.poll(async () => (await getNotes())[0].current.status).toBe('attached');
    const rebound = (await getNotes())[0];
    expect(rebound.id).toBe(note.id); expect(rebound.original).toEqual(note.original); expect(rebound.current.fragments[0].blockId).not.toBe(note.original.fragments[0].blockId);
    await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('重新关联后还可继续记录');
    await expect.poll(async () => (await getNotes())[0].text).toBe('重新关联后还可继续记录');
    await page.setViewportSize({ width: 700, height: 700 });
    await expect(page.getByRole('dialog', { name: '个人批注', exact: true })).toBeVisible();
    expect(await page.locator('main.board').evaluate((el: HTMLElement) => el.inert)).toBe(true);
    await page.screenshot({ path: evidencePath('t07-notes-narrow.png') });
    await page.getByRole('button', { name: '关闭批注', exact: true }).click();
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('actual note autosave failure retains newer input and retries the original operation before confirming the latest text', async () => {

  const root = await mkdtemp(join(tmpdir(), 'yizhi-note-failure-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let fault: DatabaseSync | undefined;
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection({ from: 2, to: 5 }); el.editor.view.focus(); });
    await page.getByRole('button', { name: '批注所选文字', exact: true }).click();
    const text = page.getByRole('textbox', { name: '批注内容', exact: true });
    await text.fill('已经保存的笔记');
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    const before = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return { c, notes: await b.annotations.list({ sessionId: c.sessionId }) }; });
    fault = openFaultDatabase(join(root, 'course', 'course.sqlite'));
    fault.exec("CREATE TRIGGER fail_note_ui BEFORE INSERT ON annotation_operations BEGIN SELECT RAISE(ABORT, 'note disk failure'); END");
    await text.fill('保存失败时的第一笔');
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('未保存');
    await text.fill('失败之后仍然继续写下的新笔记');
    const failed = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.annotations.list({ sessionId: c.sessionId }); });
    expect(failed).toEqual(before.notes);
    fault.exec('DROP TRIGGER fail_note_ui');
    await page.getByRole('button', { name: '重试保存批注', exact: true }).click();
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    const after = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return { c, notes: await b.annotations.list({ sessionId: c.sessionId }) }; });
    expect(after.notes).toHaveLength(1); expect(after.notes[0].text).toBe('失败之后仍然继续写下的新笔记');
    expect(after.notes[0].original).toEqual(before.notes[0].original); expect(after.c.unit).toEqual(before.c.unit);
  } finally { try { fault?.exec('DROP TRIGGER IF EXISTS fail_note_ui'); } finally { fault?.close(); } await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
