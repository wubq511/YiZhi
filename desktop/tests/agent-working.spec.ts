import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';

test('actual active B edits and Undo save to that B and reopen without changing KU001', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-active-b-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: {
    ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'no-model-needed') } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resizeBoardWindow(app, page);
    const before = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return { first: c.unit, other: await b.readUnit(c.sessionId, 'KU-057') }; });
    await page.getByRole('button', { name: '复用器与分配器', exact: true }).click();
    await page.getByRole('button', { name: 'MUX 器件、级联与扩展', exact: true }).first().click();
    const reader = page.locator('[data-agent-unit="KU-057"]');
    const editor = reader.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await expect(editor).toBeVisible();
    const paragraph = editor.locator('[data-block-id]').filter({ hasText: before.other.reading.blocks.find((b: any) => b.kind === 'paragraph').payload.text }).first();
    await revealBoardControl(page, paragraph); await paragraph.click(); await page.keyboard.press('Home');
    await page.keyboard.insertText('学生同时编辑：');
    const originalBlock = before.other.reading.blocks.find((b: any) => b.kind === 'paragraph');
    await expect.poll(() => page.evaluate(async id => { const b = (window as any).yizhi, c = await b.open(); return (await b.readUnit(c.sessionId, 'KU-057')).reading.blocks.find((p: any) => p.id === id).payload.text; }, originalBlock.id)).toContain('学生同时编辑：');
    await page.keyboard.press('Meta+z');
    await expect.poll(() => page.evaluate(async id => { const b = (window as any).yizhi, c = await b.open(); return (await b.readUnit(c.sessionId, 'KU-057')).reading.blocks.find((p: any) => p.id === id).payload.text; }, originalBlock.id)).toBe(originalBlock.payload.text);
    await page.keyboard.press('Meta+Shift+z');
    const edited = await page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return b.read(c.sessionId, 'KU-057'); });
    await expect.poll(() => page.evaluate(async id => { const b = (window as any).yizhi, c = await b.open(); return (await b.readUnit(c.sessionId, 'KU-057')).reading.blocks.find((p: any) => p.id === id).payload.text; }, originalBlock.id)).toContain('学生同时编辑：');
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(before.first);
    await app.close(); app = await launch(); page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await expect(page.locator('[data-agent-unit="KU-057"]').getByRole('textbox', { name: '连续编辑正文', exact: true })).toContainText('学生同时编辑：');
    expect((await page.evaluate(() => (window as any).yizhi.open())).unit).toEqual(before.first);
    expect(edited.unit.id).toBe('KU-057');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});


test('working composer defaults to steer, shows failed delivery retry, and queued input has no turn until business completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-working-composer-')), fixture = resolve('dist/tests/agent-executor-fixture.cjs');
  await chmod(fixture, 0o755);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root,'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root,'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_FIXTURE_MODE: 'steer-retry' } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app,page);
    await page.getByRole('button', {name:'Agent · 学习对话',exact:true}).click();
    const input = page.getByRole('textbox',{name:'学习对话草稿'});
    await input.fill('解释位权'); await page.getByRole('button',{name:'发送问题',exact:true}).click();
    await expect(page.getByRole('status',{name:'回答状态'})).toContainText('正在回答');
    await expect(page.getByRole('combobox',{name:'工作中消息方式'})).toHaveValue('steer');
    await input.fill('更正：用三进制的例子');
    await page.getByRole('button',{name:'发送引导',exact:true}).click();
    await expect(page.getByRole('status',{name:'消息送达状态'})).toContainText('引导未送达');
    await page.getByRole('button',{name:'重试原引导',exact:true}).click();
    await expect(page.getByRole('status',{name:'消息送达状态'})).toContainText('已送达');
    await page.getByRole('combobox',{name:'工作中消息方式'}).selectOption('queue');
    await input.fill('处理结束后解释十进制'); await page.getByRole('button',{name:'排队发送',exact:true}).click();
    await expect(page.getByRole('status',{name:'回答状态'}).filter({hasText:'已排队'})).toBeVisible();
    const view = await page.evaluate(async()=>{const b=window.yizhi,c=await b.open(),l=await b.agent.list({sessionId:c.sessionId});return b.agent.get({sessionId:c.sessionId,conversationId:l.selectedId!});});
    expect(view.tasks).toHaveLength(2); expect(view.tasks[1].turnId).toBeNull();
    expect(view.tasks[0].deliveries).toHaveLength(1); expect(view.messages.filter(m=>m.role==='user')).toHaveLength(3);
    await page.screenshot({path:'/tmp/yizhi-implement-gFFkA7/t18-working-composer.png'});
    await expect(page.getByRole('status',{name:'回答状态'}).first()).toContainText('回答已完成',{timeout:15000});
    await expect(page.getByRole('status',{name:'回答状态'}).nth(1)).toContainText('正在回答');
  } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});

test('an active B annotation retains its actual selection and locates back to B after navigating elsewhere', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-active-b-note-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: {
    ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'no-model-needed') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    const original = await page.evaluate(() => window.yizhi.open());
    await page.getByRole('button', { name: '复用器与分配器', exact: true }).click();
    await page.getByRole('button', { name: 'MUX 器件、级联与扩展', exact: true }).first().click();
    const reader = page.locator('[data-agent-unit="KU-057"]'), editor = reader.getByRole('textbox', { name: '连续编辑正文', exact: true });
    await expect(editor).toBeVisible();
    const quote = await editor.evaluate((el: any) => {
      let from = 0, to = 0, quote = '';
      el.editor.state.doc.forEach((node: any, pos: number) => { if (!quote && node.type.name === 'paragraph') { from = pos + 1; to = from + 5; quote = node.textContent.slice(0, 5); } });
      el.editor.commands.setTextSelection({ from, to }); el.editor.view.focus(); return quote;
    });
    const annotate = reader.getByRole('button', { name: '批注所选文字', exact: true });
    await revealBoardControl(page, annotate); await annotate.click();
    await page.getByRole('textbox', { name: '批注内容', exact: true }).fill('MUX 的个人理解');
    await expect(page.getByRole('status', { name: '批注同步状态' })).toHaveText('已保存');
    await page.getByRole('button', { name: '关闭批注', exact: true }).click();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await page.getByRole('button', { name: '个人批注', exact: true }).click();
    await page.getByRole('button', { name: '定位当前选段', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => window.yizhi.readingState((await window.yizhi.open()).sessionId).then(s => s?.unitId))).toBe('KU-057');
    await expect.poll(async () => (await reader.locator('.annotation-highlight').allTextContents()).join('')).toBe(quote);
    const c = await page.evaluate(() => window.yizhi.open()); expect(c.unit).toEqual(original.unit);
    const notes = await page.evaluate(async () => window.yizhi.annotations.list({ sessionId: (await window.yizhi.open()).sessionId }));
    expect(notes).toHaveLength(1); expect(notes[0].original.unitId).toBe('KU-057'); expect(notes[0].original.fragments[0].quote).toBe(quote);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
