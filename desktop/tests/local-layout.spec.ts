import { DatabaseSync } from 'node:sqlite';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';

async function reveal(page: Page, target: Locator) {
  const board = (await page.locator('main.board').boundingBox())!;
  await page.mouse.move(board.x + 10, board.y + board.height / 2);
  for (let i = 0; i < 60; i++) {
    const box = (await target.boundingBox())!;
    const delta = box.y - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 3) return;
    await page.mouse.wheel(0, Math.max(-500, Math.min(500, delta * 2)));
    await page.waitForTimeout(30);
  }
  throw new Error('没有找到阅读位置');
}


test('manual width and drag remain after collapse and reopen without replacing the active editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-layout-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  let completed = false;
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const editor = page.getByRole('textbox', { name: '编辑首段正文' });
    await expect(editor).toBeVisible();
    await editor.fill('局部布局保持这个编辑实例与输入');
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await editor.evaluate(el => { (window as any).savedEditor = el.closest('.tiptap'); });
    const width = page.getByRole('slider', { name: '调整位置记数法与权展开宽度' });
    await width.focus(); await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.locator('.reading-layer').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(552);
    await page.getByRole('textbox', { name: '连续编辑正文', exact: true }).evaluate((el: any) => { el.editor.commands.setTextSelection({ from: 1, to: 2 }); el.editor.view.focus(); });
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('局');
    const selection = await page.evaluate(() => getSelection()?.toString());
    const move = page.getByRole('button', { name: '移动位置记数法与权展开' });
    const bounds = (await move.boundingBox())!;
    await page.mouse.move(bounds.x + 30, bounds.y + 12); await page.mouse.down();
    await page.mouse.move(bounds.x + 110, bounds.y + 52, { steps: 6 });
    const duringDrag = (await page.locator('.reading-layer').first().boundingBox())!;
    const growth = await page.evaluate(async () => {
      const b = (window as any).yizhi, c = await b.open();
      const target = c.unit.reading.blocks.filter((block: any) => block.kind === 'paragraph')[1].id;
      const a = await b.commands.startAttempt({ sessionId: c.sessionId, taskId: 'growth-during-drag' });
      const basis = await b.commands.read({ sessionId: c.sessionId, attemptId: a.attemptId, objectIds: [target] });
      const original = basis.objects[0].value;
      return b.commands.commit({ sessionId: c.sessionId, attemptId: a.attemptId, operationId: 'growth-during-drag', basisId: basis.basisId,
        changes: [{ objectId: target, value: { ...original, payload: { ...original.payload, text: '拖动中的后台正文持续增高。'.repeat(40) } } }] });
    });
    expect(growth.status).toBe('committed');
    await expect(page.getByRole('textbox', { name: '编辑第二段正文', includeHidden: true })).toHaveText('拖动中的后台正文持续增高。'.repeat(40));
    const afterGrowth = (await page.locator('.reading-layer').first().boundingBox())!;
    expect(afterGrowth.x).toBeCloseTo(duringDrag.x, 1); expect(afterGrowth.y).toBeCloseTo(duringDrag.y, 1);
    await page.mouse.up();
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局已保存');
    const saved = await page.evaluate(async () => { const bridge = (window as any).yizhi; const c = await bridge.open(); return (await bridge.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-001'); });
    expect(saved.width).toBe(674); expect(saved.x).toBeGreaterThan(180);
    expect(await editor.evaluate(el => el.closest('.tiptap') === (window as any).savedEditor)).toBe(true);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe(selection);
    await expect(editor).toHaveText('局部布局保持这个编辑实例与输入');
    const material = page.locator('details.material').filter({ hasText: '练习 · 二进制小数与十六进制权展开自测' });
    await reveal(page, material.locator('summary').first());
    await material.locator('summary').first().click();
    await expect(material).not.toHaveAttribute('open');
    await expect(page.getByRole('status', { name: '阅读状态' })).toHaveText('阅读位置已保存');
    expect(await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return (await b.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-001'); })).toEqual(saved);
    await expect(page.getByRole('status', { name: '保存状态' })).toHaveText('已保存');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('textbox', { name: '编辑首段正文' })).toHaveText('局部布局保持这个编辑实例与输入');
    const reopened = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return (await b.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-001'); });
    expect(reopened).toEqual(saved); completed = true;
  } finally {
    if (!completed) { const died = new Promise<void>(done => app.process().once('exit', () => done())); app.process().kill('SIGKILL'); await died; }
    else await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('actual producer follows only actual changes, student takeover cancels motion until explicit return, completion never jumps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-follow-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
    await page.getByRole('button', { name: '读取当前依据', exact: true }).click();
    await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('正在跟随可控修改');
    const matrix = () => page.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
    const initial = await matrix();
    await page.getByRole('textbox', { name: '可控候选内容' }).fill('实际增长的正文。'.repeat(80));
    await page.getByRole('button', { name: '提交可控修改', exact: true }).click();
    await expect(page.getByRole('status', { name: '可控生产者状态' })).toContainText('正式修改已保存');
    await expect.poll(async () => (await matrix()).y).not.toBe(initial.y);
    expect((await matrix()).zoom).toBe(initial.zoom);
    // A real wheel event takes control while the authored follow can still have queued frames.
    const board = (await page.locator('main.board').boundingBox())!;
    await page.mouse.move(board.x + 50, board.y + 160); await page.mouse.wheel(0, -220);
    await expect(page.getByRole('button', { name: '返回并继续跟随', exact: true })).toBeVisible();
    const taken = await matrix();
    await page.evaluate(() => new Promise<void>(done => { let frames = 0; const next = () => { if (++frames === 4) done(); else requestAnimationFrame(next); }; requestAnimationFrame(next); }));
    expect(await matrix()).toEqual(taken);
    await page.getByRole('button', { name: '重读并整合', exact: true }).click();
    await page.getByRole('textbox', { name: '可控候选内容' }).fill('后一个真实修改也不能抢回视野。'.repeat(110));
    await page.getByRole('button', { name: '提交可控修改', exact: true }).click();
    await expect(page.getByRole('status', { name: '可控生产者状态' })).toContainText('正式修改已保存');
    await expect.poll(matrix).toEqual(taken);
    await page.getByRole('button', { name: '返回并继续跟随', exact: true }).click();
    await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('正在跟随可控修改');
    await expect.poll(async () => (await matrix()).y).not.toBe(taken.y);
    await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
    await page.getByRole('button', { name: '全图', exact: true }).click();
    await expect(page.getByRole('button', { name: '返回并继续跟随', exact: true })).toBeVisible();
    await expect.poll(async () => (await matrix()).zoom).toBeLessThan(.35);
    const beforeEnd = await matrix();
    await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
    await page.getByRole('button', { name: '结束可控修改', exact: true }).click();
    await expect(page.getByRole('button', { name: '查看修改结果', exact: true })).toBeVisible();
    expect(await matrix()).toEqual(beforeEnd);
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    expect(await matrix()).toEqual(beforeEnd);
    await expect(page.getByRole('button', { name: '返回并继续跟随', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('可控修改已结束');
    await expect(page.getByRole('button', { name: '查看修改结果', exact: true })).toBeVisible();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('growth displaces the local chain while the current reading anchor and student pan compose at unchanged zoom', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-anchor-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(page.getByRole('textbox', { name: '编辑首段正文' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: '课程目录' });
    await nav.getByRole('button', { name: '非十进制与十进制互转', exact: true }).click();
    const heading = page.getByRole('heading', { name: '非十进制与十进制互转', exact: true });
    await expect(heading).toBeVisible();
    const width = page.getByRole('slider', { name: '调整非十进制与十进制互转宽度' });
    await width.focus(); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局已保存');
    const baseline = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-002'); });
    expect(baseline.y).toBe(168); expect(baseline.width).toBe(674);
    const before = (await heading.boundingBox())!;
    const matrix = () => page.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
    const viewport = await matrix();
    // Actual IPC commit; reconnect/alignment alone does not claim a new user modification request.
    await page.evaluate(async () => {
      const b = (window as any).yizhi, c = await b.open();
      const target = c.editableBlockId;
      const a = await b.commands.startAttempt({ sessionId: c.sessionId, taskId: 'anchor-growth' });
      const basis = await b.commands.read({ sessionId: c.sessionId, attemptId: a.attemptId, objectIds: [target] });
      const original = basis.objects[0].value;
      await b.commands.commit({ sessionId: c.sessionId, attemptId: a.attemptId, operationId: 'anchor-growth', basisId: basis.basisId,
        changes: [{ objectId: target, value: { ...original, payload: { ...original.payload, text: '正文增长引起实际局部让位。'.repeat(180) } } }] });
    });
    const board = (await page.locator('main.board').boundingBox())!;
    await page.evaluate(() => addEventListener('wheel', event => { (window as any).observedPan = event.deltaY; }, { once: true, capture: true }));
    await page.mouse.move(board.x + 10, board.y + 180); await page.mouse.wheel(0, 100);
    const actualPan = await page.evaluate(() => (window as any).observedPan as number);
    await expect.poll(async () => (await matrix()).y).toBeLessThan(viewport.y - 100);
    await expect.poll(async () => Math.abs((await heading.boundingBox())!.y - (before.y - actualPan))).toBeLessThan(3);
    expect((await matrix()).zoom).toBe(viewport.zoom);
    await expect(page.getByRole('status', { name: '修改跟随' })).toHaveCount(0);
    const finalY = (await heading.boundingBox())!.y;
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const restoredHeading = page.getByRole('heading', { name: '非十进制与十进制互转', exact: true });
    await expect.poll(async () => Math.abs((await restoredHeading.boundingBox())!.y - finalY)).toBeLessThan(3);
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t09-anchor.png' });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});


test('layout persistence failure retains the visible placement and retry confirms it over actual host IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-layout-ui-fault-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let fault: DatabaseSync | undefined;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    fault.exec("CREATE TRIGGER reject_ui_layout BEFORE INSERT ON layout_baseline BEGIN SELECT RAISE(ABORT, 'layout storage unavailable'); END");
    const width = page.getByRole('slider', { name: '调整位置记数法与权展开宽度' });
    await width.focus(); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局未保存');
    await expect(width).toHaveAttribute('aria-valuenow', '674');
    await app.evaluate(({ app }) => app.quit());
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局未保存');
    fault.exec('DROP TRIGGER reject_ui_layout');
    await page.getByRole('button', { name: '重试保存布局' }).click();
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局已保存');
    const saved = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return (await b.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-001'); });
    expect(saved.width).toBe(674);
  } finally { fault?.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
