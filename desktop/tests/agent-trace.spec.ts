import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resizeBoardWindow } from './board-test-helpers';
import type { Page } from '@playwright/test';

const fixture = resolve('dist/tests/agent-executor-fixture.cjs');

async function ask(mode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-trace-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture,
      YIZHI_FIXTURE_REASONING: '1', ...(mode ? { YIZHI_FIXTURE_MODE: mode } : {}) } });
  const page: Page = await app.firstWindow(); await resizeBoardWindow(app, page);
  await page.getByRole('button', { name: '学习对话', exact: true }).click();
  await page.getByRole('textbox', { name: '学习对话草稿' }).fill('为什么位置改变值？');
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByRole('button', { name: /思考/ }).first()).toBeVisible({ timeout: 30_000 });
  return { app, page, root, messages: page.locator('.agent-messages') };
}

/** The process layer the panel was missing: what the Agent did, collapsed by default, expandable to the real tool name. */
test('answer carries a collapsed process trace that opens to the actual tool call and the model thinking', async () => {
  test.setTimeout(120_000);
  const { app, page, root, messages } = await ask();
  try {
    const thinking = page.getByRole('button', { name: /思考/ }).first();
    // Once the item completes the row collapses itself instead of holding the student's place open.
    await expect(thinking).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
    await thinking.click();
    await expect(page.getByText(/先读单元正文/)).toBeVisible();
    await expect(page.getByText('以上是模型自己的思考记录，不是课程结论。')).toBeVisible();

    const tool = page.getByRole('button', { name: /读取单元正文/ }).first();
    await expect(tool).toBeVisible();
    // The internal name stays out of the scan path and appears only on demand.
    await expect(tool).not.toContainText('yizhi_');
    await tool.click();
    await expect(page.getByText('yizhi_read_target')).toBeVisible();
    await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled();

    if (process.env.YIZHI_EVIDENCE_DIR) {
      await messages.evaluate(node => node.scrollTo(0, 0));
      await messages.screenshot({ path: join(process.env.YIZHI_EVIDENCE_DIR, 'agent-trace-expanded.png') });
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

/** Preflight is disabled in this app, so prose block elements only look right if the panel styles them. */
test('an answer with headings, lists, a quote and a formula renders as structured prose rather than literal markers', async () => {
  test.setTimeout(120_000);
  const { app, page, root, messages } = await ask('markdown');
  try {
    const prose = page.locator('.agent-prose').last();
    await expect(prose.locator('h3')).toHaveText('位权');
    await expect(prose.locator('ul > li')).toHaveCount(2);
    await expect(prose.locator('ol > li')).toHaveCount(2);
    await expect(prose.locator('blockquote')).toContainText('同一个数字');
    await expect(prose.locator('.katex').first()).toBeVisible();
    // The old renderer turned markers into visible text and headings into bold; neither may survive.
    const text = await prose.innerText();
    expect(text).not.toMatch(/(^|\n)\s*[-*]\s/);
    expect(text).not.toContain('## ');
    if (process.env.YIZHI_EVIDENCE_DIR) {
      await messages.evaluate(node => node.scrollTo(0, 0));
      await messages.screenshot({ path: join(process.env.YIZHI_EVIDENCE_DIR, 'agent-prose-markdown.png') });
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

/** The dock owns the width: the conversation must fill whatever the student drags it to, and reading position must survive a trace opening. */
test('the conversation follows every dock width and keeps its reading anchor when a trace opens', async () => {
  test.setTimeout(120_000);
  const { app, page, root, messages } = await ask();
  try {
    const resizer = page.getByRole('separator', { name: '调整学习对话宽度', exact: true });
    const viewport = page.locator('[data-slot="message-scroller-viewport"]');
    await resizer.focus(); await page.keyboard.press('Home');
    await expect(page.locator('.shell-dock-agent')).toHaveCSS('width', '320px');
    for (const key of ['Home', 'End'] as const) {
      await resizer.focus(); await page.keyboard.press(key);
      const width = Number(await resizer.getAttribute('aria-valuenow'));
      const panel = Math.round(await page.locator('.agent-panel').evaluate(node => node.getBoundingClientRect().width));
      const inner = Math.round(await page.locator('#shell-agent-panel').evaluate(node => node.getBoundingClientRect().width));
      // The panel no longer carries its own fixed width: the dock's value is what the student actually sees.
      expect(panel).toBe(width); expect(inner).toBe(width);
      const box = await page.locator('.agent-panel').boundingBox(), composer = await page.locator('.agent-composer').boundingBox();
      expect(composer!.x).toBeGreaterThanOrEqual(box!.x);
      expect(composer!.x + composer!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
      if (process.env.YIZHI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.YIZHI_EVIDENCE_DIR, `agent-width-${width}.png`), animations: 'disabled' });
    }

    await viewport.evaluate(node => node.scrollTo(0, 0));
    const before = await viewport.evaluate(node => node.scrollTop);
    await page.getByRole('button', { name: /思考/ }).first().click();
    await expect(page.getByText(/先读单元正文/)).toBeVisible();
    expect(await viewport.evaluate(node => node.scrollTop)).toBeLessThanOrEqual(before + 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
