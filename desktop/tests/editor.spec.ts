import { controlledElectron } from './controlled-launch';
import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import type { ElectronApplication } from '@playwright/test';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

async function finish(app: ElectronApplication) {
  if (app.process().exitCode !== null || app.process().signalCode !== null) return;
  const page = app.windows()[0];
  if (page && await page.getByRole('status', { name: '保存状态' }).innerText({ timeout: 500 }).catch(() => '') === '未保存') {
    const died = new Promise<void>(done => app.process().once('exit', () => done()));
    app.process().kill('SIGKILL'); await died;
  } else await app.close();
}

async function snapshotClipboard(app: ElectronApplication) {
  // macOS may expose one empty platform item after clear(), while ClipboardItem requires a MIME type.
  return app.evaluateHandle(async ({ clipboard, ClipboardItem }) => Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))));
}

test('independent producer range update survives student Undo and complete SQLite reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-editor-ranges-'));
  const launch = () => controlledElectron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const original = await page.evaluate(() => (window as any).yizhi.open());
    const first = page.getByRole('textbox', { name: '编辑首段正文', exact: true });
    await first.fill('学生在第一段的已保存输入');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const updated = await page.evaluate(async () => {
      const bridge = (window as any).yizhi, course = await bridge.open();
      const target = course.unit.reading.blocks.filter((b: any) => b.kind === 'paragraph')[1];
      const attempt = await window.yizhiControlled.startAttempt({ sessionId: course.sessionId, taskId: 'independent-editor-update' });
      const basis = await window.yizhiControlled.read({ sessionId: course.sessionId, attemptId: attempt.attemptId, objectIds: [target.id] });
      const object = basis.objects.find((o: any) => o.id === target.id)!;
      const result = await window.yizhiControlled.commit({ sessionId: course.sessionId, attemptId: attempt.attemptId, basisId: basis.basisId,
        operationId: 'independent-editor-update', changes: [{ objectId: target.id, value: { ...object.value, payload: { ...object.value.payload, text: '外部独立更新必须保留' } } }] });
      return { result, targetId: target.id };
    });
    expect(updated.result.status).toBe('committed');
    await expect(page.getByRole('textbox', { name: '编辑第二段正文', exact: true })).toHaveText('外部独立更新必须保留');
    await page.getByRole('button', { name: '撤销正文', exact: true }).click();
    await expect(first).toHaveText(original.unit.reading.blocks[0].payload.text);
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const expected = structuredClone(original.unit);
    expected.reading.blocks.find((b: any) => b.id === updated.targetId).payload.text = '外部独立更新必须保留';
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(expected);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await expect(page.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText(original.unit.reading.blocks[0].payload.text);
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(expected);
  } finally { await finish(app); await rm(root, { recursive: true, force: true }); }
});

