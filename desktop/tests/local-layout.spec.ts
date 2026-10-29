import type { DatabaseSync } from 'node:sqlite';
import { openFaultDatabase, holdFaultWriter } from './fault-database';
import { evidencePath } from './evidence-paths';
import type { Worker } from 'node:worker_threads';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { resizeBoardWindow } from './board-test-helpers';

async function reveal(page: Page, target: Locator) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  const board = (await page.locator('main.board').boundingBox())!;
  await page.mouse.move(board.x + 10, board.y + board.height / 2);
  for (let i = 0; i < 60; i++) {
    const box = (await target.boundingBox())!;
    const delta = box.y - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 3) return;
    await page.mouse.wheel(0, Math.max(-500, Math.min(500, delta)));
    await page.waitForTimeout(30);
  }
  throw new Error('没有找到阅读位置');
}


async function boardWheelPoint(page: Page) {
  return page.evaluate(() => {
    const board = document.querySelector('main.board')!, rect = board.getBoundingClientRect();
    const left = Math.max(12, rect.left + 12), right = Math.min(innerWidth - 12, rect.right - 12);
    const top = Math.max(12, rect.top + 12), bottom = Math.min(innerHeight - 12, rect.bottom - 12);
    const blocked = '.board-tools, .relations-panel, .source-dialog, .react-flow__minimap, .drawing-tools, .drawing-entry, .follow-control, input, select, textarea, button, .mux, .builtin-formula-editor, math-field';
    for (const y of [top + (bottom - top) / 2, top + (bottom - top) * .75, top + (bottom - top) / 3]) {
      for (const x of [left + 38, (left + right) / 2, right - 24]) {
        const hit = document.elementFromPoint(x, y);
        if (x >= left && x <= right && y >= top && y <= bottom && hit?.closest('main.board') === board && !hit.closest(blocked) && !hit.closest('[inert]'))
          return { x, y, hit: hit.outerHTML.slice(0, 280), board: rect.toJSON(), viewport: [innerWidth, innerHeight] };
      }
    }
    throw new Error('没有无遮挡的画板滚轮起点：' + JSON.stringify({ board: rect.toJSON(), viewport: [innerWidth, innerHeight] }));
  });
}

async function followScene(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('.react-flow__viewport')!;
    const m = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const action = document.querySelector<HTMLElement>('.follow-control button'), rect = action?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY], camera: { x: m.e, y: m.f, zoom: m.a },
      board: document.querySelector('main.board')?.getBoundingClientRect().toJSON(), producer: document.querySelector('.producer-panel')?.getBoundingClientRect().toJSON(),
      activeElement: document.activeElement?.outerHTML.slice(0, 280),
      follow: document.querySelector('[aria-label="修改跟随"]')?.textContent, controls: document.querySelector('.follow-control')?.outerHTML,
      returnControl: rect && { box: rect.toJSON(), clear: hit === action || !!action?.contains(hit ?? null), hit: hit?.outerHTML.slice(0, 280) },
      wheel: (window as any).__layoutWheelEvidence ?? null };
  });
}

