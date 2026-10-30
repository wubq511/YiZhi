import { CourseService } from '../src/core/course-service';
import { openFaultDatabase } from './fault-database';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { evidencePath } from './evidence-paths';
import { chooseShape, courseAction } from './shell-actions';
const repository = dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());
const scratch = join(repository,'artifacts','scratch','modern-workspace-shell');
test('shell retains panels and targets, uses real tool histories and returns keyboard focus', async () => {
  await mkdir(scratch,{recursive:true});
  const root=await mkdtemp(join(scratch,'ui-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  const errors: string[]=[];
  try {
    const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
    await expect(page.getByRole('navigation',{name:'课程目录',exact:true})).toBeVisible();
    expect(await page.locator('.source-pdf canvas').count()).toBe(0);
    await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
    await expect(page.getByRole('heading',{name:'位置记数法与权展开',exact:true})).toBeVisible();
    const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    await page.screenshot({path:evidencePath(`implementation-reading-${size.width}x${size.height}.png`)});
    const camera=await page.locator('.react-flow__viewport').getAttribute('style');
    await page.keyboard.press('Meta+k');
    const search=page.getByRole('searchbox',{name:'查找已有内容',exact:true});await expect(search).toBeFocused();
    const searchInput=await search.elementHandle();
    for(let i=0;i<8;i++){
      const query=`权展开 ${i}`;await search.fill(query);
      await page.getByRole('button',{name:'个人批注',exact:true}).click();await expect(search).toBeHidden();
      await page.getByRole('button',{name:'搜索课程',exact:true}).click();await expect(search).toHaveValue(query);
      expect(await searchInput!.evaluate(input=>input.isConnected)).toBe(true);
    }
    await search.fill('权展开');await expect(page.getByRole('region',{name:'搜索结果'}).getByRole('button',{name:'定位命中'}).first()).toBeVisible();
    await expect(page.getByRole('navigation',{name:'课程目录',exact:true})).toBeHidden();
    await search.press('Escape');await expect(page.getByRole('button',{name:'搜索课程',exact:true})).toBeFocused();
    expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(camera);
    await page.getByRole('button',{name:'课程目录',exact:true}).click();
    await page.getByRole('button',{name:'图形',exact:true}).click();await expect(page.getByRole('menuitemradio',{name:'个人箭头',exact:true})).toBeVisible();
    await page.screenshot({path:evidencePath(`implementation-shapes-${size.width}x${size.height}.png`)});
    await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'图形',exact:true})).toBeFocused();
    await chooseShape(page,'矩形');const board=(await page.locator('main.board').boundingBox())!;
    await page.mouse.move(board.x+board.width-190,board.y+140);await page.mouse.down();await page.mouse.move(board.x+board.width-80,board.y+220,{steps:8});await page.mouse.up();
    await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('已保存');
    await expect(page.getByRole('button',{name:'撤销画板',exact:true})).toBeEnabled();await page.getByRole('button',{name:'撤销画板',exact:true}).click();
    await expect.poll(()=>page.evaluate(async()=>{const b=window.yizhi,c=await b.open();return (await b.drawings.list({sessionId:c.sessionId}))[0]?.status;})).toBe('deleted');
    await page.getByRole('button',{name:'重做画板',exact:true}).click();await expect.poll(()=>page.locator('[data-drawing-id]').count()).toBe(1);
    await page.getByRole('button',{name:'阅读工具',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'连续编辑正文',exact:true}).first();
    await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection({from:1,to:7});el.editor.view.focus();});
    const quote=await page.evaluate(()=>getSelection()?.toString());
    await page.getByRole('button',{name:'提问',exact:true}).first().click();
    await expect(page.getByRole('complementary',{name:'Agent 学习对话'})).toBeVisible();await expect(page.locator('.agent-attachment blockquote')).toContainText(quote!);
    const composer=page.getByRole('textbox',{name:'学习对话草稿',exact:true});await composer.fill('保留这一段草稿');
    await page.screenshot({path:evidencePath(`implementation-agent-${size.width}x${size.height}.png`)});
    await page.getByRole('button',{name:'收起对话',exact:true}).click();await expect(page.getByRole('button',{name:'学习对话',exact:true})).toBeFocused();
    await page.getByRole('button',{name:'学习对话',exact:true}).click();await expect(composer).toHaveValue('保留这一段草稿');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1024,768));
    await page.getByRole('button',{name:'课程目录',exact:true}).click();await expect(page.getByRole('navigation',{name:'课程目录',exact:true})).toBeVisible();await expect(composer).toBeHidden();
    const medium=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));await page.screenshot({path:evidencePath(`implementation-panels-${medium.width}x${medium.height}.png`)});
    await page.getByRole('button',{name:'学习对话',exact:true}).click();await expect(composer).toHaveValue('保留这一段草稿');await expect(page.getByRole('navigation',{name:'课程目录',exact:true})).toBeHidden();
    await page.getByRole('button',{name:'收起对话',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(700,700));
    await page.keyboard.press('Meta+k');await expect(search).toBeFocused();
    const narrow=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));await page.screenshot({path:evidencePath(`implementation-search-${narrow.width}x${narrow.height}.png`)});
    await search.press('Escape');
    await courseAction(page,'完整备份');await expect(page.getByRole('dialog',{name:'完整备份',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'返回课程',exact:true}).click();await expect(page.getByRole('button',{name:'课程菜单',exact:true})).toBeFocused();
    expect(errors).toEqual([]);
    await writeFile(evidencePath('implementation-ui.json'),JSON.stringify({sizes:[size,medium,narrow],errors,scope:'Independent initialized course fixture; real Electron and core APIs, no mocked renderer'},null,2));
  } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});

