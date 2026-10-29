import type { DatabaseSync } from 'node:sqlite';
import { openFaultDatabase } from './fault-database';
import { test,expect,_electron as electron } from '@playwright/test';
import { mkdtemp,rm,access,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CourseService } from '../src/core/course-service';
import { resizeBoardWindow } from './board-test-helpers';
test('actual upgrade saves the last textbox input, publishes one checked directory, and reopening the original path rejoins v2',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-ui-')),source=join(root,'course'),target=join(root,'升级课程 中文');
 const launch=(profile:string)=>electron.launch({args:[resolve('.'),`--course=${source}`],env:{...process.env,YIZHI_DATA_HOME:join(root,profile),YIZHI_CODEX_PATH:join(root,'not-used')}});
 let app=await launch('profile');
 try{
  let page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();await page.getByRole('textbox',{name:'编辑首段正文',exact:true}).fill('升级前最后一次真实输入');
  await page.getByRole('button',{name:'备份与升级',exact:true}).click();await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},target);
  await page.getByRole('button',{name:'备份并升级课程',exact:true}).click();await expect(page.getByRole('status',{name:'课程格式',exact:true})).toHaveText('课程已升级');
  const opened=await page.evaluate(()=>window.yizhi.open());expect(opened.unit.reading.blocks[0].payload.text).toBe('升级前最后一次真实输入');expect(opened.courseFormat).toBe(2);await access(join(target+'.before-upgrade','backup-complete.json'));
  await resizeBoardWindow(app,page,700,700);
  const closeDirectory=page.getByRole('button',{name:'关闭目录',exact:true});
  const checkedAt=Date.now(),closeVisibleBeforeWait=await closeDirectory.isVisible();
  const responsiveBefore=await page.evaluate(()=>({time:performance.now(),width:innerWidth,media:matchMedia('(max-width:760px)').matches,
   headerInert:document.querySelector('.app-header')?.hasAttribute('inert'),closeInDOM:[...document.querySelectorAll('nav button')].some(e=>e.textContent==='关闭目录'),
   openDialogs:[...document.querySelectorAll('dialog')].filter(e=>e.open).map(e=>e.getAttribute('aria-label'))}));
  await writeFile(test.info().outputPath('upgrade-responsive-before-click.json'),JSON.stringify({checkedAt,closeVisibleBeforeWait,capturedAt:Date.now(),state:responsiveBefore},null,2));
  // Content dimensions can update before the responsive React close control mounts.
  await closeDirectory.click();
  await writeFile(test.info().outputPath('upgrade-responsive-after-close.json'),JSON.stringify(await page.evaluate(()=>({time:performance.now(),width:innerWidth,headerInert:document.querySelector('.app-header')?.hasAttribute('inert'),directory:!!document.querySelector('nav[aria-label="课程目录"]')})),null,2));
  await page.getByRole('button',{name:'备份与升级',exact:true}).click();const panel=page.getByRole('dialog',{name:'备份与升级',exact:true});await expect(panel).toContainText('课程格式已升级');expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:test.info().outputPath('upgrade-complete-narrow.png')});
  await app.close();app=await launch('fresh-profile');page=await app.firstWindow();await resizeBoardWindow(app,page);await expect(page.getByRole('status',{name:'课程格式',exact:true})).toHaveText('课程已升级');expect((await page.evaluate(()=>window.yizhi.open())).unit.reading.blocks[0].payload.text).toBe('升级前最后一次真实输入');
  await app.close();const core=new CourseService(resolve('dist/worker.cjs'));try{await core.backup.verify({directory:target+'.before-upgrade'});await expect(core.open(source)).rejects.toThrow(/迁移|目标|权威/);}finally{await core.close();}
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('failed latest-input save prevents any upgrade staging, preserves the input, and permits an explicit save retry',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-upgrade-save-fault-')),source=join(root,'course'),target=join(root,'checked upgrade');
 const app=await electron.launch({args:[resolve('.'),`--course=${source}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
 let fault:DatabaseSync|undefined,complete=false;
 try{
  const page=await app.firstWindow();await resizeBoardWindow(app,page);await page.getByRole('button',{name:'数制与数制转换',exact:true}).first().click();
  fault=openFaultDatabase(join(source,'course.sqlite'));fault.exec("CREATE TRIGGER upgrade_save_fault BEFORE UPDATE ON units BEGIN SELECT RAISE(ABORT,'latest input disk fault'); END");
  await page.getByRole('textbox',{name:'编辑首段正文',exact:true}).fill('升级失败时仍需保留的最后输入');await page.getByRole('button',{name:'备份与升级',exact:true}).click();
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},target);
  await page.getByRole('button',{name:'备份并升级课程',exact:true}).click();await expect(page.getByRole('dialog',{name:'备份与升级',exact:true}).getByRole('alert')).toContainText('最新输入尚未确认保存');
  expect(await access(target).then(()=>true,()=>false)).toBe(false);expect(await access(target+'.before-upgrade').then(()=>true,()=>false)).toBe(false);
  await page.getByRole('button',{name:'返回课程',exact:true}).click();await expect(page.getByRole('textbox',{name:'编辑首段正文',exact:true})).toHaveText('升级失败时仍需保留的最后输入');
  fault.exec('DROP TRIGGER upgrade_save_fault');fault.close();fault=undefined;await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.getByRole('button',{name:'备份与升级',exact:true}).click();await page.getByRole('button',{name:'备份并升级课程',exact:true}).click();
  await expect(page.getByRole('status',{name:'课程格式',exact:true})).toHaveText('课程已升级');expect((await page.evaluate(()=>window.yizhi.open())).unit.reading.blocks[0].payload.text).toBe('升级失败时仍需保留的最后输入');complete=true;
 }finally{fault?.exec('DROP TRIGGER IF EXISTS upgrade_save_fault');fault?.close();if(complete)await app.close();else app.process().kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