async function saveFollowFailure(page: Page, observations: unknown[]) {
  try {
    observations.push({ phase: 'failure', scene: await followScene(page) });
    const scenePath = test.info().outputPath('follow-failure-scene.json'), domPath = test.info().outputPath('follow-failure-dom.html');
    await writeFile(scenePath, JSON.stringify(observations, null, 2)); await writeFile(domPath, await page.content());
    await test.info().attach('follow-failure-scene', { path: scenePath, contentType: 'application/json' });
    await test.info().attach('follow-failure-dom', { path: domPath, contentType: 'text/html' });
    await page.screenshot({ path: test.info().outputPath('follow-failure.png') });
  } catch (captureError) {
    await test.info().attach('follow-capture-error', { body: String(captureError), contentType: 'text/plain' });
  }
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
    await reveal(page, move);
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
    // The old saved label can still belong to the preceding width edit; wait for this move's durable result.
    await expect.poll(() => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return (await b.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-001').x; })).toBeGreaterThan(180);
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
    const observations: unknown[] = [];
    try {
      await resizeBoardWindow(app, page, 900, 688);
      await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
      await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
      await page.getByRole('button', { name: '读取当前依据', exact: true }).click();
      await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('正在跟随修改');
      const matrix = () => page.locator('.react-flow__viewport').evaluate(el => { const m = new DOMMatrixReadOnly(getComputedStyle(el).transform); return { x: m.e, y: m.f, zoom: m.a }; });
      const initial = await matrix();
      await page.getByRole('textbox', { name: '可控候选内容' }).fill('实际增长的正文。'.repeat(80));
      await page.getByRole('button', { name: '提交可控修改', exact: true }).click();
      await expect(page.getByRole('status', { name: '可控生产者状态' })).toContainText('正式修改已保存');
      const changed = page.locator('[data-block-id="RB-TH-01-03-expansion-terms"]').first();
      await expect(changed).toHaveText('实际增长的正文。'.repeat(80));
      // Actual changed content must be visible; movement depends on the starting camera.
      const viewBounds = (await page.locator('main.board').boundingBox())!;
      await expect.poll(async () => (await changed.boundingBox())!.y).toBeGreaterThanOrEqual(viewBounds.y);
      await expect.poll(async () => (await changed.boundingBox())!.y).toBeLessThan(viewBounds.y + viewBounds.height - 32);
      expect((await matrix()).zoom).toBe(initial.zoom);
      // A real wheel event takes control while the authored follow can still have queued frames.
      const point = await boardWheelPoint(page);
      observations.push({ phase: 'before-wheel', point, scene: await followScene(page) });
      await page.evaluate(() => {
        (window as any).__layoutWheelEvidence = null;
        window.addEventListener('wheel', event => {
          const target = event.target as Element, m = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform);
          (window as any).__layoutWheelEvidence = { trusted: event.isTrusted, dx: event.deltaX, dy: event.deltaY, point: [event.clientX, event.clientY],
            inBoard: target.closest('main.board') === document.querySelector('main.board'), target: target.outerHTML.slice(0, 280),
            path: event.composedPath().map(node => node instanceof Element ? { tag: node.tagName, class: node.getAttribute('class'), label: node.getAttribute('aria-label') } : String(node)),
            camera: { x: m.e, y: m.f, zoom: m.a } };
        }, { capture: true, once: true });
      });
      await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -220);
      await expect.poll(() => page.evaluate(() => (window as any).__layoutWheelEvidence)).not.toBeNull();
      const wheel = await page.evaluate(() => (window as any).__layoutWheelEvidence);
      expect(wheel.trusted).toBe(true); expect(wheel.inBoard).toBe(true); expect(wheel.dy).toBe(-220);
      await expect.poll(async () => (await matrix()).y).toBeGreaterThan(wheel.camera.y);
      observations.push({ phase: 'after-wheel', scene: await followScene(page) });
      await expect(page.getByRole('button', { name: '返回并继续跟随', exact: true })).toBeVisible();
      const taken = await matrix();
      await page.evaluate(() => new Promise<void>(done => { let frames = 0; const next = () => { if (++frames === 4) done(); else requestAnimationFrame(next); }; requestAnimationFrame(next); }));
      expect(await matrix()).toEqual(taken);
      await page.getByRole('button', { name: '重读并整合', exact: true }).click();
      await page.getByRole('textbox', { name: '可控候选内容' }).fill('后一个真实修改也不能抢回视野。'.repeat(110));
      await page.getByRole('button', { name: '提交可控修改', exact: true }).click();
      await expect(page.getByRole('status', { name: '可控生产者状态' })).toContainText('正式修改已保存');
      await expect.poll(matrix).toEqual(taken);
      observations.push({ phase: 'before-close-producer', scene: await followScene(page) });
      // The producer popover can cover the independent follow control at 900px.
      await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
      expect(await matrix()).toEqual(taken);
      observations.push({ phase: 'return-control-uncovered', scene: await followScene(page) });
      await page.getByRole('button', { name: '返回并继续跟随', exact: true }).click();
      await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('正在跟随修改');
      await expect.poll(async () => (await matrix()).y).not.toBe(taken.y);
      await page.getByRole('button', { name: '全图', exact: true }).click();
      await expect(page.getByRole('button', { name: '返回并继续跟随', exact: true })).toBeVisible();
      await expect.poll(async () => (await matrix()).zoom).toBeLessThan(.35);
      const beforeEnd = await matrix();
      await page.getByText('可控生产者 · 验证入口', { exact: true }).click();
      await page.getByRole('button', { name: '结束可控修改', exact: true }).click();
      await expect(page.getByRole('button', { name: '查看修改结果', exact: true })).toBeVisible();
      expect(await matrix()).toEqual(beforeEnd);
      observations.push({ phase: 'finished', scene: await followScene(page) });
      await app.close(); app = await launch(); page = await app.firstWindow();
      await resizeBoardWindow(app, page, 900, 688);
      await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
      expect(await matrix()).toEqual(beforeEnd);
      await expect(page.getByRole('button', { name: '返回并继续跟随', exact: true })).toHaveCount(0);
      await expect(page.getByRole('status', { name: '修改跟随' })).toHaveText('修改已结束');
      await expect(page.getByRole('button', { name: '查看修改结果', exact: true })).toBeVisible();
      observations.push({ phase: 'reopened', scene: await followScene(page) });
      const scenePath = test.info().outputPath('follow-wheel-scenes.json');
      await writeFile(scenePath, JSON.stringify(observations, null, 2));
      await test.info().attach('follow-wheel-scenes', { path: scenePath, contentType: 'application/json' });
      console.log('Follow takeover geometry:', JSON.stringify({ viewport: point.viewport, point: [point.x, point.y], trusted: wheel.trusted, inBoard: wheel.inBoard, before: wheel.camera, taken }));
    } catch (error) { await saveFollowFailure(page, observations); throw error; }
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
    await page.screenshot({ path: evidencePath('t09-anchor.png') });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});