test('a failed review save remains visible after another channel saves and retries the actual write', async () => {
  await mkdir(scratch,{recursive:true});const root=await mkdtemp(join(scratch,'save-fault-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  let fault: ReturnType<typeof openFaultDatabase> | undefined;
  try {
    const page=await app.firstWindow();await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
    fault=openFaultDatabase(join(root,'course','course.sqlite'));
    fault.exec("CREATE TRIGGER shell_review_failure BEFORE INSERT ON review_states BEGIN SELECT RAISE(ABORT,'test review failure'); END");
    await page.getByRole('group',{name:'设置复习状态',exact:true}).getByRole('button',{name:'已掌握',exact:true}).click();
    await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('有改动未保存');
    await page.getByRole('button',{name:'学习对话',exact:true}).click();await page.getByRole('textbox',{name:'学习对话草稿',exact:true}).fill('这个独立草稿保存成功');
    await expect(page.getByRole('status',{name:'对话草稿保存'})).toContainText('草稿已保存');
    await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('有改动未保存');
    fault.exec('DROP TRIGGER shell_review_failure');
    await page.locator('.shell-save').focus();await page.keyboard.press('Enter');const retry=page.getByRole('button',{name:/重试保存复习状态/});await expect(retry).toBeFocused();await page.keyboard.press('Enter');
    await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('已保存');
    await expect.poll(()=>page.evaluate(async()=>{const c=await window.yizhi.open();return (await window.yizhi.reviewStates(c.sessionId)).units['KU-001'].status;})).toBe('mastered');
  } finally { if(fault){fault.exec('DROP TRIGGER IF EXISTS shell_review_failure');fault.close();}await app.close();await rm(root,{recursive:true,force:true}); }
});

test('full view is immediate and cannot overwrite the next directory navigation', async () => {
  await mkdir(scratch,{recursive:true});const root=await mkdtemp(join(scratch,'camera-'));
  const core=new CourseService(resolve('dist/worker.cjs'));
  try {const c=await core.open(join(root,'course'));await core.setReadingState(c.sessionId,{unitId:'KU-001',expanded:{},returnStack:[],scrollTop:0,camera:{x:-2323,y:183,zoom:.12}});}finally{await core.close();}
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    for(let i=0;i<3;i++){
      await page.getByRole('button',{name:'全图',exact:true}).click();
      await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
      await expect(page.locator('.reading-layer[data-unit-id="KU-001"]')).toBeVisible();
      await expect.poll(()=>page.locator('.canvas-zoom').textContent()).toBe('85%');
      // Late measurement/persistence callbacks must not reapply the prior full-view request.
      await page.waitForTimeout(350);await expect(page.locator('.canvas-zoom')).toHaveText('85%');
    }
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('reading minimap stays above content and supports pan, zoom and collapse', async () => {
  await mkdir(scratch,{recursive:true});const root=await mkdtemp(join(scratch,'minimap-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1024,768));
    await page.getByRole('button',{name:'数制与数制转换',exact:true}).click();
    await expect(page.locator('.canvas-zoom')).toHaveText('85%');
    const map=page.locator('.react-flow__minimap');await expect(map).toBeVisible();
    expect(await map.evaluate(el=>{
      const r=el.getBoundingClientRect();return [[.1,.1],[.9,.1],[.5,.5],[.1,.9],[.9,.9]].every(([x,y])=>el.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)));
    })).toBe(true);
    const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));await page.screenshot({path:evidencePath(`minimap-reading-${size.width}x${size.height}.png`)});
    const before=await page.locator('.react-flow__viewport').getAttribute('style'),box=(await map.boundingBox())!;
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.7,box.y+box.height*.65,{steps:6});await page.mouse.up();
    await expect(page.locator('.react-flow__viewport')).not.toHaveAttribute('style',before!);
    const zoom=await page.locator('.canvas-zoom').textContent();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.wheel(0,-100);
    await expect(page.locator('.canvas-zoom')).not.toHaveText(zoom!);
    await page.getByRole('button',{name:'收起小地图',exact:true}).click();await expect(map).toHaveCount(0);
    await page.getByRole('button',{name:'展开小地图',exact:true}).click();await expect(map).toBeVisible();
    await writeFile(evidencePath('minimap-interaction.json'),JSON.stringify({size,hitTest:'five points above reading content',pan:true,zoom:true,toggle:true},null,2));
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
