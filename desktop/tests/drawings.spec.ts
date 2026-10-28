import type { DatabaseSync } from 'node:sqlite';
import { openFaultDatabase } from './fault-database';
import { evidencePath } from './evidence-paths';
import { resizeBoardWindow } from './board-test-helpers';
import { test, expect, _electron as electron } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { CourseService } from '../src/core/course-service';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const snapshot = (page: Page) => page.evaluate(async () => { const b = (window as any).yizhi, c = await b.open(); return { c, drawings: await b.drawings.list({ sessionId: c.sessionId }), history: await b.drawings.history({ sessionId: c.sessionId }), graph: await b.graph(c.sessionId) }; });
async function drag(page: Page, x: number, y: number, dx = 130, dy = 80) {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up();
}

test('real drawing gesture saves one personal shape, cancels without a commit, and reopens all basic drawing tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-drawing-ui-'));
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await resizeBoardWindow(app,page); await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await page.screenshot({ path: evidencePath('t08-before.png') });
    await page.getByRole('button', { name: '绘图标注', exact: true }).click();
    const board = (await page.locator('main.board').boundingBox())!, x = board.x + 450, y = board.y + 150;
    await page.getByRole('button', { name: '矩形', exact: true }).click();
    await drag(page, x, y);
    await expect(page.getByRole('status', { name: '绘图同步状态' })).toHaveText('已保存');
    let s = await snapshot(page); expect(s.drawings).toHaveLength(1); expect(s.history).toHaveLength(1);
    expect(s.drawings[0].value.kind).toBe('rectangle');
    const original = s.drawings[0];
    await page.getByRole('button', { name: '矩形', exact: true }).click();
    await page.mouse.move(x + 200, y); await page.mouse.down(); await page.mouse.move(x + 250, y + 100, { steps: 5 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    s = await snapshot(page); expect(s.history).toHaveLength(1); expect(s.drawings).toEqual([original]);
    for (const name of ['椭圆', '个人箭头', '直线', '波浪线', '荧光笔']) {
      await page.getByRole('button', { name, exact: true }).click(); await drag(page, x + 10, y + 120, 150, 30);
      await expect(page.getByRole('status', { name: '绘图同步状态' })).toHaveText('已保存');
    }
    s = await snapshot(page); expect(s.drawings.map((d: any) => d.value.kind)).toEqual(['rectangle', 'ellipse', 'arrow', 'line', 'wave', 'highlighter']);
    expect(s.history).toHaveLength(6);
    const edges = s.graph.edges;
    await app.close(); app = await launch(); page = await app.firstWindow(); await resizeBoardWindow(app,page);
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    s = await snapshot(page); expect(s.drawings).toHaveLength(6); expect(s.graph.edges).toEqual(edges); expect(s.drawings[0]).toEqual(original);
    await page.getByRole('button', { name: '绘图标注', exact: true }).click();
    await expect(page.locator('[data-drawing-id]')).toHaveCount(6);
    await expect(page.getByRole('button',{name:'撤销画板',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'选择矩形 1',exact:true}).click();await page.getByRole('button',{name:'删除个人图形',exact:true}).click();await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('deleted');
    await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByRole('button',{name:/^选择矩形 1/}).click();await page.getByRole('button',{name:'找回已删除图形',exact:true}).click();await expect.poll(async()=>(await snapshot(page)).drawings[0].value.geometry).toEqual(original.value.geometry);

  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('one move or resize is one saved Undo; viewport and producer changes never steal the board step', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-drawing-undo-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();await resizeBoardWindow(app,page); await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    await page.getByRole('button',{name:'绘图标注',exact:true}).click();
    const board=(await page.locator('main.board').boundingBox())!,x=board.x+450,y=board.y+150;
    await page.getByRole('button',{name:'矩形',exact:true}).click(); await drag(page,x,y);
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    const original=(await snapshot(page)).drawings[0];
    await page.getByRole('button',{name:'选择矩形 1',exact:true}).click();
    await drag(page,x+40,y+30,90,50);
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    let s=await snapshot(page); expect(s.history).toHaveLength(2); const moved=s.drawings[0];
    expect(moved.value.geometry.x).toBeGreaterThan(original.value.geometry.x);
    await page.mouse.move(board.x+10,board.y+120); await page.mouse.wheel(0,100);
    const result=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),target=c.unit.reading.blocks[1],a=await b.commands.startAttempt({sessionId:c.sessionId,taskId:'drawing-background'}),basis=await b.commands.read({sessionId:c.sessionId,attemptId:a.attemptId,objectIds:[target.id]});return b.commands.commit({sessionId:c.sessionId,attemptId:a.attemptId,basisId:basis.basisId,operationId:'drawing-background',changes:[{objectId:target.id,value:{...basis.objects[0].value,payload:{...target.payload,text:'后台更新仍然保留'}}}]});});
    expect(result.status).toBe('committed');
    await page.locator('.drawing-layer').focus(); await page.keyboard.press('Meta+z');
    await expect.poll(async()=>(await snapshot(page)).drawings[0].value.geometry).toEqual(original.value.geometry);
    expect((await snapshot(page)).c.unit.reading.blocks[1].payload.text).toBe('后台更新仍然保留');
    await page.keyboard.press('Meta+Shift+z');
    await expect.poll(async()=>(await snapshot(page)).drawings[0].value.geometry).toEqual(moved.value.geometry);
    const resize=page.getByRole('slider',{name:'调整个人图形尺寸'}),bounds=(await resize.boundingBox())!;
    await drag(page,bounds.x+bounds.width/2,bounds.y+bounds.height/2,60,40);
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    s=await snapshot(page); expect(s.history).toHaveLength(5); expect(s.drawings[0].value.geometry.width).toBeGreaterThan(moved.value.geometry.width);
    await page.locator('.drawing-layer').focus(); await page.keyboard.press('Meta+z');
    await expect.poll(async()=>(await snapshot(page)).drawings[0].value.geometry).toEqual(moved.value.geometry);
    const beforeCancel=(await snapshot(page)).history.length;
    const shape=page.locator(`[data-drawing-id="${original.id}"]`),box=(await shape.boundingBox())!;
    await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+70,box.y+80);await page.keyboard.press('Escape');await page.mouse.up();
    expect((await snapshot(page)).history).toHaveLength(beforeCancel);
    await page.locator('.drawing-layer').focus();await page.keyboard.press('Delete');
    await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('deleted');
    await page.keyboard.press('Meta+z');await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('attached');
  } finally {await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('text highlighter follows the actual Unicode range, survives deletion as original context, and returns on proven editor Undo', async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-highlight-ui-'));
  const launch=()=>electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  let app=await launch();
  try{
    let page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
    const editor=page.getByRole('textbox',{name:'连续编辑正文',exact:true});
    await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection({from:2,to:5});el.editor.view.focus();});
    const quote=await page.evaluate(()=>getSelection()?.toString());expect(quote?.length).toBe(3);
    await page.getByRole('button',{name:'荧光笔标记所选文字',exact:true}).click();
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    await expect(editor.locator('.drawing-text-highlight')).toHaveText(quote!);
    const original=(await snapshot(page)).drawings[0];expect(original.value.anchor.space).toBe('text');
    await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection(1);el.editor.view.focus();});await page.keyboard.insertText('新增');
    await expect(page.getByRole('status',{name:'保存状态',exact:true})).toHaveText('已保存');
    await expect(editor.locator('.drawing-text-highlight')).toHaveText(quote!);
    const locations=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.annotations.list({sessionId:c.sessionId}))[0].current.fragments;});expect(locations[0].from).toBe(3);
    await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection({from:1,to:el.editor.state.doc.firstChild.nodeSize-1});el.editor.view.focus();});await page.keyboard.press('Backspace');
    await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('orphan');
    await expect(editor.locator('.drawing-text-highlight')).toHaveCount(0);
    if(await page.getByRole('button',{name:'绘图标注',exact:true}).getAttribute('aria-expanded')!=='true') await page.getByRole('button',{name:'绘图标注',exact:true}).click();
    await expect(page.getByRole('region',{name:'个人绘图工具'})).toContainText('待重新关联');
    await editor.focus();await page.keyboard.press('Meta+z');
    await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('attached');
    await expect(editor.locator('.drawing-text-highlight')).toHaveText(quote!);
    expect((await snapshot(page)).drawings[0].original).toEqual(original.original);
    await app.close();app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();await expect(page.getByRole('textbox',{name:'连续编辑正文',exact:true}).locator('.drawing-text-highlight')).toHaveText(quote!);
  }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('image marks follow relative geometry after width changes and deleted targets remain recoverable in the real UI',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-image-mark-ui-')),core=new CourseService(resolve('dist/worker.cjs'));
  try{const c=await core.open(join(root,'course')),ids=c.unit.reading.blocks.map(b=>b.id),image={id:'drawing-image',kind:'figure',payload:{asset:'ti74153-1.png',alt:'TI 74153 几何标注',caption:'图像标记的原语境'}};
    await core.commitEdit({sessionId:c.sessionId,operationId:'image-fixture',inputSeq:1,baseRevision:c.revision,changes:[],complete:true,patch:{updates:[],correspondence:[],structure:{parentId:c.unit.id,before:ids,after:[image.id,...ids],inserted:[image]}}});
  }finally{await core.close();}
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try{
    const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    const image=page.getByRole('img',{name:'TI 74153 几何标注',exact:true}),board=(await page.locator('main.board').boundingBox())!;
    await image.evaluate((el:HTMLImageElement)=>el.decode());
    const before=(await image.boundingBox())!;await page.mouse.move(board.x+10,board.y+150);await page.mouse.wheel(0,before.y-board.y-160);await page.waitForTimeout(200);
    await page.getByRole('button',{name:'绘图标注',exact:true}).click();
    await page.getByLabel('标注坐标',{exact:true}).selectOption('image');
    await page.getByRole('button',{name:'椭圆',exact:true}).click();
    const box=(await image.boundingBox())!;await drag(page,box.x+box.width*.15,box.y+box.height*.1,box.width*.2,box.height*.08);
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    const mark=(await snapshot(page)).drawings[0];expect(mark.value.anchor.space).toBe('image');expect(mark.value.geometry.x).toBeCloseTo(.15,2);expect(mark.value.geometry.width).toBeCloseTo(.2,2);
    const width=page.getByRole('slider',{name:'调整位置记数法与权展开宽度'});await width.focus();await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status',{name:'布局状态'})).toHaveText('布局已保存');
    await expect.poll(async()=>{const a=(await image.boundingBox())!,b=(await page.locator('[data-drawing-id] .drawing-ink').boundingBox())!;return (b.x-a.x)/a.width;}).toBeCloseTo(.15,2);
    expect((await snapshot(page)).drawings[0].value.geometry).toEqual(mark.value.geometry);
    await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),ids=c.unit.reading.blocks.map((x:any)=>x.id);await b.commitEdit({sessionId:c.sessionId,operationId:'remove-image-ui',inputSeq:c.confirmedInputSeq+1,baseRevision:c.revision,changes:[],complete:true,patch:{updates:[],correspondence:[],structure:{parentId:c.unit.id,before:ids,after:ids.filter((id:string)=>id!=='drawing-image'),inserted:[]}}});});
    await expect(page.getByRole('region',{name:'个人绘图工具'})).toContainText('待重新关联');
    await page.getByRole('button',{name:'找回到画板',exact:true}).click();
    await expect.poll(async()=>(await snapshot(page)).drawings[0].value.anchor.space).toBe('board');
    expect((await snapshot(page)).drawings[0].original).toEqual(mark.original);
  }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('unit adjustment and drawing share the board context in gesture order and Escape cancels a unit gesture without saving',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-board-order-ui-')),app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try{
    const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByRole('button',{name:'矩形',exact:true}).click();
    const board=(await page.locator('main.board').boundingBox())!;await drag(page,board.x+450,board.y+150,100,70);
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    const original=(await snapshot(page)).graph.layout.nodes.find((n:any)=>n.unitId==='KU-001');
    const width=page.getByRole('slider',{name:'调整位置记数法与权展开宽度'});await width.focus();await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('status',{name:'布局状态'})).toHaveText('布局已保存');
    expect((await snapshot(page)).graph.layout.nodes.find((n:any)=>n.unitId==='KU-001').width).toBe((original.width>=360?original.width:650)+24);
    await page.locator('.drawing-layer').focus();await page.keyboard.press('Meta+z');
    await expect.poll(async()=>(await snapshot(page)).graph.layout.nodes.find((n:any)=>n.unitId==='KU-001').width).toBe(original.width);
    expect((await snapshot(page)).drawings[0].status).toBe('attached');
    await page.keyboard.press('Meta+z');await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('deleted');
    await page.keyboard.press('Meta+Shift+z');await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('attached');
    const before=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.drawings.placements({sessionId:c.sessionId});});
    const move=page.getByRole('button',{name:'移动位置记数法与权展开'});await move.focus();const box=(await move.boundingBox())!;
    await page.mouse.move(box.x+20,box.y+10);await page.mouse.down();await page.mouse.move(box.x+80,box.y+60);await page.keyboard.press('Escape');await page.mouse.up();
    expect((await snapshot(page)).graph.layout.nodes.find((n:any)=>n.unitId==='KU-001').x).toBe(original.x);
    expect(await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return b.drawings.placements({sessionId:c.sessionId});})).toEqual(before);
  }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('body, MathLive, personal note and conversation input consume their own shortcuts without changing board history',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-drawing-focus-')),app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try{
    const page=await app.firstWindow();await resizeBoardWindow(app,page);await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByRole('button',{name:'矩形',exact:true}).click();
    const board=(await page.locator('main.board').boundingBox())!;await drag(page,board.x+450,board.y+150);await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    const drawing=(await snapshot(page)).drawings[0];
    await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
    const editor=page.getByRole('textbox',{name:'连续编辑正文',exact:true});
    const beforeBody=await editor.evaluate((el:any)=>el.editor.state.doc.firstChild.textContent);await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection(1);el.editor.view.focus();});await page.keyboard.insertText('独立正文');await expect.poll(()=>editor.evaluate((el:any)=>el.editor.state.doc.firstChild.textContent)).toBe('独立正文'+beforeBody);await page.keyboard.press('Meta+z');await expect.poll(()=>editor.evaluate((el:any)=>el.editor.state.doc.firstChild.textContent)).toBe(beforeBody);
    expect((await snapshot(page)).drawings[0]).toEqual(drawing);
    await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection({from:2,to:5});el.editor.view.focus();});await page.getByRole('button',{name:'批注所选文字',exact:true}).click();
    const note=page.getByRole('textbox',{name:'批注内容',exact:true});await note.fill('第一条理解');await note.fill('第二条理解');await note.press('Meta+z');await expect(note).toHaveValue('第一条理解');expect((await snapshot(page)).history).toHaveLength(1);
    await page.getByRole('button',{name:'关闭批注',exact:true}).click();
    const formula=page.locator('.editor-formula').first(),button=formula.getByRole('button',{name:'编辑公式',exact:true});
    const {revealControl}=await import('./reveal-control');await revealControl(page,button);await button.click();const field=formula.locator('math-field');const latex=await field.evaluate((el:any)=>el.getValue());await field.press('End');await field.press('q');await expect.poll(()=>field.evaluate((el:any)=>el.getValue())).not.toBe(latex);await field.press('Meta+z');await expect.poll(()=>field.evaluate((el:any)=>el.getValue())).toBe(latex);expect((await snapshot(page)).history).toHaveLength(1);
    await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();const composer=page.getByRole('textbox',{name:'学习对话草稿',exact:true});await composer.fill('尚未发送');await composer.press('End');await page.keyboard.insertText('追加');await expect(composer).toHaveValue('尚未发送追加');await composer.press('Meta+z');await expect(composer).toHaveValue('尚未发送');expect((await snapshot(page)).history).toHaveLength(1);
    await page.getByRole('button',{name:'收起对话',exact:true}).click();await expect(composer).toHaveCount(0);await expect(page.getByRole('button',{name:'Agent · 学习对话',exact:true})).toBeFocused();await page.locator('.drawing-layer').focus();await expect(page.locator('.drawing-layer')).toBeFocused();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await snapshot(page)).drawings[0].status).toBe('deleted');
  }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('actual save failure retains the unconfirmed shape, blocks normal close and retries the same gesture exactly once',async()=>{

  const root=await mkdtemp(join(tmpdir(),'yizhi-drawing-failure-')),app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});let fault:DatabaseSync|undefined;let complete=false;
  try{
    const page=await app.firstWindow();await resizeBoardWindow(app,page);await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    fault=openFaultDatabase(join(root,'course','course.sqlite'));fault.exec("CREATE TRIGGER drawing_ui_fail BEFORE INSERT ON drawing_operations BEGIN SELECT RAISE(ABORT,'drawing UI save failure'); END");
    await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByRole('button',{name:'个人箭头',exact:true}).click();const board=(await page.locator('main.board').boundingBox())!;await drag(page,board.x+450,board.y+150);
    await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('未保存');await expect(page.locator('.drawing-preview')).toHaveCount(1);expect((await snapshot(page)).history).toHaveLength(0);
    await app.evaluate(({BrowserWindow,ipcMain})=>{(globalThis as any).drawingCloseResult=null;ipcMain.once('window:close-result',(_event,result)=>{(globalThis as any).drawingCloseResult=result.saved;});BrowserWindow.getAllWindows()[0].close();});await expect.poll(()=>app.evaluate(()=>(globalThis as any).drawingCloseResult)).toBe(false);await expect(page.getByRole('button',{name:'重试保存绘图'})).toBeVisible();expect(app.windows()).toHaveLength(1);
    fault.exec('DROP TRIGGER drawing_ui_fail');await page.getByRole('button',{name:'重试保存绘图'}).click();await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    expect((await snapshot(page)).history).toHaveLength(1);expect((await snapshot(page)).drawings).toHaveLength(1);await expect(page.locator('.drawing-preview')).toHaveCount(0);
    await page.screenshot({path:evidencePath('t08-drawings-desktop.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(700,700));await page.getByRole('button',{name:'关闭目录',exact:true}).click();await page.screenshot({path:evidencePath('t08-drawings-narrow.png')});complete=true;
  }finally{fault?.exec('DROP TRIGGER IF EXISTS drawing_ui_fail');fault?.close();if(complete)await app.close();else app.process().kill('SIGKILL');await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});

test('object-coordinate marks follow a unit move; Space and middle drag pan during drawing without creating board content',async()=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-drawing-object-')),app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  let complete=false;
  try{
    const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByLabel('标注坐标',{exact:true}).selectOption('object');await page.getByRole('button',{name:'矩形',exact:true}).click();
    const article=(await page.locator('article[data-unit-id="KU-001"]').boundingBox())!;await drag(page,article.x+60,article.y+140,100,50);await expect(page.getByRole('status',{name:'绘图同步状态'})).toHaveText('已保存');
    const record=(await snapshot(page)).drawings[0];expect(record.value.anchor.space).toBe('object');const before=(await page.locator('[data-drawing-id] .drawing-ink').boundingBox())!;
    const move=page.getByRole('button',{name:'移动位置记数法与权展开'});await move.focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('status',{name:'布局状态'})).toHaveText('布局已保存');
    await expect.poll(async()=>(await page.locator('[data-drawing-id] .drawing-ink').boundingBox())!.x).toBeGreaterThan(before.x+10);expect((await snapshot(page)).drawings[0].value.geometry).toEqual(record.value.geometry);
    await page.getByLabel('标注坐标',{exact:true}).selectOption('board');await page.getByRole('button',{name:'直线',exact:true}).click();await page.locator('.drawing-layer').focus();
    const s=await snapshot(page),board=(await page.locator('main.board').boundingBox())!;
    const camera=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera;});
    await page.keyboard.down('Space');await drag(page,board.x+420,board.y+200,80,40);await page.keyboard.up('Space');
    expect((await snapshot(page)).history).toEqual(s.history);expect((await snapshot(page)).graph.layout).toEqual(s.graph.layout);
    await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera;})).not.toEqual(camera);
    await page.mouse.move(board.x+420,board.y+200);await page.mouse.down({button:'middle'});await page.mouse.move(board.x+470,board.y+250,{steps:6});await page.mouse.up({button:'middle'});expect((await snapshot(page)).history).toEqual(s.history);
    const zoomBefore=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera.zoom;});await page.keyboard.down('Meta');await page.mouse.wheel(0,-100);await page.keyboard.up('Meta');await expect.poll(()=>page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open();return (await b.readingState(c.sessionId)).camera.zoom;})).not.toBe(zoomBefore);expect((await snapshot(page)).history).toEqual(s.history);await page.locator('.drawing-layer').focus();await page.keyboard.press('Meta+z');await expect.poll(async()=>(await snapshot(page)).graph.layout.nodes.find((n:any)=>n.unitId==='KU-001').x).toBe(s.graph.layout.nodes.find((n:any)=>n.unitId==='KU-001').x-24);complete=true;
  }finally{if(complete)await app.close();else app.process().kill('SIGKILL');await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
});