test('copy assigns fresh identities recursively, an explicit internal move keeps identity, and outer formula Undo persists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-editor-identities-'));
  const service = new CourseService(resolve('dist/worker.cjs'));
  const unknown = { id: 'future-object', kind: 'future-lab', payload: { title: '未知对象完整保留', matrix: [[1, 2]], extension: { version: 7 } },
    children: [{ id: 'future-child', kind: 'unopened-solution', payload: { tokens: ['甲', { x: 2 }], latex: '\\frac{a}{b}' } }] };
  try {
    const c = await service.open(join(root, 'course'));
    const ids = c.unit.reading.blocks.map(b => b.id);
    await service.commitEdit({ sessionId: c.sessionId, inputSeq: 1, baseRevision: c.revision, operationId: 'seed-future', complete: true, changes: [],
      patch: { updates: [], structure: { parentId: c.unit.id, before: ids, after: [ids[0], unknown.id, ...ids.slice(1)], inserted: [unknown] }, correspondence: [] } });
  } finally { await service.close(); }
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let clipboard: Awaited<ReturnType<typeof snapshotClipboard>> | undefined;
  try {
    const page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('status', { name: '保存状态' }).waitFor();
    clipboard = await snapshotClipboard(app);
    await app.evaluate(({ clipboard }) => clipboard.clear());
    const emptyClipboard = await snapshotClipboard(app);
    expect(await emptyClipboard.evaluate(items => items.length)).toBe(0);
    await emptyClipboard.dispose();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const first = page.getByRole('textbox', { name: '编辑首段正文', exact: true });
    await first.fill('复制与移动');
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    // Select the real opaque object via the editor's public node-selection command, then native clipboard shortcuts.
    await editor.evaluate((el: any) => { el.editor.commands.setNodeSelection(el.editor.state.doc.firstChild.nodeSize); el.editor.view.focus(); });
    await page.keyboard.press('Meta+c');
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(el.editor.state.doc.firstChild.nodeSize - 1); el.editor.view.focus(); });
    await page.keyboard.press('Meta+v');
    await expect.poll(async () => {
      const c = await page.evaluate(() => (window as any).yizhi.open());
      return c.unit.reading.blocks.filter((b: any) => b.kind === 'future-lab').length;
    }).toBe(2);
    let saved = await page.evaluate(() => (window as any).yizhi.open());
    const copies = saved.unit.reading.blocks.filter((b: any) => b.kind === 'future-lab');
    expect(copies.find((b: any) => b.id === unknown.id)).toEqual(unknown);
    const copied = copies.find((b: any) => b.id !== unknown.id);
    expect(copied.payload).toEqual(unknown.payload);
    expect(copied.children[0].id).not.toBe(unknown.children[0].id);
    expect(copied.children[0].payload).toEqual(unknown.children[0].payload);
    const adjacent = saved.unit.reading.blocks[1];
    // Select first paragraph, move that actual object down, and save its identity/order.
    await revealBoardControl(page, first);
    await first.click();
    await revealBoardControl(page, page.getByRole('button', { name: '下移当前块', exact: true }));
    await page.getByRole('button', { name: '下移当前块', exact: true }).click();
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    saved = await page.evaluate(() => (window as any).yizhi.open());
    expect(saved.unit.reading.blocks[0]).toEqual(adjacent);
    expect(saved.unit.reading.blocks[1].payload.text).toBe('复制与移动');
    const movedId = saved.unit.reading.blocks[1].id;
    await page.getByRole('button', { name: '撤销正文', exact: true }).click();
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit.reading.blocks[0].id).toBe(movedId);
    await revealBoardControl(page, first);
    await first.click();
    const count = saved.unit.reading.blocks.filter((b: any) => b.kind === 'formula').length;
    await revealBoardControl(page, page.getByRole('button', { name: '插入公式', exact: true }));
    await page.getByRole('button', { name: '插入公式', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).yizhi.open())).unit.reading.blocks.filter((b: any) => b.kind === 'formula').length).toBe(count + 1);
    await page.getByRole('button', { name: '撤销正文', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).yizhi.open())).unit.reading.blocks.filter((b: any) => b.kind === 'formula').length).toBe(count);
    await page.getByRole('button', { name: '重做正文', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => (window as any).yizhi.open())).unit.reading.blocks.filter((b: any) => b.kind === 'formula').length).toBe(count + 1);
  } finally {
    try {
      if (clipboard) await app.evaluate(async ({ clipboard }, saved) => {
        if (saved.length) await clipboard.write(saved); else clipboard.clear();
      }, clipboard);
    } finally {
      await clipboard?.dispose();
      await finish(app); await rm(root, { recursive: true, force: true });
    }
  }
});

