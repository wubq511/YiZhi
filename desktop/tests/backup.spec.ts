import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm,access,readFile,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resizeBoardWindow } from './board-test-helpers';
import { CourseService } from '../src/core/course-service';
import { sourceFixture } from './source-fixture';
test('manual full backup reports completion only after verification and opens in a fresh application profile',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-ui-')),directory=join(root,'course'),destination=join(root,'完整备份 中文');
 const core=new CourseService(resolve('dist/worker.cjs')),c=await core.open(directory);await core.save({...c,operationId:'ui-backup-body',inputSeq:1,baseRevision:1,blockId:c.editableBlockId,text:'独立备份保留的正文'});await core.close();
 let app=await electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);
  await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
  await page.getByRole('textbox',{name:'编辑首段正文',exact:true}).fill('备份前最后一次输入必须保留');
  await page.getByRole('button',{name:'完整备份',exact:true}).click();const panel=page.getByRole('dialog',{name:'完整备份',exact:true});
  await expect(panel).toContainText('完整备份');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},destination);
  await panel.getByRole('button',{name:'新建完整备份',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('完整备份已完成');await access(join(destination,'backup-complete.json'));
  await resizeBoardWindow(app,page,700,700);expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:test.info().outputPath('backup-complete-narrow.png')});
  await panel.getByRole('button',{name:'返回课程',exact:true}).click();await expect(page.getByRole('button',{name:'完整备份',exact:true})).toBeFocused();
  await app.close();
  app=await electron.launch({args:[resolve('.'),`--course=${destination}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'independent-profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
  page=await app.firstWindow();await resizeBoardWindow(app,page);
  const saved=await page.evaluate(async()=>window.yizhi.open());expect(saved.courseId).toBe(c.courseId);expect(saved.unit.reading.blocks[0].payload.text).toBe('备份前最后一次输入必须保留');
  await page.screenshot({path:test.info().outputPath('backup-independent-app.png')});
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('missing fixed source never shows success; reopening the app retries the same durable snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-backup-fault-ui-')),directory=join(root,'course'),destination=join(root,'未完成备份');
 const core=new CourseService(resolve('dist/worker.cjs')),c=await core.open(directory),path=join(root,'source.pdf');await sourceFixture(path);
 const version=(await core.sources.importFile({...c,operationId:'ui-required-source',path,title:'Required fixed PDF'})).version;
 await core.close();const resource=join(directory,'resources',version.sha256),original=await readFile(resource);await rm(resource);
 const launch=()=>electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
 let app=await launch();
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'完整备份',exact:true}).click();
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},destination);
  await page.getByRole('button',{name:'新建完整备份',exact:true}).click();await expect(page.getByRole('alert')).toContainText('备份未完成');
  await expect(page.getByRole('dialog',{name:'完整备份',exact:true}).getByRole('status')).not.toContainText('完整备份已完成');await assertMissing(join(destination,'backup-complete.json'));
  const before=JSON.parse(await readFile(join(destination,'backup-manifest.json'),'utf8'));
  await page.screenshot({path:test.info().outputPath('backup-missing-source.png')});await app.close();await writeFile(resource,original);
  app=await launch();page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'完整备份',exact:true}).click();
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},destination);
  await page.getByRole('button',{name:'继续未完成备份',exact:true}).click();await expect(page.getByRole('dialog',{name:'完整备份',exact:true}).getByRole('status')).toContainText('完整备份已完成');
  const after=JSON.parse(await readFile(join(destination,'backup-manifest.json'),'utf8'));expect(after.snapshot).toEqual(before.snapshot);expect(after.resources).toEqual(before.resources);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
async function assertMissing(path:string){expect(await access(path).then(()=>false,()=>true)).toBe(true);}
