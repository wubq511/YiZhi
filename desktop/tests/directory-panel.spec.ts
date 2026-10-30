import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evidencePath } from './evidence-paths';

test('directory disclosure, navigation and status filters stay consistent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-directory-'));
  const packaged = process.env.YIZHI_PACKAGED_APP;
  const app = await electron.launch({ ...(packaged ? { executablePath: join(resolve(packaged), 'Contents/MacOS/YiZhi') } : {}),
    args: [...(packaged ? [] : [resolve('.')]), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    const directory = page.getByRole('navigation', { name: '课程目录' });
    const firstTheme = directory.getByRole('button', { name: '数制与数制转换', exact: true });
    await firstTheme.click();
    await expect(page.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    await expect(firstTheme).toHaveAccessibleDescription('已掌握 0 个，共 5 个单元');
    await expect(directory.getByRole('button', { name: '位置记数法与权展开', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.mouse.move(600, 80);
    await directory.screenshot({ path: evidencePath('directory-1440.png'), animations: 'disabled' });

    const viewport = await page.locator('.react-flow__viewport').getAttribute('style');
    await directory.getByRole('button', { name: '收起数制与数制转换' }).click();
    await expect(directory.getByRole('button', { name: '位置记数法与权展开', exact: true })).toHaveCount(0);
    await directory.getByRole('button', { name: '展开数制与数制转换' }).click();
    await directory.getByRole('button', { name: '展开有符号数与补码运算' }).click();
    await expect(directory.getByRole('button', { name: '收起有符号数与补码运算' })).toHaveAttribute('aria-expanded', 'true');
    await expect(directory.getByRole('button', { name: '展开数制与数制转换' })).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(viewport);
    await directory.getByRole('button', { name: '展开数制与数制转换' }).click();
    await directory.getByRole('button', { name: '非十进制与十进制互转', exact: true }).click();
    await expect(page.getByRole('heading', { name: '非十进制与十进制互转', exact: true })).toBeVisible();
    await firstTheme.click();
    await expect(page.getByRole('heading', { name: '位置记数法与权展开', exact: true })).toBeVisible();

    await page.getByRole('group', { name: '设置复习状态' }).getByRole('button', { name: '薄弱', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 768));
    const filter = directory.getByRole('button', { name: '复习状态筛选：全部单元' });
    await filter.click();
    await expect(page.getByRole('menuitemradio', { name: '全部单元', exact: true })).toBeVisible();
    await page.screenshot({ path: evidencePath('directory-filter-1024.png'), animations: 'disabled' });
    await page.getByRole('menuitemradio', { name: '薄弱', exact: true }).click();
    await expect(directory.getByRole('button', { name: '复习状态筛选：薄弱' })).toBeVisible();
    await expect(directory.getByRole('button', { name: '数制与数制转换', exact: true })).toBeVisible();
    await expect(directory.getByRole('button', { name: '有符号数与补码运算', exact: true })).toHaveCount(0);
    await expect(directory.getByRole('button', { name: '位置记数法与权展开', exact: true })).toHaveAccessibleDescription('薄弱');
    await directory.getByRole('button', { name: '收起数制与数制转换' }).click();
    await expect(directory.getByRole('button', { name: '位置记数法与权展开', exact: true })).toHaveCount(0);
    await directory.getByRole('button', { name: '展开数制与数制转换' }).click();
    await expect(directory.getByRole('button', { name: '位置记数法与权展开', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '个人批注', exact: true }).click();
    await expect(directory).toBeHidden();
    await page.getByRole('button', { name: '课程目录', exact: true }).click();
    await expect(directory.getByRole('button', { name: '复习状态筛选：薄弱' })).toBeVisible();

    await directory.getByRole('button', { name: '复习状态筛选：薄弱' }).click();
    await page.getByRole('menuitemradio', { name: '已掌握', exact: true }).click();
    await expect(directory.getByRole('status')).toContainText('没有已掌握的单元');
    await directory.getByRole('button', { name: '查看全部单元' }).click();
    const allFilter = directory.getByRole('button', { name: '复习状态筛选：全部单元' });
    await allFilter.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitemradio', { name: '全部单元', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(directory).toBeVisible(); await expect(allFilter).toBeFocused();

    const list = directory.locator('.directory-list');
    const headerTop = await directory.locator('.directory-header').evaluate(el => el.getBoundingClientRect().top);
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    expect(await directory.locator('.directory-header').evaluate(el => el.getBoundingClientRect().top)).toBe(headerTop);
    await list.evaluate(el => { el.scrollTop = 0; });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(700, 700));
    await expect(directory).toBeVisible();
    await directory.screenshot({ path: evidencePath('directory-700.png') });
    await directory.getByRole('button', { name: '收起数制与数制转换' }).click();
    await expect(directory).toBeVisible();
    await directory.getByRole('button', { name: '展开数制与数制转换' }).click();
    await directory.getByRole('button', { name: '非十进制与十进制互转', exact: true }).click();
    await expect(directory).toBeHidden();
    await expect(page.getByRole('button', { name: '课程目录', exact: true })).toBeFocused();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
