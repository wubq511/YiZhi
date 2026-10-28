import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsingFixture } from './parsing-fixture';
import { resizeBoardWindow } from './board-test-helpers';

test('generation request fixes a confirmed source page while the composer stays usable at both window sizes',async({},testInfo)=>{
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-ui-'));
  const path=join(root,'source.pdf');await parsingFixture(path);
  const fixture=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(fixture,0o755);
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],
    env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:fixture,YIZHI_FIXTURE_MODE:'steer-retry'}});
  try{
    const page=await app.firstWindow();
    await app.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},path);
    await page.getByRole('button',{name:'原文资料',exact:true}).click();
    await page.getByRole('button',{name:'导入资料',exact:true}).click();
    await expect(page.getByRole('status',{name:'原文状态'})).toHaveText('原页已载入');
    await page.getByText('解析此资料',{exact:true}).click();
    await page.getByRole('button',{name:'开始解析此版本',exact:true}).click();
    await expect(page.getByRole('status',{name:'解析进度'})).toContainText('已完成 · 已确认 2 / 2 页');
    await page.getByRole('button',{name:'返回画板',exact:true}).click();
    await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();
    await page.getByRole('combobox',{name:'Agent 请求方式'}).selectOption('generate');
    const source=page.getByRole('combobox',{name:'生成来源 PDF'});
    await expect(source.locator('option')).toHaveCount(2);
    await source.selectOption({index:1});
    const pageChoice=page.getByRole('combobox',{name:'生成来源页'});
    await expect(pageChoice.locator('option')).toHaveCount(3);
    await pageChoice.selectOption({index:1});
    for(const [width,height] of [[1024,688],[700,700]]){
      await resizeBoardWindow(app,page,width,height);
      const metrics=await page.evaluate(()=>{
        const panel=document.querySelector<HTMLElement>('.agent-panel')!,messages=document.querySelector<HTMLElement>('.agent-messages')!;
        const composer=document.querySelector<HTMLElement>('.agent-composer')!;
        return {panelHeight:panel.getBoundingClientRect().height,messageHeight:messages.getBoundingClientRect().height,
          composerScrollHeight:composer.scrollHeight,composerClientHeight:composer.clientHeight,
          sourceWidth:document.querySelector<HTMLElement>('.agent-generation-source')!.getBoundingClientRect().width};
      });
      expect(metrics.messageHeight).toBeGreaterThan(100);
      expect(metrics.sourceWidth).toBeGreaterThan(240);
      expect(metrics.composerScrollHeight).toBeGreaterThanOrEqual(metrics.composerClientHeight);
      const screenshot=testInfo.outputPath(`generation-source-${width}x${height}.png`);
      await page.screenshot({path:screenshot});await testInfo.attach(`generation-source-${width}x${height}`,{path:screenshot,contentType:'image/png'});
    }
    await page.getByRole('textbox',{name:'学习对话草稿'}).fill('根据选定原页建立四选一单通道小主题，提供必要推导、完整例题和带答案的练习。');
    await page.getByRole('button',{name:'生成小主题',exact:true}).click();
    const captured=await page.evaluate(async()=>{
      const api=window.yizhi,opened=await api.open(),list=await api.agent.list({sessionId:opened.sessionId});
      const view=await api.agent.get({sessionId:opened.sessionId,conversationId:list.selectedId!});
      const versions=await api.sources.list({sessionId:opened.sessionId});
      const version=versions.versions.at(-1)!;
      const artifacts=await api.parsing.artifacts({sessionId:opened.sessionId,versionId:version.versionId});
      return {task:view.tasks.at(-1)!,version,artifact:artifacts.find(r=>r.pdfPageIndex===0)!};
    });
    expect(captured.task.snapshot.intent).toBe('generate');
    expect(captured.task.snapshot.generationSpec?.sourceVersionId).toBe(captured.version.versionId);
    expect(captured.task.snapshot.generationSpec?.artifactId).toBe(captured.artifact.artifactId);
    expect(captured.task.snapshot.generationSpec?.pdfPageIndex).toBe(0);
    expect(captured.task.snapshot.generationSpec?.unitId).not.toBe('KU-001');
    expect(captured.task.generationProgress?.pendingStages).toContain('lesson');
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
