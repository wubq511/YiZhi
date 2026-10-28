import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow } from './board-test-helpers';

test('persisted long conversation keeps the working composer usable at desktop and narrow window sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-composer-layout-'));
  const fixture = resolve('dist/tests/agent-executor-fixture.cjs');
  await chmod(fixture, 0o755);
  const app = await electron.launch({
    args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile'), YIZHI_CODEX_PATH: fixture, YIZHI_FIXTURE_MODE: 'steer-retry' },
  });
  try {
    const page = await app.firstWindow();
    await resizeBoardWindow(app, page, 1024, 688);
    await page.getByRole('button', { name: 'Agent · 学习对话', exact: true }).click();
    const longQuestion = Array.from({ length: 32 }, (_, i) => `第 ${i + 1} 段：请结合位权解释这个长问题，保留前后文。`).join('\n');
    const input = page.getByRole('textbox', { name: '学习对话草稿' });
    await input.fill(longQuestion);
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' })).toContainText('正在回答');
    const saved = await page.evaluate(async () => {
      const api = window.yizhi, course = await api.open(), list = await api.agent.list({ sessionId: course.sessionId });
      return api.agent.get({ sessionId: course.sessionId, conversationId: list.selectedId! });
    });
    expect(saved.messages.find(message => message.role === 'user')?.text).toBe(longQuestion);

    const observations = [];
    for (const [width, height] of [[1024, 688], [700, 700]]) {
      await resizeBoardWindow(app, page, width, height);
      // Inspect the initial panel view; focusing a control must not be used to scroll it into place.
      const layout = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.agent-panel')!;
        panel.scrollTop = 0;
        const box = (selector: string) => {
          const { top, bottom } = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { top, bottom };
        };
        return {
          inner: { width: innerWidth, height: innerHeight }, panel: box('.agent-panel'),
          messages: box('.agent-messages'), composer: box('.agent-composer'),
          textarea: box('.agent-composer textarea'), mode: box('.agent-composer select[aria-label="工作中消息方式"]'),
          model: box('.agent-send select'), send: box('.agent-send button'),
        };
      });
      console.log(`composer layout ${width}x${height}: ${JSON.stringify(layout)}`);
      await page.screenshot({ path: `/tmp/yizhi-implement-gFFkA7/composer-scroll-${width}x${height}.png` });
      observations.push(layout);
    }
    for (const layout of observations) {
      const visibleBottom = Math.min(layout.panel.bottom, layout.composer.bottom, layout.inner.height);
      // Enough room to read a message label and several lines while composing.
      expect(layout.messages.bottom - layout.messages.top).toBeGreaterThan(100);
      for (const control of [layout.textarea, layout.mode, layout.model, layout.send]) {
        expect(control.top).toBeGreaterThanOrEqual(layout.panel.top);
        expect(control.bottom).toBeLessThanOrEqual(visibleBottom);
      }
    }
    await input.fill('请在当前工作结束后继续解释位权。');
    await page.getByRole('combobox', { name: '工作中消息方式' }).selectOption('queue');
    await page.getByRole('button', { name: '排队发送', exact: true }).click();
    await expect(page.getByRole('status', { name: '回答状态' }).filter({ hasText: '已排队' })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
