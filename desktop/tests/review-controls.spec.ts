import { evidencePath } from './evidence-paths';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('review controls persist, answer reveal does not promote, and a substantive prompt cannot override a newer choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-electron-review-'));
  const coursePath = join(root, 'course');
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${coursePath}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    await expect(window.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    const choices = window.getByRole('group', { name: '设置复习状态' });
    await choices.getByRole('button', { name: '已掌握' }).click();
    await expect(choices.getByRole('button', { name: '已掌握' })).toHaveAttribute('aria-pressed', 'true');
    await window.evaluate(() => document.querySelector<HTMLElement>('.answer summary')?.click());
    await expect(choices.getByRole('button', { name: '已掌握' })).toHaveAttribute('aria-pressed', 'true');

    await window.getByText('可控生产者 · 验证入口', { exact: true }).click();
    await window.getByRole('button', { name: '读取当前依据', exact: true }).click();
    const candidate = window.getByRole('textbox', { name: '可控候选内容' });
    await candidate.fill(`${await candidate.inputValue()}\n可控演示：重要结论发生实质变化。`);
    await window.getByRole('checkbox', { name: /重要结论或方法/ }).check();
    await window.getByRole('button', { name: '提交可控修改', exact: true }).click();
    await expect(window.getByText(/要将此单元改为待复习吗/)).toBeVisible();
    await window.getByText('可控生产者 · 验证入口', { exact: true }).click();
    // Actual modification following can move the top-of-unit controls offscreen.
    // Student navigation explicitly takes control before making the newer choice.
    await window.getByRole('navigation', { name: '课程目录' }).getByRole('button', { name: '位置记数法与权展开', exact: true }).click();
    await choices.getByRole('button', { name: '薄弱' }).click();
    await window.getByRole('button', { name: '改为待复习' }).click();
    await expect(choices.getByRole('button', { name: '薄弱' })).toHaveAttribute('aria-pressed', 'true');
    await expect(window.getByText(/要将此单元改为待复习吗/)).toHaveCount(0);

    await app.close();
    app = await launch(); window = await app.firstWindow();
    await window.getByRole('button', { name: '数制与数制转换', exact: true }).first().click();
    const reopenedChoices = window.getByRole('group', { name: '设置复习状态' });
    await expect(reopenedChoices.getByRole('button', { name: '薄弱' })).toHaveAttribute('aria-pressed', 'true');
    await window.screenshot({ path: evidencePath('t10-review.png'), fullPage: true });
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
