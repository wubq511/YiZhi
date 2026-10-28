import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CourseService } from '../src/core/course-service';
test('unsupported body version exposes only understood readonly text and explicit text export while preserving unknown bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-format-ui-')),directory=join(root,'course'),core=new CourseService(resolve('dist/worker.cjs'));
 const c=await core.open(directory),known=await core.read(c.sessionId,'KU-002');await core.close();
 const db=new DatabaseSync(join(directory,'course.sqlite')),unit=JSON.parse(String(db.prepare("SELECT payload FROM units WHERE id='KU-001'").get()!.payload));unit.reading.schemaVersion='future-reading-999';unit.unknown={keep:'Unknown original payload'};db.prepare("UPDATE units SET payload=? WHERE id='KU-001'").run(JSON.stringify(unit));db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
 const before=await readFile(join(directory,'course.sqlite'));
 const app=await electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
 try{
  const page=await app.firstWindow(),panel=page.getByRole('region',{name:'兼容范围只读',exact:true});await expect(panel).toBeVisible();
  await expect(panel).toContainText('拒绝写入');await expect(panel.getByLabel('可读取单元')).toHaveValue('KU-002');
  await expect(panel.getByRole('option')).toHaveCount(1);await expect(panel.getByRole('region',{name:'只读文本与公式'})).not.toBeEmpty();
  await expect(page.getByRole('textbox',{name:'编辑首段正文',exact:true})).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:'课程目录'})).toHaveCount(0);
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},join(directory,'course.sqlite'));
  await panel.getByRole('button',{name:'导出此单元文本与公式',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('课程目录之外');
  expect(await readFile(join(directory,'course.sqlite'))).toEqual(before);
  const output=join(root,'可解释文本.txt');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},output);
  await panel.getByRole('button',{name:'导出此单元文本与公式',exact:true}).click();await expect(panel.getByRole('status')).toContainText('文本与公式已导出');
  const exported=await readFile(output,'utf8');expect(exported).toContain(known.unit.name);expect(exported).not.toContain('Unknown original payload');
  const size=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(700,700);return w.getContentSize();});await expect.poll(()=>page.evaluate(()=>[innerWidth,innerHeight])).toEqual(size);
  await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  const bounds=await panel.evaluate(el=>{const r=el.getBoundingClientRect(),h=document.querySelector('.app-header')!.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,headerBottom:h.bottom,width:innerWidth,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};});
  expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(bounds.width);expect(bounds.top).toBeGreaterThanOrEqual(bounds.headerBottom);expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth+1);
  await test.info().attach('readonly-render-facts',{body:JSON.stringify(bounds),contentType:'application/json'});await page.screenshot({path:test.info().outputPath('format-readonly-settled.png')});
 }finally{let after:Buffer;try{await app.close();after=await readFile(join(directory,'course.sqlite'));}finally{await rm(root,{recursive:true,force:true});}expect(after).toEqual(before);}
});
