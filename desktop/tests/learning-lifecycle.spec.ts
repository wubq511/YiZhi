import { test,expect,_electron as electron } from '@playwright/test';
import type { ElectronApplication,Page } from '@playwright/test';
import { mkdtemp,rm,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { DatabaseSync } from 'node:sqlite';
import { resizeBoardWindow,revealBoardControl } from './board-test-helpers';
async function resize(app:ElectronApplication,page:Page){await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');const handle=await app.browserWindow(page);const size=await handle.evaluate(w=>{w.setSize(1024,688);return w.getContentSize();});await expect.poll(()=>page.evaluate(()=>[innerWidth,innerHeight])).toEqual(size);}
async function choose(app:ElectronApplication,directory:string){await app.evaluate(({dialog,Menu},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});const menu=Menu.getApplicationMenu()!.items.find(i=>i.label==='课程')!.submenu!.items[0];menu.click(undefined,undefined,undefined);},directory);}
async function body(page:Page,text:string){await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();const editor=page.getByRole('textbox',{name:'连续编辑正文',exact:true});await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection({from:1,to:el.editor.state.doc.firstChild.nodeSize-1});el.editor.view.focus();});await page.keyboard.insertText(text);}
async function composer(page:Page,text:string){await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();await page.getByRole('textbox',{name:'学习对话草稿'}).fill(text);}