test('MathLive owns inner Undo once, incomplete input survives host death separately from the readable formal formula', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-formula-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await expect(page).toHaveURL(/^yizhi-app:\/\/app\//);
    const fontLoads = new Set<string>(), fontFailures: string[] = [];
    page.on('response', response => { if (response.url().includes('/mathlive-fonts/')) {
      if (response.ok()) fontLoads.add(response.url()); else fontFailures.push(response.url());
    } });
    page.on('requestfailed', request => { if (request.url().includes('/mathlive-fonts/')) fontFailures.push(request.url()); });
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await page.getByRole('textbox', { name: '编辑首段正文', exact: true }).fill('保留正文与公式的独立撤销。');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await revealBoardControl(page, page.locator('.editor-formula').first().getByRole('button', { name: '编辑公式', exact: true }));
    await page.locator('.editor-formula').first().getByRole('button', { name: '编辑公式', exact: true }).click();
    let field = page.locator('math-field').first();
    // MathLive intentionally reuses existing KaTeX font families. Also decode its bundled fallback
    // through the real registered origin, rather than assuming it always makes a second request.
    const fonts = await page.evaluate(async () => {
      const bundled = await new FontFace('T05MathLiveAsset', 'url(./mathlive-fonts/KaTeX_Main-Regular.woff2)').load();
      const main = await document.fonts.load('16px KaTeX_Main');
      const math = await document.fonts.load('italic 16px KaTeX_Math');
      return { bundled: bundled.status, main: main.map(f => f.status), math: math.map(f => f.status), failed: document.body.classList.contains('ML__fonts-did-not-load') };
    });
    expect(fonts.bundled).toBe('loaded');
    expect(fonts.main.length).toBeGreaterThan(0); expect(fonts.main.every(s => s === 'loaded')).toBe(true);
    expect(fonts.math.length).toBeGreaterThan(0); expect(fonts.math.every(s => s === 'loaded')).toBe(true);
    expect(fonts.failed).toBe(false);
    await expect.poll(() => fontLoads.size).toBeGreaterThan(0);
    expect(fontFailures).toEqual([]);
    await field.evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', 'x+1']); });
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await field.press('ArrowRight'); await field.press('+'); await field.press('2');
    await expect.poll(() => field.evaluate((el: any) => el.value)).toBe('x+1+2');
    await field.press('Meta+z');
    await expect.poll(() => field.evaluate((el: any) => el.value)).toBe('x+1+');
    await expect(page.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText('保留正文与公式的独立撤销。');
    await field.press('Meta+Shift+z');
    await expect.poll(() => field.evaluate((el: any) => el.value)).toBe('x+1+2');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const formal = await page.evaluate(() => (window as any).yizhi.open());
    const formula = formal.unit.reading.blocks.find((b: any) => b.kind === 'formula');
    expect(formula.payload.latex).toBe('x+1+2');
    // Use MathLive's actual structural insert API to leave an empty denominator.
    await field.evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', '\\frac{1}{#?}']); });
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('草稿已保留');
    const drafted = await page.evaluate(() => (window as any).yizhi.open());
    expect(drafted.unit).toEqual(formal.unit);
    expect(drafted.drafts[0].input.formulaDrafts[0].blockId).toBe(formula.id);
    const unfinished = drafted.drafts[0].input.formulaDrafts[0].latex;
    expect(unfinished).toContain('placeholder');
    const proc = app.process(); const died = new Promise<void>(done => proc.once('exit', () => done())); proc.kill('SIGKILL'); await died;
    app = await launch(); page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('草稿已保留');
    await revealBoardControl(page, page.locator('.editor-formula').first().getByRole('button', { name: '编辑公式', exact: true }));
    await page.locator('.editor-formula').first().getByRole('button', { name: '编辑公式', exact: true }).click();
    field = page.locator('math-field').first();
    await expect.poll(() => field.evaluate((el: any) => el.value)).toBe(unfinished);
    const restored = await page.evaluate(() => (window as any).yizhi.open());
    expect(restored.unit).toEqual(formal.unit);
    await field.evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', '\\frac{1}{2}']); });
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    const corrected = await page.evaluate(() => (window as any).yizhi.open());
    expect(corrected.drafts).toEqual([]);
    expect(corrected.unit.reading.blocks.find((b: any) => b.id === formula.id).payload.latex).toBe('\\frac{1}{2}');
    await field.evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', '\\frac{1}{#?}']); });
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('草稿已保留');
    await field.evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', '\\frac{1}{2}']); });
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    expect((await page.evaluate(() => (window as any).yizhi.open())).drafts).toEqual([]);
    // Select a real MathLive model fragment, not a LaTeX string offset, and replace only the numerator.
    await field.evaluate((el: any) => {
      for (let offset = 0; offset < el.lastOffset; offset++) if (el.getValue(offset, offset + 1, 'latex') === '1') {
        el.selection = { ranges: [[offset, offset + 1]], direction: 'forward' }; return;
      }
      throw new Error('Numerator fragment is missing');
    });
    await field.press('7');
    await expect.poll(() => field.evaluate((el: any) => el.value)).toBe('\\frac72');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await expect.poll(async () => (await page.evaluate(() => (window as any).yizhi.open())).unit.reading.blocks.find((b: any) => b.id === formula.id).payload.latex).toBe('\\frac72');
    await revealBoardControl(page, page.locator('.editor-formula').first().getByRole('button', { name: '返回正文', exact: true }));
    await page.locator('.editor-formula').first().getByRole('button', { name: '返回正文', exact: true }).click();
    const confirmed = await page.evaluate(() => (window as any).yizhi.open());
    await page.screenshot({ path: evidencePath('t05-editor.png') });
    await app.close(); app = await launch(); page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await expect(page.getByRole('textbox', { name: '编辑首段正文', exact: true })).toBeVisible();
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(confirmed.unit);
  } finally { await finish(app); await rm(root, { recursive: true, force: true }); }
});

test('continuous editor saves split/merge and cross-paragraph replacement through real IPC, then reopens the complete structure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-continuous-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await expect(editor).toBeVisible({ timeout: 3000 });
    const original = await page.evaluate(() => (window as any).yizhi.open());
    const first = page.getByRole('textbox', { name: '编辑首段正文', exact: true });
    await first.fill('甲乙丙丁');
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection(3); el.editor.view.focus(); });
    await page.keyboard.press('Enter');
    await expect(first).toHaveText('甲乙');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    let saved = await page.evaluate(() => (window as any).yizhi.open());
    expect(saved.unit.reading.blocks.slice(0, 2).map((b: any) => b.payload.text)).toEqual(['甲乙', '丙丁']);
    expect(saved.unit.reading.blocks[0].id).toBe(original.unit.reading.blocks[0].id);
    await page.keyboard.press('Backspace');
    await expect(first).toHaveText('甲乙丙丁');
    await page.keyboard.press('Meta+z');
    await expect(editor.locator('p[data-block-id]').nth(1)).toHaveText('丙丁');
    // The public selection command installs a real native range across both paragraphs.
    await editor.evaluate((el: any) => { el.editor.commands.setTextSelection({ from: 2, to: 6 }); el.editor.view.focus(); });
    expect(await page.evaluate(() => getSelection()!.toString().replace(/\n/g, ''))).toBe('乙丙');
    await page.keyboard.insertText('跨段');
    await expect(first).toHaveText('甲跨段丁');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    saved = await page.evaluate(() => (window as any).yizhi.open());
    expect(saved.unit.reading.blocks[0].payload.text).toBe('甲跨段丁');
    expect(saved.unit.reading.blocks.slice(1)).toEqual(original.unit.reading.blocks.slice(1));
    expect(new Set(saved.unit.reading.blocks.map((b: any) => b.id)).size).toBe(saved.unit.reading.blocks.length);
    const position = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.readingState(c.sessionId); });
    expect(position?.unitId).toBe('KU-001');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await resizeBoardWindow(app, page);
    const restoredPosition = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.readingState(c.sessionId); });
    expect(restoredPosition?.unitId).toBe(position.unitId);
    expect(restoredPosition?.camera?.zoom).toBeGreaterThanOrEqual(0.55);
    await expect(page.getByRole('textbox', { name: '编辑首段正文', exact: true })).toHaveText('甲跨段丁');
    const reopened = await page.evaluate(() => (window as any).yizhi.open());
    expect(reopened.unit).toEqual(saved.unit);
  } finally { await finish(app); await rm(root, { recursive: true, force: true }); }
});
