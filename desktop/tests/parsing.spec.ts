import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsingFixture } from './parsing-fixture';

test('actual host parsing UI shows immutable artifacts, correction, original-page return and persistence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-parsing-ui-'));
  const path=join(root,'new-source.pdf');await parsingFixture(path);
  const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  let app=await launch();
  try {
    let page=await app.firstWindow();
    await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
    const editor=page.getByRole('textbox',{name:'编辑首段正文'});
    await editor.fill('解析资料期间保留的正文');
    await expect(page.getByRole('status',{name:'保存状态'})).toHaveText('已保存');
    const editorHandle=await editor.elementHandle();
    const camera=await page.locator('.reading-layer').first().getAttribute('style');
    await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},path);
    await page.getByRole('button',{name:'原文资料',exact:true}).click();
    await page.getByRole('button',{name:'导入资料',exact:true}).click();
    await expect(page.getByRole('status',{name:'原文状态'})).toHaveText('原页已载入');
    await page.getByText('解析此资料',{exact:true}).click();
    await page.getByRole('button',{name:'开始解析此版本',exact:true}).click();
    await expect(page.getByRole('status',{name:'解析进度'})).toContainText('已完成 · 已确认 2 / 2 页');
    await page.getByRole('button',{name:'查看第 1 页产物',exact:true}).click();
    await expect(page.getByLabel('结构化页面产物')).toContainText('Logic notes');
    await expect(page.locator('.parse-raster')).toHaveJSProperty('naturalWidth',360);
    await expect(page.getByLabel('结构化页面产物')).toContainText('Table');
    await expect(page.getByLabel('结构化页面产物')).toContainText('Formula');
    await expect(page.locator('.parse-table th').first()).toHaveText('Input');
    await expect(page.locator('.parse-table td').first()).toHaveText('0');
    await page.locator('.parse-table').evaluate(el=>el.scrollIntoView({block:'start'}));
    await page.screenshot({path:'/tmp/yizhi-implement-gFFkA7/t29-structured-artifact.png'});
    await page.getByLabel('修正文字',{exact:true}).fill('Corrected logic notes');
    await page.getByLabel('修正依据').fill('Compared with original page');
    await page.getByRole('button',{name:'保留为新产物版本',exact:true}).click();
    await expect(page.getByRole('status',{name:'产物修正结果'})).toContainText('已保留新版本');
    await expect(page.getByLabel('结构化页面产物')).toContainText('Corrected logic notes');
    await page.getByRole('button',{name:'核对产物原页',exact:true}).click();
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Logic notes');
    await page.screenshot({path:'/tmp/yizhi-implement-gFFkA7/t29-parsing-desktop.png'});
    await page.setViewportSize({width:700,height:600});
    await page.getByRole('button',{name:'查看第 2 页产物',exact:true}).click();
    await expect(page.getByLabel('结构化页面产物')).toContainText('需要 OCR');
    await page.screenshot({path:'/tmp/yizhi-implement-gFFkA7/t29-parsing-narrow.png'});
    await page.getByRole('button',{name:'返回画板',exact:true}).click();
    expect(await editorHandle!.evaluate(node=>node.isConnected)).toBe(true);
    await page.setViewportSize({width:1280,height:900});
    await expect(editor).toHaveText('解析资料期间保留的正文');
    expect(await page.locator('.reading-layer').first().getAttribute('style')).toBe(camera);
    await app.close();app=await launch();
    page=await app.firstWindow();await page.getByRole('button',{name:'原文资料',exact:true}).click();
    await page.getByText('解析此资料',{exact:true}).click();
    await expect(page.getByRole('status',{name:'解析进度'})).toContainText('已完成 · 已确认 2 / 2 页');
    await expect(page.getByRole('button',{name:'查看修正版',exact:true})).toBeVisible();
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('stop and continue use the actual parser; closing the learning window leaves the host task alive',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-parsing-window-'));
  const path=join(root,'new-source.pdf');await parsingFixture(path,14);
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    let page=await app.firstWindow();
    await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},path);
    await page.getByRole('button',{name:'原文资料',exact:true}).click();await page.getByRole('button',{name:'导入资料',exact:true}).click();
    await expect(page.getByRole('status',{name:'原文状态'})).toHaveText('原页已载入');
    await page.getByText('解析此资料',{exact:true}).click();await page.getByRole('button',{name:'开始解析此版本',exact:true}).click();
    await page.getByRole('button',{name:'停止解析',exact:true}).click();
    await expect(page.getByRole('status',{name:'解析进度'})).toContainText('已停止');
    const stopped=await page.evaluate(async()=>{const api=(window as any).yizhi,opened=await api.open();return (await api.parsing.list({sessionId:opened.sessionId}))[0];});
    await page.getByRole('button',{name:'从已确认页面继续',exact:true}).click();
    await page.getByRole('button',{name:'返回画板',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].close();});
    await expect.poll(async()=>app.windows().length).toBe(0);
    await app.evaluate(({app})=>{app.emit('activate');});
    page=await app.waitForEvent('window');await page.waitForLoadState();
    await page.getByRole('button',{name:'原文资料',exact:true}).click();await page.getByText('解析此资料',{exact:true}).click();
    await expect(page.getByRole('status',{name:'解析进度'})).toContainText('已完成 · 已确认 16 / 16 页',{timeout:20000});
    const done=await page.evaluate(async()=>{const api=(window as any).yizhi,opened=await api.open();return (await api.parsing.list({sessionId:opened.sessionId}))[0];});
    expect(done.taskId).toBe(stopped.taskId);expect(done.attempts).toHaveLength(2);
    for(const confirmed of stopped.confirmed) expect(done.confirmed).toContainEqual(confirmed);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
