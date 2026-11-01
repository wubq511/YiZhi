import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { mkdtemp, rm, chmod, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow } from './board-test-helpers';
import { openFirstUnit } from './shell-actions';
const fixture = resolve('dist/tests/description-executor-fixture.cjs');

async function captureDescriptionFailure(page: Page) {
  const scene = await page.evaluate(async () => {
    const section = document.querySelector('[data-description-id]'), id = section?.getAttribute('data-description-id');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="AI 查找"]');
    let run: unknown;
    if (id) { const course = await window.yizhi.open(); run = await window.yizhi.description.get({ sessionId: course.sessionId, id }); }
    return { viewport: [innerWidth, innerHeight], availability: document.querySelector('[role="status"]')?.textContent,
      start: button ? { disabled: button.disabled, bounds: button.getBoundingClientRect().toJSON() } : null,
      clue: document.querySelector<HTMLInputElement>('[aria-label="查找已有内容"]')?.value,
      status: section?.querySelector('[role="status"]')?.textContent,
      interactions: (window as any).__descriptionInteractions ?? [], run };
  });
  const json = test.info().outputPath('description-failure.json'), dom = test.info().outputPath('description-failure.html'), screenshot = test.info().outputPath('description-failure.png');
  await writeFile(json, JSON.stringify(scene, null, 2)); await writeFile(dom, await page.content()); await page.screenshot({ path: screenshot });
  await test.info().attach('description-failure-scene', { path: json, contentType: 'application/json' });
  await test.info().attach('description-failure-dom', { path: dom, contentType: 'text/html' });
  await test.info().attach('description-failure-screen', { path: screenshot, contentType: 'image/png' });
}

