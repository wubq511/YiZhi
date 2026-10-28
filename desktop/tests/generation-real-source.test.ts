import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { AgentRuntime } from '../src/agent/executor';

const prepared=process.env.YIZHI_T30_PREPARED_COURSE;
const runModel=process.env.YIZHI_T30_ACTUAL_MODEL==='1';

test('real original parsed TI source drives the bounded Core read and, when requested, actual app-server generation',
  {skip:!prepared},async()=>{
    const root=await mkdtemp(join(tmpdir(),'yizhi-t30-actual-'));
    let core=new CourseService(resolve('dist/worker.cjs'));
    let runtime:AgentRuntime|undefined;
    try {
      const directory=join(root,'course');await cp(prepared!,directory,{recursive:true});
      const opened=await core.open(directory),sessionId=opened.sessionId;
      const source=(await core.sources.list({sessionId})).versions.find(v=>v.sha256==='597f9aa76565c7179a7d265e7d12121e1910613dc1dd04cae1d24958c1795caa');
      assert.ok(source,'official TI source must be selected by current public API');
      const refs=await core.parsing.artifacts({sessionId,versionId:source.versionId});
      const page=refs.filter(r=>r.pdfPageIndex===8).at(-1);
      assert.ok(page,'actual T29 page 9 artifact');
      const unitId='KU-GEN-TI-'+Math.random().toString(36).slice(2,10).toUpperCase();
      const spec={unitId,themeId:'TH-GEN-TI-'+unitId.slice(-8),themeName:'四选一数据选择',sourceVersionId:source.versionId,artifactId:page.artifactId,pdfPageIndex:8};
      const conversation=await core.agent.create({sessionId,operationId:'t30-actual-conversation'});
      const request={sessionId,conversationId:conversation.id,operationId:'t30-actual-submit',generation:1,
        text:'请依据 TI SN74HC153 原页第9页已解析的表，仅为 Gbar=0 的一个通道建立完整四选一数据选择小主题。',
        target:{unitId:'KU-001'},intent:'generate' as const,generationSpec:spec,model:'gpt-6-luna'};
      if(!runModel){
        const task=await core.agent.submit(request);
        const context=await core.readAgentGeneration({sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation});
        assert.equal(context.sourceTable.length,8);
        assert.equal(context.artifact.structureRole,null);
        assert.equal(context.sourceText.length,97);
        assert.deepEqual(context.pendingStages,['lesson','practice']);
        assert.deepEqual((await core.read(sessionId)).unit,opened.unit);
      }else{
        runtime=new AgentRuntime(core,{directory:join(root,'agent'),cliPath:'/opt/homebrew/bin/codex'});
        const status=await runtime.status();assert.equal(status.available,true,status.error);
        assert.ok(status.models.some(m=>m.model===request.model),'selected actual model is listed by local app-server');
        const task=await runtime.submit(request);
        let last=task;
        let settledWaitingPolls=0;
        for(let i=0;i<300;i++){
          last=await core.agentTask({sessionId,taskId:task.id});
          if(['completed','partial','failed','interrupted','unknown','stopped'].includes(last.status) ||
            last.status==='waiting' && last.executorStatus==='completed' && ++settledWaitingPolls>=12)break;
          if(last.status!=='waiting'||last.executorStatus!=='completed')settledWaitingPolls=0;
          if(i===299)throw new Error(`actual model did not settle: ${JSON.stringify({status:last.status,groups:last.groups?.map(g=>g.status),error:last.error})}`);
          await new Promise(done=>setTimeout(done,1000));
        }
        assert.equal(last.status,'completed',JSON.stringify({status:last.status,groups:last.groups,errors:last.toolErrors,error:last.error}));
        assert.deepEqual(last.groups?.map(g=>g.status),['committed','committed']);
        const unit=await core.readUnit(sessionId,unitId);
        assert.equal(unit.reading.blocks.filter(b=>b.kind==='exercise').length,2);
        assert.equal((await core.graph(sessionId)).nodes.filter(n=>n.id===unitId).length,1);
        assert.equal((await core.commands.history({sessionId})).filter(h=>h.taskId===task.id).length,2);
        await runtime.close();runtime=undefined;
        await core.close();core=new CourseService(resolve('dist/worker.cjs'));
        const reopened=await core.open(directory);
        assert.equal((await core.readUnit(reopened.sessionId,unitId)).reading.blocks.filter(b=>b.kind==='exercise').length,2);
        assert.equal((await core.graph(reopened.sessionId)).nodes.filter(n=>n.id===unitId).length,1);
        console.log(JSON.stringify({kind:'t30-actual-model',runtime:opened.runtime,courseId:opened.courseId,sourceVersionId:source.versionId,
          artifactId:page.artifactId,taskId:task.id,attemptId:task.attemptId,threadId:last.threadId,turnId:last.turnId,
          unitId,operationIds:last.groups?.map(g=>g.operationId),status:last.status}));
      }
    } finally {await runtime?.close();await core.close();await rm(root,{recursive:true,force:true});}
  });
