import { expect, type Page } from '@playwright/test';
export async function courseAction(page: Page, name: string) {
  await page.getByRole('button', {name:'课程菜单',exact:true}).click();
  await page.getByRole('menuitem', {name:name==='历史与空间'?'课程设置 · 历史与空间':name,exact:true}).click();
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
