import { test, expect, _electron as electron } from '@playwright/test';
import { cp, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsingFixture } from './parsing-fixture';
import { resizeBoardWindow } from './board-test-helpers';
import { CourseService } from '../src/core/course-service';

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

test('a controlled unfinished source candidate stays readable after reopen with explicit continuation',async({},testInfo)=>{
  test.skip(!process.env.YIZHI_T30_PREPARED_COURSE,'requires the independently prepared official source copy');
  const root=await mkdtemp(join(tmpdir(),'yizhi-generation-candidate-ui-')),directory=join(root,'course');
  await cp(process.env.YIZHI_T30_PREPARED_COURSE!,directory,{recursive:true});
  const core=new CourseService(resolve('dist/worker.cjs'));
  try{
    const opened=await core.open(directory),sessionId=opened.sessionId;
    const source=(await core.sources.list({sessionId})).versions.find(v=>v.sha256==='597f9aa76565c7179a7d265e7d12121e1910613dc1dd04cae1d24958c1795caa')!;
    const artifact=(await core.parsing.artifacts({sessionId,versionId:source.versionId})).filter(ref=>ref.pdfPageIndex===8).at(-1)!;
    const conversation=await core.agent.create({sessionId,operationId:'candidate-ui-conversation'});
    const task=await core.agent.submit({sessionId,conversationId:conversation.id,operationId:'candidate-ui-request',generation:1,intent:'generate',
      target:{unitId:'KU-001'},text:'从选定来源建立一个完整小主题。',generationSpec:{unitId:'KU-GEN-CANDIDATE-UI',themeId:'TH-GEN-CANDIDATE-UI',themeName:'四选一数据选择',sourceVersionId:source.versionId,artifactId:artifact.artifactId,pdfPageIndex:8}});
    const identity={sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation},basis=await core.readAgentGeneration(identity);
    const result=await core.publishAgentGeneration({...identity,input:{operationId:'unfinished-ui-proposal',basisId:basis.basisId,stage:'lesson',
      title:'草稿中的选择主题',intro:'这份受控候选故意缺少完整目标、推导和例练，必须保持为未发布草稿。',evidence:basis.evidenceIds}});
    expect(result.status).toBe('retained');
    await core.agent.stop({sessionId,taskId:task.id});
    await core.recordAgent({...identity,eventId:'candidate-ui-stop',kind:'finish',status:'interrupted',reconciliation:true});
  }finally{await core.close();}
  const fixture=resolve('dist/tests/agent-executor-fixture.cjs');await chmod(fixture,0o755);
  const app=await electron.launch({args:[resolve('.'),`--course=${directory}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:fixture,YIZHI_FIXTURE_MODE:'steer-retry'}});
  try{
    const page=await app.firstWindow();
    await page.getByRole('button',{name:'Agent · 学习对话',exact:true}).click();
    const progress=page.getByRole('region',{name:'小主题生产进度'});
    await expect(progress).toContainText('已确认：暂无；待完成：完整讲解、追加练习');
    await expect(page.getByRole('button',{name:'继续剩余工作',exact:true})).toBeVisible();
    await progress.getByText('查看未完成候选与校验',{exact:true}).click();
    await expect(progress.getByText('完整讲解 · 草稿未发布',{exact:true})).toBeVisible();
    await progress.getByText('阅读草稿和逐项结果',{exact:true}).click();
    await expect(progress.getByRole('heading',{name:'草稿中的选择主题'})).toBeVisible();
    await expect(progress).toContainText('内容结构 · 未通过');
    const typography=await progress.locator('.agent-generation-candidate p').first().evaluate(element=>{
      const style=getComputedStyle(element);return {size:parseFloat(style.fontSize),family:style.fontFamily};
    });
    expect(typography.size).toBeLessThanOrEqual(16);
    expect(typography.family).not.toMatch(/ReviewExcalifont|PrototypeXiaolai/);
    for(const [width,height] of [[1024,688],[700,700]]){
      await resizeBoardWindow(app,page,width,height);
      await progress.getByRole('heading',{name:'草稿中的选择主题'}).scrollIntoViewIfNeeded();
      const screenshot=testInfo.outputPath(`generation-candidate-${width}x${height}.png`);
      await page.screenshot({path:screenshot});await testInfo.attach(`generation-candidate-${width}x${height}`,{path:screenshot,contentType:'image/png'});
    }
    const formal=await page.evaluate(async()=>{const opened=await window.yizhi.open();return {unitId:opened.unit.id,hasCandidate:(await window.yizhi.graph(opened.sessionId)).nodes.some(node=>node.id==='KU-GEN-CANDIDATE-UI')};});
    expect(formal).toEqual({unitId:'KU-001',hasCandidate:false});
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
