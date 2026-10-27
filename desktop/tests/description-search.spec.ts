import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow, revealBoardControl } from './board-test-helpers';
const fixture = resolve('dist/tests/description-executor-fixture.cjs');

test('explicit description search uses real hits and query/rank evidence while ordinary keywords, camera return and the unsent composer stay independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-ui-')); await chmod(fixture, 0o755);
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_DESCRIPTION_FIXTURE: 'paragraph' } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
    await page.getByRole('textbox', { name: '学习对话草稿' }).fill('尚未发送，不要替我提问');
    await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    await page.getByRole('button', { name: '收起对话', exact: true }).click();
    const before = await page.evaluate(async () => { const c = await window.yizhi.open(), a = await window.yizhi.agent.list({ sessionId: c.sessionId }); return { unit: c.unit, review: await window.yizhi.reviewStates(c.sessionId), conversation: await window.yizhi.agent.get({ sessionId: c.sessionId, conversationId: a.selectedId! }) }; });
    const camera = await page.locator('.reading-layer[data-unit-id="KU-001"]').getAttribute('style');
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByRole('searchbox').fill('基数');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await page.getByText('按记忆线索查找（Agent）', { exact: true }).click();
    await page.getByRole('textbox', { name: '记忆线索' }).fill('同一数码的位置变化会影响什么');
    await page.getByRole('button', { name: '用描述查找已有内容', exact: true }).click();
    const enhanced = page.getByRole('region', { name: '描述检索结果', exact: true });
    await expect(enhanced).toContainText('检索完成');
    await expect(enhanced).toContainText('位置记数法');
    await expect(enhanced).not.toContainText('模型新解释');
    await enhanced.getByText('查询与排序依据', { exact: true }).first().click();
    await expect(enhanced).toContainText('query-1');
    await enhanced.getByRole('button', { name: '定位命中', exact: true }).first().click();
    await expect(page.locator('p[data-search-current="true"]')).toBeVisible();
    await page.getByRole('button', { name: '返回搜索前位置', exact: true }).click();
    await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toHaveAttribute('style', camera!);
    const after = await page.evaluate(async () => { const c = await window.yizhi.open(), a = await window.yizhi.agent.list({ sessionId: c.sessionId }); return { unit: c.unit, review: await window.yizhi.reviewStates(c.sessionId), conversation: await window.yizhi.agent.get({ sessionId: c.sessionId, conversationId: a.selectedId! }) }; });
    expect(after).toEqual(before);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('offline and a genuinely missing CLI preserve basic short-word/symbol search at 1024 and the 700 overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-offline-ui-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: join(root, 'missing-codex') } });
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByText('按记忆线索查找（Agent）', { exact: true }).click();
    await expect(page.getByRole('status', { name: '描述检索可用性' })).toContainText('暂不可用');
    await page.getByRole('textbox', { name: '记忆线索' }).fill('这里记得位置影响数值');
    await expect(page.getByRole('button', { name: '用描述查找已有内容', exact: true })).toBeDisabled();
    await page.getByRole('searchbox').fill('模');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await page.context().setOffline(true);
    await expect(page.getByText('当前离线。上方关键词、别名和符号查找继续可用。', { exact: true })).toBeVisible();
    await page.getByRole('searchbox').fill('基数');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await resizeBoardWindow(app, page, 700, 700);
    await expect(page.getByRole('dialog', { name: '搜索课程', exact: true })).toBeVisible();
    await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
    await page.getByRole('textbox', { name: '记忆线索' }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('dialog', { name: '搜索课程', exact: true })).toContainText('当前离线');
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t20-description-narrow.png' });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '搜索课程', exact: true })).toBeFocused();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
