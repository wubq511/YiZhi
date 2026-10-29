import { developmentDirectory } from '../../tools/desktop/paths.mjs';
import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page, Locator } from '@playwright/test';
import { legacyFixture } from './migration-fixture';
import { DevelopmentCourseService as CourseService } from '../../tools/desktop/course-service';

async function reveal(page: Page, target: Locator) {
  await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
  const board=(await page.locator('main.board').boundingBox())!;
  await page.mouse.move(board.x+10,board.y+board.height/2);
  for(let i=0;i<60;i++) {const box=(await target.boundingBox())!,delta=box.y-board.y-board.height/2;if(Math.abs(delta)<board.height/3)return;await page.mouse.wheel(0,Math.max(-500,Math.min(500,delta)));await page.waitForTimeout(30);}
  throw new Error('课程图片未能进入实际阅读视口');
}

test('converted last unit and actual fixed image/source PDF remain readable offline in Electron at a moved path', async () => {
  const root = await mkdtemp(join(tmpdir(),'yizhi-migration-ui-'));
  const core = new CourseService(join(developmentDirectory(), 'worker.cjs'));
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const { rename } = await import('node:fs/promises');
    const source=join(root,'source'),candidate=join(root,'candidate'),moved=join(root,'独立 课程');
    await legacyFixture(source);
    await core.migration.convert({sourceDirectory:source,directory:candidate}); await core.close();
    await rename(candidate,moved); await rm(source,{recursive:true});
    app=await electron.launch({args:[resolve('.'),`--course=${moved}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
    await app.evaluate(async ({session})=>{await session.defaultSession.clearCache();});
    const page=await app.firstWindow(); await page.context().setOffline(true);
    await page.getByRole('button',{name:'末主题',exact:true}).first().click();
    const article=page.locator('article[data-unit-id="KU-086"]');
    await expect(article).toContainText('末单元完整正文');
    const image=article.getByRole('img',{name:'实际固定来源第一页'});
    await expect(image).toHaveAttribute('src',/^yizhi-resource:/);
    await expect.poll(()=>image.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth)).toBeGreaterThan(100);
    await expect(article).toContainText('据题干推导');
    await article.getByText('答案与步骤',{exact:true}).click({force:true});
    await expect(article).toContainText('未知原始载荷');
    const registered=await page.evaluate(async()=>{const c=await window.yizhi.open();return window.yizhi.sources.page({sessionId:c.sessionId,versionId:'VER-TEST',pdfPageIndex:0});});
    expect(registered.projection.text).toContain('Fixed legacy source');
    // Exercise the actual fixed version entry, existing PDF.js canvas and text layer.
    const fixedPage=article.getByRole('button',{name:'查看固定原页',exact:true});
    await reveal(page,fixedPage); await fixedPage.click();
    await expect(page.locator('.source-pdf .textLayer')).toContainText('Fixed legacy source');
    await expect(page.locator('.source-pdf canvas')).toBeVisible();
    await page.screenshot({path:test.info().outputPath('fixture-offline.png')});
    await page.getByRole('button',{name:'返回画板',exact:true}).click();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(700,700));
    await page.screenshot({path:test.info().outputPath('fixture-narrow.png')});
  } finally {await core.close();if(app){const child=app.process();await app.close();child.kill('SIGKILL');}await rm(root,{recursive:true,force:true});}
});

test('actual 84-unit candidate reads every persisted body and image offline, including original PDFs and all seven experiments', async () => {
  test.skip(!process.env.YIZHI_CONTENT_CANDIDATE, 'Private current corpus acceptance is explicit and external; CI uses generated fixture above.');
  const { readFile }=await import('node:fs/promises');
  const candidate=process.env.YIZHI_CONTENT_CANDIDATE!;
  const evidenceDirectory=process.env.YIZHI_CONTENT_EVIDENCE ?? test.info().outputDir;
  const root=await mkdtemp(join(tmpdir(),'yizhi-actual-content-ui-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${candidate}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    await app.evaluate(async({session})=>{await session.defaultSession.clearCache();});
    const page=await app.firstWindow();await page.context().setOffline(true);
    const report=JSON.parse(await readFile(join(candidate,'content-candidate.json'),'utf8'));
    const evidence=await page.evaluate(async expected=>{
      const c=await window.yizhi.open(),g=await window.yizhi.graph(c.sessionId);
      const units=[] as any[],experiments=[] as any[];
      for(const node of g.nodes){const u=await window.yizhi.readUnit(c.sessionId,node.id);units.push(u);
        const walk=async(blocks:any[])=>{for(const b of blocks){if(b.kind==='interactive')experiments.push(await window.yizhi.experiments.open({sessionId:c.sessionId,unitId:u.id,blockId:b.id}));if(b.children)await walk(b.children);}};await walk(u.reading.blocks);
      }
      const images=[] as any[];
      for(const r of expected.resources.filter((r:any)=>r.mediaType.startsWith('image/'))){const response=await fetch(`yizhi-resource://course/${c.sessionId}/content/${encodeURIComponent(r.asset)}`);if(!response.ok)throw new Error('image failed '+r.asset);const bytes=await response.arrayBuffer(),bitmap=await createImageBitmap(new Blob([bytes],{type:r.mediaType}));const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');images.push({asset:r.asset,sha256:hash,width:bitmap.width,height:bitmap.height});bitmap.close();}
      const versions=(await window.yizhi.sources.list({sessionId:c.sessionId})).versions;const pages=[];
      for(const v of versions){const p=await window.yizhi.sources.page({sessionId:c.sessionId,versionId:v.versionId,pdfPageIndex:0});pages.push({versionId:v.versionId,view:p.view,textLength:p.projection.text.length});}
      return{units,images,pages,experiments};
    },report);
    expect(evidence.units).toHaveLength(84);expect(evidence.experiments).toHaveLength(7);expect(evidence.pages).toHaveLength(16);
    const {createHash}=await import('node:crypto');
    for(const unit of evidence.units){const {theme,...raw}=unit;expect(createHash('sha256').update(JSON.stringify(raw)).digest('hex')).toBe(report.unitHashes[unit.id]);}
    for(const image of evidence.images)expect(image.sha256).toBe(report.resources.find((r:any)=>r.asset===image.asset).sha256);
    // A late course unit, not a permanent sample, drives actual canvas navigation.
    await page.getByRole('button',{name:'逻辑门器件理论',exact:true}).first().click();
    await expect(page.locator('article[data-unit-id="KU-078"]')).toContainText('二极管');
    const images=page.locator('article[data-unit-id="KU-078"] img');
    await expect(images.first()).toHaveAttribute('src',/^yizhi-resource:/);
    await expect.poll(()=>images.first().evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth)).toBeGreaterThan(100);
    await reveal(page,images.first());
    await expect(images.first()).toBeInViewport();
    await page.screenshot({path:join(evidenceDirectory,'t24-corpus-reading.png')});
    await page.getByRole('button',{name:'原文资料',exact:true}).click();
    await page.getByLabel('资料版本',{exact:true}).selectOption('VER-SRC-C02-1c152428693e');
    await expect(page.getByRole('status',{name:'原文状态'})).toContainText('原页已载入');
    await expect(page.locator('.source-pdf canvas')).toBeVisible();
    await page.screenshot({path:join(evidenceDirectory,'t24-corpus-pdf.png')});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(700,700));
    await page.screenshot({path:join(evidenceDirectory,'t24-corpus-narrow.png')});
    const {writeFile}=await import('node:fs/promises');
    await writeFile(join(evidenceDirectory,'t24-electron-corpus-evidence.json'),JSON.stringify({...evidence,units:evidence.units.map(u=>({id:u.id,blocks:u.reading.blocks.length})),runtime:await app.evaluate(()=>process.versions)},null,2));
  } finally {const child=app.process();await app.close();child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
