import { expect, type Page } from '@playwright/test';
export async function expandDirectoryTheme(page: Page, name: string) {
  const directory = page.getByRole('navigation', { name: '课程目录', exact: true });
  const theme = directory.getByRole('button', { name, exact: true });
  if (await theme.getAttribute('aria-expanded') !== 'true') await theme.click();
}
export async function openDirectoryUnit(page: Page, theme: string, unit: string) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
  await expandDirectoryTheme(page, theme);
  await page.getByRole('navigation', { name: '课程目录', exact: true }).getByRole('button', { name: unit, exact: true }).click();
  await expect(page.locator('article[data-reading-active="true"] h1')).toHaveText(unit);
}
export async function openFirstUnit(page: Page) {
  await openDirectoryUnit(page, '数制与数制转换', '位置记数法与权展开');
  await expect(page.locator('[aria-label="连续编辑正文"]')).toHaveAttribute('contenteditable', 'true');
}
export async function courseAction(page: Page, name: string) {
  await page.getByRole('button', {name:'课程菜单',exact:true}).click();
  await page.getByRole('menuitem', {name,exact:true}).click();
}
export async function chooseShape(page: Page, name: string) {
  if (await page.getByRole('region',{name:'个人绘图工具',exact:true}).isVisible()) await page.getByRole('button',{name:'收起个人图形',exact:true}).click();
  if (name === '荧光笔') { await page.getByRole('button',{name,exact:true}).click(); return; }
  await page.getByRole('button',{name:'图形',exact:true}).click();
  await page.getByRole('menuitemradio',{name,exact:true}).click();
  await expect(page.getByRole('menuitemradio',{name,exact:true})).toBeHidden();
}
export async function drawingSpace(page: Page, space: string) {
  await page.getByRole('button',{name:'图形',exact:true}).click();
  await page.getByRole('menuitemradio',{name:({board:'画板',object:'当前对象',image:'图像内部'} as Record<string,string>)[space],exact:true}).click();
}
export async function manageDrawings(page: Page) {
  if (await page.getByRole('region',{name:'个人绘图工具',exact:true}).isVisible()) return;
  await page.getByRole('button',{name:'图形',exact:true}).click();
  await page.getByRole('menuitem',{name:'管理与找回图形',exact:true}).click();
  await expect(page.getByRole('region',{name:'个人绘图工具',exact:true})).toBeVisible();
}
export async function expectSaved(page: Page) { await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('已保存'); }
export async function sourceAction(page: Page, name: string) {
  await page.getByRole('button',{name:'资料操作',exact:true}).click();
  await page.getByRole('menuitem',{name,exact:true}).click();
}
export async function openRelations(page: Page) {
  await page.getByRole('button',{name:'关系',exact:true}).click();
  await page.getByRole('menuitem',{name:'查看与编辑正式关系',exact:true}).click();
}
export async function relationScope(page: Page, scope: string) {
  await page.getByRole('button',{name:'关系',exact:true}).click();
  await page.getByRole('menuitemradio',{name:({main:'主关系',auxiliary:'辅助关系',all:'全部关系'} as Record<string,string>)[scope],exact:true}).click();
}
export async function conversationTitles(page: Page) {
  await page.getByRole('button',{name:'学习对话列表',exact:true}).click();
  const items = await page.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  return items.filter(title => title !== '新对话');
}
export async function pickConversation(page: Page, title: string) {
  await page.getByRole('button',{name:'学习对话列表',exact:true}).click();
  await page.getByRole('menuitem',{name:title,exact:true}).click();
}
/** The panel states nothing when the executor is fine, so readiness is the composer's own control coming alive. */
export async function agentReady(page: Page) {
  await expect(page.getByRole('combobox', { name: '问答模型' })).toBeEnabled({ timeout: 60_000 });
}
