import { test, expect, _electron as electron } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';

test('actual installed CLI rewrites one memory description into existing hits, preserves the board and unsent draft, and returns offline to literal search', async () => {
  test.skip(process.env.YIZHI_REAL_DESCRIPTION !== '1', 'Requires explicit installed CLI inference acceptance');
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'yizhi-description-actual-')), course = join(root, 'course');
  if (process.env.YIZHI_DESCRIPTION_COURSE) await cp(process.env.YIZHI_DESCRIPTION_COURSE, course, { recursive: true });
  const env = { ...process.env, PATH: '/usr/bin:/bin', YIZHI_DATA_HOME: join(root, 'profile') } as Record<string, string>;
  delete env.YIZHI_CODEX_PATH; delete env.YIZHI_DESCRIPTION_FIXTURE;
  let app = await electron.launch({ args: [resolve('.'), `--course=${course}`], env });
  const evidence: any = { description: '我记得一段讲解：同一个数码写在数字串不同的位置，代表的量就不一样。想找回那部分已有讲解。', runtime: null, executor: null, run: null, assertions: {} };
  try {
    const page = await app.firstWindow(); await resizeBoardWindow(app, page);
    if (await page.locator('.source-panel').isVisible()) await page.getByRole('button', { name: '返回画板', exact: true }).click();
    await page.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toBeVisible();
    await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
    await page.getByRole('textbox', { name: '学习对话草稿' }).fill('真实描述检索验收：这个未发问题必须原样保留。');
    await expect(page.getByRole('status', { name: '对话草稿保存' })).toHaveText('草稿已保存');
    await page.getByRole('button', { name: '收起对话', exact: true }).click();
    const snapshot = () => page.evaluate(async () => {
      const c = await window.yizhi.open(), list = await window.yizhi.agent.list({ sessionId: c.sessionId });
      return { unit: c.unit, graph: await window.yizhi.graph(c.sessionId), review: await window.yizhi.reviewStates(c.sessionId), conversations: await Promise.all(list.conversations.map(v => window.yizhi.agent.get({ sessionId: c.sessionId, conversationId: v.id }))) };
    });
    const before = await snapshot();
    const opened = await page.evaluate(() => window.yizhi.open()); evidence.runtime = opened.runtime; evidence.contentScope = opened.contentScope; evidence.courseUnits = before.graph.nodes.length;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const camera = await page.locator('.reading-layer[data-unit-id="KU-001"]').getAttribute('style');
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.getByText('按记忆线索查找（Agent）', { exact: true }).click();
    await expect(page.getByRole('combobox', { name: '描述检索模型' })).toBeVisible({ timeout: 20_000 });
    const models = await page.getByRole('combobox', { name: '描述检索模型' }).locator('option').evaluateAll(options => options.map(option => ({ model: (option as HTMLOptionElement).value, displayName: option.textContent })));
    evidence.offeredModels = models;
    const model = models.find(m => m.model === 'gpt-6-luna') ?? models[0];
    await page.getByRole('combobox', { name: '描述检索模型' }).selectOption(model.model);
    await page.getByRole('textbox', { name: '记忆线索' }).fill(evidence.description);
    await page.getByRole('button', { name: '用描述查找已有内容', exact: true }).click();
    const region = page.getByRole('region', { name: '描述检索结果', exact: true });
    await expect(region).toHaveAttribute('aria-busy', 'false', { timeout: 100_000 });
    const id = (await region.getAttribute('data-description-id'))!;
    evidence.run = await page.evaluate(({ sessionId, id }) => window.yizhi.description.get({ sessionId, id }), { sessionId: opened.sessionId, id });
    expect(evidence.run.state, evidence.run.error).toBe('completed'); evidence.executor = evidence.run.executor;
    expect(evidence.run.queries.length).toBeGreaterThan(0); expect(evidence.run.hits.length).toBeGreaterThan(0);
    expect(evidence.run.hits.some((h: any) => h.hit.unitId === 'KU-001')).toBe(true);
    for (const selected of evidence.run.hits) {
      expect(selected.basis.length).toBeGreaterThan(0);
      expect(selected.basis.every((basis: any) => evidence.run.queries.some((q: any) => q.id === basis.queryId && q.hitIds.includes(selected.id) && q.query === basis.query))).toBe(true);
      const actual = await page.evaluate(({ sessionId, hit }) => window.yizhi.search.locate({ sessionId, hit }), { sessionId: opened.sessionId, hit: selected.hit });
      expect(actual).toEqual(selected.hit);
    }
    await region.getByText('查询与排序依据', { exact: true }).first().click();
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t20-actual-description-results.png' });
    await region.getByRole('button', { name: '定位命中', exact: true }).first().click();
    await expect(page.locator('[data-search-current="true"]')).toBeVisible();
    await page.screenshot({ path: '/tmp/yizhi-implement-gFFkA7/t20-actual-description-location.png' });
    await page.getByRole('button', { name: '返回搜索前位置', exact: true }).click();
    await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toHaveAttribute('style', camera!);
    expect(await snapshot()).toEqual(before);
    evidence.assertions = { actualQueryAndHitBasis: true, canonicalLocateVerified: true, boardReviewAndAllUnsentConversationsUnchanged: true, cameraReturned: true };
    await page.getByRole('button', { name: '搜索课程', exact: true }).click();
    await page.context().setOffline(true);
    await page.getByRole('searchbox').fill('基数');
    await expect(page.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    await page.getByText('按记忆线索查找（Agent）', { exact: true }).click();
    await expect(page.getByRole('button', { name: '用描述查找已有内容', exact: true })).toBeDisabled();
    evidence.assertions.offlineLiteralSearchWithoutAnotherInference = true;
    await app.close();
    app = await electron.launch({ args: [resolve('.'), `--course=${course}`], env: { ...env, YIZHI_CODEX_PATH: join(root, 'missing-codex') } });
    const reopened = await app.firstWindow(); await resizeBoardWindow(app, reopened);
    await reopened.getByRole('button', { name: '搜索课程', exact: true }).click();
    await reopened.getByText('按记忆线索查找（Agent）', { exact: true }).click();
    await expect(reopened.getByRole('status', { name: '描述检索可用性' })).toContainText('暂不可用');
    await reopened.getByRole('searchbox').fill('位权');
    await expect(reopened.getByRole('region', { name: '搜索结果', exact: true })).toContainText('已有内容');
    evidence.assertions.actualMissingCLIAfterReopenKeepsLiteralSearch = true;
  } finally {
    await writeFile('/tmp/yizhi-implement-gFFkA7/t20-actual-description.json', JSON.stringify(evidence, null, 2));
    await app.close(); await rm(root, { recursive: true, force: true });
  }
});