test('layout persistence failure retains the visible placement and retry confirms it over actual host IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-layout-ui-fault-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let fault: DatabaseSync | undefined;
  let setupWriter: Worker | undefined;
  let completed=false;
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    fault = openFaultDatabase(join(root, 'course/course.sqlite'));
    setupWriter = await holdFaultWriter(join(root, 'course/course.sqlite'));
    setupWriter.postMessage('release');
    fault.exec("CREATE TRIGGER reject_ui_layout BEFORE INSERT ON layout_baseline BEGIN SELECT RAISE(ABORT, 'layout storage unavailable'); END");
    const width = page.getByRole('slider', { name: '调整位置记数法与权展开宽度' });
    await width.focus(); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局未保存');
    await expect(width).toHaveAttribute('aria-valuenow', '674');
    await app.evaluate(({ app, ipcMain, dialog }) => {
      (globalThis as any).layoutCloseResult=null;
      (globalThis as any).layoutQuitError=null;
      // Capture the real host failure dialog so its native modal does not block automation.
      dialog.showErrorBox=(title,content)=>{(globalThis as any).layoutQuitError={title,content};};
      ipcMain.once('window:close-result',(_event,result)=>{(globalThis as any).layoutCloseResult=result.saved;});
      app.quit();
    });
    await expect.poll(()=>app.evaluate(()=> (globalThis as any).layoutCloseResult)).toBe(false);
    await expect.poll(()=>app.evaluate(()=> (globalThis as any).layoutQuitError?.title)).toBe('退出未完成');
    expect(await app.evaluate(()=> (globalThis as any).layoutQuitError.content)).toContain('仍有窗口的最新输入未确认保存');
    await expect.poll(()=>page.evaluate(()=>document.body.inert)).toBe(false);
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局未保存');
    fault.exec('DROP TRIGGER reject_ui_layout');
    await page.getByRole('button', { name: '重试保存布局' }).click();
    await expect(page.getByRole('status', { name: '布局状态' })).toHaveText('布局已保存');
    const saved = await page.evaluate(async () => { const b = (window as any).yizhi; const c = await b.open(); return (await b.graph(c.sessionId)).layout.nodes.find((n: any) => n.unitId === 'KU-001'); });
    expect(saved.width).toBe(674);completed=true;
  } finally { await setupWriter?.terminate();fault?.exec('DROP TRIGGER IF EXISTS reject_ui_layout');fault?.close(); if(completed)await app.close();else app.process().kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
