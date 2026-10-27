import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page, Locator } from '@playwright/test';

async function reveal(page: Page, target: Locator) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  const board = (await page.locator('main.board').boundingBox())!;
  for (let i = 0; i < 60; i++) {
    const box = (await target.boundingBox())!; const delta = box.y - board.y - board.height / 2;
    if (Math.abs(delta) < board.height / 3) return;
    const article = await target.evaluate(el => { const r = el.closest('article')!.getBoundingClientRect(); return { x: r.x }; });
    await page.mouse.move(Math.max(board.x + 8, Math.min(board.x + board.width - 8, article.x + 8)), board.y + board.height / 2);
    await page.mouse.wheel(0, Math.max(-500, Math.min(500, delta))); await page.waitForTimeout(30);
  }
  await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t12-debug.png' });
  throw new Error('实验未进入阅读视野: ' + JSON.stringify({ board, target: await target.boundingBox() }));
}


test('actual built-in controls, diagram, offscreen stop and formula confirmation survive normal window reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '复用器与分配器', exact: true }).click();
    await page.getByRole('button', { name: 'MUX 器件、级联与扩展', exact: true }).first().click();
    let lab = page.getByRole('region', { name: '交互 · 4 选 1 的选择语义', exact: true });
    await reveal(page, lab.getByRole('checkbox', { name: 'I0', exact: true, includeHidden: true }));
    await expect(lab.getByRole('status', { name: '实验保存状态' })).toHaveText('现场已保存');
    await lab.getByRole('checkbox', { name: 'I0', exact: true }).check();
    await expect(lab.getByRole('status', { name: 'MUX 输出' })).toHaveText('输出 Z = 1');
    await expect(lab.getByRole('img', { name: 'MUX 数据通路' })).toBeVisible();
    await reveal(page, lab.getByRole('button', { name: '开始遍历输入', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '开始遍历输入', exact: true }).click();
    const read = () => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.experiments.read({ sessionId: c.sessionId, instanceId: 'KU-057/RB-TH-13-057-010-interactive' }); });
    await expect.poll(async () => (await read()).state.step).toBeGreaterThan(0);
    // Actual navigation pans to the unit header, taking the experiment offscreen.
    await page.getByRole('navigation', { name: '课程目录' }).getByRole('button', { name: 'MUX 器件、级联与扩展', exact: true }).click();
    await expect.poll(async () => (await read()).phase).toBe('paused');
    const paused = (await read()).state;
    await page.waitForTimeout(600); expect((await read()).state).toEqual(paused);
    await reveal(page, lab.getByRole('checkbox', { name: 'I0', exact: true, includeHidden: true }));
    await expect.poll(async () => (await read()).phase).toBe('running');
    await reveal(page, lab.getByRole('button', { name: '暂停遍历', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '暂停遍历', exact: true }).click();
    await reveal(page, lab.getByRole('button', { name: '编辑实验公式', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '编辑实验公式', exact: true }).click();
    await lab.locator('math-field').evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', 'Z=1']); });
    await expect(lab.getByRole('status', { name: '实验保存状态' })).toHaveText('现场已保存');
    await expect(lab.getByRole('status', { name: 'MUX 输出' })).toHaveText('输出 Z = 1');
    const confirmed = await read(); expect(confirmed.definition.config.dataSignals).toEqual(['1', '1', '1', '1']);
    await reveal(page, lab.getByRole('button', { name: '完成公式编辑', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '完成公式编辑', exact: true }).click();
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t12-mux.png' });
    await app.close(); app = await launch(); page = await app.firstWindow();
    lab = page.getByRole('region', { name: '交互 · 4 选 1 的选择语义', exact: true }); await reveal(page, lab.getByRole('checkbox', { name: 'I0', exact: true, includeHidden: true }));
    const reopened = await read(); expect(reopened.definition).toEqual(confirmed.definition); expect(reopened.state).toEqual(confirmed.state);
    await reveal(page, lab.getByRole('button', { name: '编辑实验公式', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '编辑实验公式', exact: true }).click();
    await lab.locator('math-field').evaluate((el: any) => { el.executeCommand('selectAll'); el.executeCommand(['insert', '\\sin(x)']); });
    await expect(lab.getByRole('status', { name: '实验保存状态' })).toHaveText('现场已保存');
    await expect(lab.getByText('公式需要核对；当前不显示计算结果。', { exact: true })).toBeVisible();
    await expect(lab.getByRole('status', { name: 'MUX 输出' })).toHaveCount(0);
    await page.getByRole('button', { name: '编码器与译码器', exact: true }).click();
    await page.getByRole('button', { name: '译码器功能与 2:4/3:8 译码器', exact: true }).first().click();
    const decoder = page.getByRole('region', { name: '交互 · 74LS138 式低有效输出', exact: true }); await reveal(page, decoder.getByRole('checkbox', { name: 'E3', exact: true, includeHidden: true }));
    await decoder.getByRole('checkbox', { name: 'E3', exact: true }).uncheck();
    await expect(decoder.getByRole('status', { name: '译码器输出' })).toHaveText('未使能 · Y0–Y7 = 11111111');
    await page.getByRole('button', { name: '卡诺图基础与化简', exact: true }).click();
    await page.getByRole('button', { name: '2–4 变量卡诺图化简', exact: true }).first().click();
    const kmap = page.getByRole('region', { name: '固定卡诺图 · 跨边四格', exact: true }); await reveal(page, kmap.getByRole('checkbox', { name: '显示跨边四格', exact: true, includeHidden: true }));
    await kmap.getByRole('checkbox', { name: '显示跨边四格', exact: true }).check();
    await expect(kmap.locator('[data-highlighted="true"]')).toHaveCount(4);
    await expect(kmap.getByRole('status', { name: '卡诺图结论' })).toHaveText('四格跨边相邻，A、B 变化，C 恒为 0，所以 F = ¬C。');
    await reveal(page, kmap.getByRole('status', { name: '卡诺图结论', includeHidden: true }));
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t12-kmap.png' });
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});


test('actual IPC pause failure shows incomplete and confirmed recovery can run again without reviving old input', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'yizhi-builtin-ui-fault-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  const appProcess = app.process();
  let fault: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
    await page.getByRole('button', { name: '复用器与分配器', exact: true }).click();
    const unit = page.getByRole('navigation', { name: '课程目录' }).getByRole('button', { name: 'MUX 器件、级联与扩展', exact: true }); await unit.click();
    const lab = page.getByRole('region', { name: '交互 · 4 选 1 的选择语义', exact: true });
    await reveal(page, lab.getByRole('button', { name: '开始遍历输入', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '开始遍历输入', exact: true }).click();
    const read = () => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.experiments.read({ sessionId: c.sessionId, instanceId: 'KU-057/RB-TH-13-057-010-interactive' }); });
    await expect.poll(async () => (await read()).state.step).toBeGreaterThan(0);
    fault = new DatabaseSync(join(root, 'course/course.sqlite'));
    fault.exec("CREATE TRIGGER fail_pause_ui BEFORE UPDATE ON builtin_experiments BEGIN SELECT RAISE(ABORT,'actual UI pause fault'); END");
    await unit.click();
    await expect.poll(async () => (await read()).phase).toBe('pause-incomplete');
    const confirmed = (await read()).state;
    await page.waitForTimeout(550); expect((await read()).state).toEqual(confirmed);
    fault.exec('DROP TRIGGER fail_pause_ui'); fault.close(); fault = undefined;
    const recovery = lab.getByRole('button', { name: '恢复最近确认现场', exact: true, includeHidden: true });
    await reveal(page, recovery); await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t12-pause-incomplete.png' }); await recovery.click();
    await expect(lab.getByRole('status', { name: '实验保存状态' })).toHaveText('现场已保存');
    expect((await read()).state).toEqual(confirmed);
    // Recovery removes the error section; locate the run control in the current read projection.
    await reveal(page, lab.getByRole('button', { name: '开始遍历输入', exact: true, includeHidden: true }));
    await lab.getByRole('button', { name: '开始遍历输入', exact: true }).click();
    await expect.poll(async () => (await read()).state.step).toBeGreaterThan(confirmed.step);
    await app.close();
  } finally {
    fault?.close();
    if (appProcess.exitCode === null && appProcess.signalCode === null) {
      const exited = new Promise<void>(done => appProcess.once('exit', () => done())); appProcess.kill('SIGKILL'); await exited;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