test('explicit description search uses real hits and query/rank evidence while ordinary keywords, camera return and the unsent composer stay independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-ui-')); await chmod(fixture, 0o755);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_DESCRIPTION_FIXTURE: 'paragraph' } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await openFirstUnit(page);
    await page.getByRole('button', { name: '学习对话', exact: true }).click();
    await page.getByRole('textbox', { name: '学习对话草稿' }).fill('尚未发送，不要替我提问');
    await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('已保存');
    await page.getByRole('button', { name: '收起对话', exact: true }).click();
    await page.evaluate(async () => { const c = await window.yizhi.open(); await window.yizhi.drawings.apply({ sessionId: c.sessionId, operationId: 'description-drawing-seed', id: 'description-untouched-drawing', expectedVersion: 0, value: { kind: 'rectangle', anchor: { space: 'board' }, geometry: { x: 20, y: 30, width: 40, height: 30 } } }); });
    const before = await page.evaluate(async () => { const c = await window.yizhi.open(), a = await window.yizhi.agent.list({ sessionId: c.sessionId }); return { drawings: await window.yizhi.drawings.list({ sessionId: c.sessionId }), drawingHistory: await window.yizhi.drawings.history({ sessionId: c.sessionId }), placements: await window.yizhi.drawings.placements({ sessionId: c.sessionId }), unit: c.unit, review: await window.yizhi.reviewStates(c.sessionId), conversation: await window.yizhi.agent.get({ sessionId: c.sessionId, conversationId: a.selectedId! }) }; });
    const camera = await page.locator('.reading-layer[data-unit-id="KU-001"]').getAttribute('style');
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('基数');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    const aiToggle = page.getByRole('button', { name: 'AI 检索', exact: true });
    await aiToggle.hover();
    await expect(page.getByRole('tooltip')).toHaveText('AI 检索');
    const tipPlacement = await page.evaluate(() => {
      const tip = document.querySelector('[role="tooltip"]')!.getBoundingClientRect(), button = document.querySelector('.search-ai-toggle')!.getBoundingClientRect();
      return { centerDelta: Math.abs(tip.left + tip.width / 2 - (button.left + button.width / 2)), below: tip.top >= button.bottom };
    });
    expect(tipPlacement.centerDelta).toBeLessThan(1.5);
    expect(tipPlacement.below).toBe(true);
    await aiToggle.click();
    await expect(page.getByRole('tooltip')).toBeHidden();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('同一数码的位置变化会影响什么');
    await page.getByRole('button', { name: 'AI 查找', exact: true }).click();
    const enhanced = page.getByRole('region', { name: 'AI 检索结果', exact: true });
    await expect(enhanced).toContainText('检索完成');
    await expect(enhanced).toContainText('位置记数法');
    await expect(enhanced).not.toContainText('模型新解释');
    await enhanced.getByText('查询与排序依据', { exact: true }).first().click();
    await expect(enhanced).toContainText('query-1');
    await enhanced.getByRole('button', { name: '前往', exact: true }).first().click();
    await expect(page.locator('p[data-search-current="true"]')).toBeVisible();
    await page.getByRole('button', { name: '返回搜索前位置', exact: true }).click();
    await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toHaveAttribute('style', camera!);
    const after = await page.evaluate(async () => { const c = await window.yizhi.open(), a = await window.yizhi.agent.list({ sessionId: c.sessionId }); return { drawings: await window.yizhi.drawings.list({ sessionId: c.sessionId }), drawingHistory: await window.yizhi.drawings.history({ sessionId: c.sessionId }), placements: await window.yizhi.drawings.placements({ sessionId: c.sessionId }), unit: c.unit, review: await window.yizhi.reviewStates(c.sessionId), conversation: await window.yizhi.agent.get({ sessionId: c.sessionId, conversationId: a.selectedId! }) }; });
    expect(after).toEqual(before);
    await expect(page.getByRole('complementary', { name: '搜索课程', exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('基数');
    const aiTab = page.getByRole('tab', { name: 'AI 结果', exact: true });
    if (await aiTab.isVisible()) await aiTab.click();
    await expect(page.getByRole('region', { name: 'AI 检索结果', exact: true })).toContainText('搜索条件已改变');
    await expect(page.getByRole('region', { name: 'AI 检索结果', exact: true })).toContainText('位置记数法');
    const localTab = page.getByRole('tab', { name: '本地结果', exact: true });
    if (await localTab.isVisible()) await localTab.click();
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('offline and a genuinely missing CLI preserve basic short-word/symbol search at 1024 and the 700 overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-offline-ui-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-codex') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('button', { name: 'AI 检索', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '暂不可用' })).toBeVisible();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('这里记得位置影响数值');
    await expect(page.getByRole('button', { name: 'AI 查找', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'AI 检索', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('模');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await page.context().setOffline(true);
    await page.getByRole('button', { name: 'AI 检索', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '离线' })).toBeVisible();
    await page.getByRole('button', { name: 'AI 检索', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('基数');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await resizeBoardWindow(app, page, 700, 700);
    await expect(page.getByRole('dialog', { name: '搜索课程', exact: true })).toBeVisible();
    await expect(page.locator('main.board')).toHaveAttribute('inert', '');
    await page.getByRole('searchbox', { name: '查找已有内容' }).focus();
    await expect(page.getByRole('searchbox', { name: '查找已有内容' })).toHaveValue('基数');
    await page.screenshot({ path: evidencePath('t20-description-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '搜索课程', exact: true })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('literal input stays responsive while description is waiting, and stopping exits the peer without publishing a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-pending-ui-')); await chmod(fixture, 0o755);
  const ready = join(root, 'search-ready');
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_DESCRIPTION_FIXTURE: 'linger',
    YIZHI_DESCRIPTION_READY: ready } });
  let page: Page | undefined;
  try {
    page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.evaluate(() => {
      const interactions: unknown[] = []; (window as any).__descriptionInteractions = interactions;
      for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, input, [role="combobox"], [role="tab"]') : null;
        if (!target?.closest('[aria-label="搜索课程"]') || interactions.length >= 30) return;
        interactions.push({ type, trusted: event.isTrusted, time: performance.now(), target: target.getAttribute('aria-label') ?? target.textContent,
          disabled: target instanceof HTMLButtonElement ? target.disabled : undefined, bounds: target.getBoundingClientRect().toJSON() });
      }, true);
    });
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('button', { name: 'AI 检索', exact: true }).click();
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('记得位置会影响值');
    await expect(page.getByRole('button', { name: '检索模型' })).toContainText('Description fixture');
    await page.getByRole('button', { name: 'AI 查找', exact: true }).click();
    const enhanced = page.getByRole('region', { name: 'AI 检索结果', exact: true });
    await expect(enhanced.getByText('实际执行的查询 · 1', { exact: true })).toBeVisible();
    await expect.poll(() => existsSync(ready)).toBe(true);
    const peerPid = Number(await readFile(ready, 'utf8'));
    const localTab = page.getByRole('tab', { name: '本地结果', exact: true });
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('基数');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await page.getByRole('tab', { name: 'AI 结果', exact: true }).click();
    await expect(enhanced).toContainText('搜索条件已改变');
    await expect(enhanced).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('button', { name: '停止 AI 查找', exact: true }).click();
    await expect(enhanced.getByRole('status').filter({ hasText: '已停止' })).toBeVisible();
    await expect(enhanced.locator('.search-result')).toHaveCount(0);
    await expect.poll(() => { try { process.kill(peerPid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
    await expect(enhanced.getByRole('status').filter({ hasText: '已停止' })).toBeVisible();
    await expect(enhanced.locator('.search-result')).toHaveCount(0);
    await page.getByRole('searchbox', { name: '查找已有内容' }).fill('基数');
    await expect(enhanced.locator('.search-result')).toHaveCount(0);
    if (await localTab.isVisible()) await localTab.click();
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
  } catch (error) {
    if (page) await captureDescriptionFailure(page).catch(() => {});
    throw error;
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('AI model selection survives mode toggles and an Electron restart in the same profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-model-ui-')); await chmod(fixture, 0o755);
  const args = [resolve('.'), `--course=${join(root, 'course')}`];
  const env = { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_DESCRIPTION_FIXTURE: 'paragraph' };
  let app = await electron.launch({ args, env });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    const mode = page.getByRole('button', { name: 'AI 检索', exact: true });
    const model = page.getByRole('button', { name: '检索模型' });
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(model).toHaveCount(0);
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(model).toContainText('Description fixture');
    await model.click();
    await page.getByRole('menuitemradio', { name: 'Description fixture second', exact: true }).click();
    await expect(model).toContainText('Description fixture second');
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'false');
    await expect(model).toHaveCount(0);
    await mode.click();
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(model).toContainText('Description fixture second');
    const input = page.getByRole('searchbox', { name: '查找已有内容' });
    const initialHeight = (await input.boundingBox())!.height;
    await input.fill('线'.repeat(257));
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('本地搜索最多支持 256 字');
    await expect(page.getByRole('button', { name: 'AI 查找', exact: true })).toBeEnabled();
    expect((await input.boundingBox())!.height).toBeGreaterThan(initialHeight);
    await resizeBoardWindow(app, page, 700, 700);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await model.focus(); await page.keyboard.press('Space');
    await expect(page.getByRole('menuitemradio', { name: 'Description fixture second', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '搜索课程' })).toBeVisible();
    await expect(model).toBeFocused();
    await mode.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Space');
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.search-field').evaluate(el => parseFloat(getComputedStyle(el, '::after').transitionDuration))).toBeLessThan(0.001);
    await app.close();
    app = await electron.launch({ args, env });
    const reopened = await app.firstWindow(); await resizeBoardWindow(app, reopened);
    await reopened.getByRole('button', { name: '搜索课程', exact: true }).click();
    const reopenedMode = reopened.getByRole('button', { name: 'AI 检索', exact: true });
    if (await reopenedMode.getAttribute('aria-pressed') !== 'true') await reopenedMode.click();
    await expect(reopened.getByRole('button', { name: '检索模型' })).toContainText('Description fixture second');
    await reopened.getByRole('searchbox', { name: '查找已有内容' }).fill('同一数码的位置变化会影响什么');
    await expect(reopened.getByRole('button', { name: 'AI 查找', exact: true })).toBeEnabled();
    await reopened.getByRole('searchbox', { name: '查找已有内容' }).press('Enter');
    const result = reopened.getByRole('region', { name: 'AI 检索结果', exact: true });
    await expect(result).toContainText('检索完成');
    const id = (await result.getAttribute('data-description-id'))!;
    const run = await reopened.evaluate(async id => { const course = await window.yizhi.open(); return window.yizhi.description.get({ sessionId: course.sessionId, id }); }, id);
    expect(run.executor?.model).toBe('fixture-second');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a long model menu stays compact and supports scrolling and keyboard selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-model-list-ui-')); await chmod(fixture, 0o755);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_DESCRIPTION_FIXTURE: 'many-models' } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('button', { name: 'AI 检索', exact: true }).click();
    const model = page.getByRole('button', { name: '检索模型' });
    await expect(model).toBeEnabled();
    await model.click();
    const menu = page.getByRole('menu', { name: '检索模型' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(20);
    const bounds = (await menu.boundingBox())!;
    expect(bounds.height).toBeLessThanOrEqual(300);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const penultimate = menu.getByRole('menuitemradio', { name: 'Description fixture 19', exact: true });
    await expect(penultimate).toBeInViewport();
    await penultimate.click();
    await expect(model).toContainText('Description fixture 19');

    await model.click();
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    const last = menu.getByRole('menuitemradio', { name: 'Description fixture 20', exact: true });
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(model).toContainText('Description fixture 20');
    await model.click();
    await page.keyboard.press('Escape');
    await expect(model).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('rapid AI mode reversal preserves the query and keeps only the active controls accessible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-motion-ui-')); await chmod(fixture, 0o755);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_DESCRIPTION_FIXTURE: 'paragraph' } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    const mode = page.getByRole('button', { name: 'AI 检索', exact: true });
    const input = page.getByRole('searchbox', { name: '查找已有内容' });
    await input.fill('位置记数 1011'); await mode.click();
    const model = page.getByRole('button', { name: '检索模型' });
    await expect(model).toBeEnabled();
    const bounds = (await mode.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.click(x, y);
    await expect(page.locator('.search-controls-reveal')).toHaveAttribute('inert', '');
    await page.mouse.click(x, y);
    await page.waitForTimeout(350); // A pending exit must not remove the reopened controls.
    await expect(mode).toHaveAttribute('aria-pressed', 'true');
    await expect(model).toBeEnabled();
    await expect(input).toHaveValue('位置记数 1011');
    await expect(input).toBeFocused();
    await mode.focus(); await page.keyboard.press('Space');
    await expect(mode).toBeFocused();
    await expect(page.locator('.description-model-trigger')).toHaveCount(0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