test('explicit quit collects actual latest input in both course windows, rejects a failed barrier, preserves both scenes, then saves and reopens both authorities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-multi-quit-')),cli=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(cli,0o755);
 const dirs=[join(root,'first'),join(root,'second')];const launch=()=>electron.launch({args:[resolve('.'),`--course=${dirs[0]}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:cli}});
 let app=await launch();let stage='launch';let fault:DatabaseSync|undefined;
 try {
  console.log(stage);const first=await app.firstWindow();await resizeBoardWindow(app,first);
  const next=app.waitForEvent('window');await choose(app,dirs[1]);const second=await next;await resize(app,second);
  stage='both windows open';console.log(stage);await choose(app,dirs[1]);await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length)).toBe(2);expect(app.windows()).toHaveLength(2);
  const ids=await Promise.all([first,second].map(p=>p.evaluate(async()=>(await (window as any).yizhi.open()).courseId)));expect(ids[0]).not.toBe(ids[1]);
  stage='edit first';console.log(stage);await first.bringToFront();await body(first,'第一课程最新正文尾部');await composer(first,'第一课程最新对话尾部');
  stage='edit second';console.log(stage);await second.bringToFront();await body(second,'第二课程最新正文尾部');await composer(second,'第二课程旧草稿');
  await expect(second.getByRole('status',{name:'对话草稿保存'})).toHaveText('草稿已保存');
  fault=new DatabaseSync(join(dirs[1],'course.sqlite'));fault.exec("CREATE TRIGGER lifecycle_save_failure BEFORE UPDATE OF draft ON agent_conversations BEGIN SELECT RAISE(ABORT,'latest composer disk fault'); END");
  await second.getByRole('textbox',{name:'学习对话草稿'}).fill('第二课程失败现场新尾部');
  stage='failed quit';console.log(stage);await app.evaluate(({dialog,app})=>{dialog.showErrorBox=(title,content)=>{(globalThis as any).lastLifecycleError={title,content};};app.quit();});
  await expect.poll(()=>app.evaluate(()=>((globalThis as any).lastLifecycleError)?.title)).toBe('退出未完成');
  expect(app.windows()).toHaveLength(2);
  await expect(second.getByRole('textbox',{name:'学习对话草稿'})).toHaveValue('第二课程失败现场新尾部');
  await expect.poll(()=>first.evaluate(()=>document.body.inert)).toBe(false);await expect.poll(()=>second.evaluate(()=>document.body.inert)).toBe(false);
  await first.bringToFront();await first.getByRole('textbox',{name:'学习对话草稿'}).fill('第一课程取消退出后的新尾部');
  fault.exec('DROP TRIGGER lifecycle_save_failure');fault.close();fault=undefined;
  await second.bringToFront();await second.getByRole('button',{name:'重试保存对话草稿',exact:true}).click();
  stage='successful quit';console.log(stage);const exited=app.waitForEvent('close');await app.evaluate(({app})=>app.quit());await exited;
  stage='verify both databases';console.log(stage);const core=new CourseService(resolve('dist/worker.cjs'));
  try{for(let i=0;i<2;i++){const c=await core.open(dirs[i]);expect(c.unit.reading.blocks[0].payload.text).toBe(i?'第二课程最新正文尾部':'第一课程最新正文尾部');const list=await core.agent.list({sessionId:c.sessionId}),v=await core.agent.get({sessionId:c.sessionId,conversationId:list.selectedId!});expect(v.draft.text).toBe(i?'第二课程失败现场新尾部':'第一课程取消退出后的新尾部');}}
  finally{await core.close();}
  stage='relaunch';console.log(stage);app=await launch();const reopened=await app.firstWindow();await resizeBoardWindow(app,reopened);await composer(reopened,'第一课程取消退出后的新尾部');
  await expect(reopened.getByText('上次窗口异常结束。',{exact:false})).toHaveCount(0);
 }finally{console.log('cleanup stage',stage);if(fault){fault.exec('DROP TRIGGER IF EXISTS lifecycle_save_failure');fault.close();}for(const page of app.windows()){const retry=page.getByRole('button',{name:'重试保存对话草稿',exact:true});if(await retry.count())await retry.click().catch(()=>{});}await app.close();await rm(root,{recursive:true,force:true});}
});


test('normal learning-window close confirms body, incomplete MathLive formula, personal note, drawing and the latest composer before destroying the renderer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-all-inputs-')),app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:resolve('dist/tests/agent-executor-fixture.cjs')}});
 try {
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'绘图标注',exact:true}).click();await page.getByRole('button',{name:'矩形',exact:true}).click();
  const board=(await page.locator('main.board').boundingBox())!;await page.mouse.move(board.x+300,board.y+140);await page.mouse.down();await page.mouse.move(board.x+380,board.y+200,{steps:4});await page.mouse.up();
  await page.getByRole('button',{name:'绘图标注',exact:true}).click();
  await body(page,'关窗时必须保留的正文');
  const editor=page.getByRole('textbox',{name:'连续编辑正文',exact:true});
  await editor.evaluate((el:any)=>{el.editor.commands.setTextSelection({from:1,to:5});el.editor.view.focus();});
  await page.getByRole('button',{name:'批注所选文字',exact:true}).click();await page.getByRole('textbox',{name:'批注内容',exact:true}).fill('关窗时必须保留的个人批注');
  await page.getByRole('button',{name:'关闭批注',exact:true}).click();
  const formula=page.locator('.editor-formula').first();await revealBoardControl(page,formula.getByRole('button',{name:'编辑公式',exact:true}));await formula.getByRole('button',{name:'编辑公式',exact:true}).click();
  const original=await page.evaluate(async()=>(await (window as any).yizhi.open()).unit.reading.blocks.find((b:any)=>b.kind==='formula'));
  await formula.locator('math-field').evaluate((el:any)=>{el.executeCommand('selectAll');el.executeCommand(['insert','\\frac{1}{#?}']);});
  await composer(page,'关窗时必须保留的最新对话尾部');
  const next=app.waitForEvent('window');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await expect.poll(()=>app.windows().length).toBe(0);
  await app.evaluate(({app})=>app.emit('activate'));page=await next;await resizeBoardWindow(app,page);
  const saved=await page.evaluate(async()=>{const b=(window as any).yizhi,c=await b.open(),l=await b.agent.list(c);return {c,notes:await b.annotations.list(c),drawings:await b.drawings.list(c),conversation:await b.agent.get({...c,conversationId:l.selectedId})};});
  expect(saved.c.unit.reading.blocks[0].payload.text).toBe('关窗时必须保留的正文');
  expect(saved.c.unit.reading.blocks.find((b:any)=>b.id===original.id).payload.latex).toBe(original.payload.latex);
  expect(saved.c.drafts.some((d:any)=>d.input.formulaDrafts?.some((f:any)=>f.blockId===original.id && f.latex.includes('placeholder')))).toBe(true);
  expect(saved.notes[0].text).toBe('关窗时必须保留的个人批注');expect(saved.drawings).toHaveLength(1);expect(saved.drawings[0].value.kind).toBe('rectangle');
  expect(saved.conversation.draft.text).toBe('关窗时必须保留的最新对话尾部');
  if(process.env.YIZHI_EVIDENCE_DIR)await page.screenshot({path:join(process.env.YIZHI_EVIDENCE_DIR,'t19-all-inputs-reopen.png')});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
