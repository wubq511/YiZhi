import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { AgentRuntime } from '../src/agent/executor';

const prepared=process.env.YIZHI_T30_PREPARED_COURSE;
const runModel=process.env.YIZHI_T30_ACTUAL_MODEL==='1';
const stopContinue=process.env.YIZHI_T30_STOP_CONTINUE==='1';

test('real original parsed TI source drives the bounded Core read and, when requested, actual app-server generation',
  {skip:!prepared},async()=>{
    const root=await mkdtemp(join(tmpdir(),'yizhi-t30-actual-'));
    let core=new CourseService(resolve('dist/worker.cjs'));
    let runtime:AgentRuntime|undefined;
    let releaseLesson:(()=>void)|undefined;
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
        let firstLesson:Promise<void>|undefined;
        if(stopContinue){
          let observed!:()=>void;
          firstLesson=new Promise<void>(resolve=>{observed=resolve;});
          const held=new Promise<void>(resolve=>{releaseLesson=resolve;});
          const publish=core.publishAgentGeneration.bind(core);
          core.publishAgentGeneration=async input=>{
            const result=await publish(input);
            if(input.input.stage==='lesson'&&result.status==='committed'){
              observed();
              await held;
            }
            return result;
          };
        }
        const task=await runtime.submit(request);
        let activeTaskId=task.id;
        if(firstLesson){
          await Promise.race([firstLesson,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('actual model did not commit the first lesson')),120_000))]);
          assert.equal((await core.agentTask({sessionId,taskId:task.id})).groups?.filter(g=>g.status==='committed').length,1);
          await runtime.stop({sessionId,taskId:task.id});
          releaseLesson?.();releaseLesson=undefined;
          let stopped;
          for(let i=0;i<120;i++){
            stopped=await core.agentTask({sessionId,taskId:task.id});
            if(['stopped','interrupted','partial','unknown'].includes(stopped.status))break;
            await new Promise(done=>setTimeout(done,500));
          }
          assert.ok(stopped&&['stopped','interrupted','partial','unknown'].includes(stopped.status),`stop did not settle: ${stopped?.status}`);
          assert.deepEqual(stopped.generationProgress?.pendingStages,['practice']);
          const resumed=await runtime.continue({sessionId,taskId:task.id,operationId:'actual-explicit-continue'});
          assert.notEqual(resumed.attemptId,task.attemptId);
          activeTaskId=resumed.id;
        }
        let last=task;
        let settledWaitingPolls=0;
        for(let i=0;i<300;i++){
          last=await core.agentTask({sessionId,taskId:activeTaskId});
          if(['completed','partial','failed','interrupted','unknown','stopped'].includes(last.status) ||
            last.status==='waiting' && last.executorStatus==='completed' && ++settledWaitingPolls>=12)break;
          if(last.status!=='waiting'||last.executorStatus!=='completed')settledWaitingPolls=0;
          if(i===299)throw new Error(`actual model did not settle: ${JSON.stringify({status:last.status,groups:last.groups?.map(g=>g.status),error:last.error})}`);
          await new Promise(done=>setTimeout(done,1000));
        }
        assert.equal(last.status,'completed',JSON.stringify({status:last.status,groups:last.groups,errors:last.toolErrors,error:last.error}));
        const taskChain=await core.agent.get({sessionId,conversationId:conversation.id});
        const allCommitted=taskChain.tasks.flatMap(item=>item.groups??[]).filter(group=>group.status==='committed');
        assert.equal(allCommitted.length,2,'lesson and practice each have one durable committed group across explicit continuation');
        const unit=await core.readUnit(sessionId,unitId);
        assert.equal(unit.reading.blocks.filter(b=>b.kind==='exercise').length,2);
        assert.equal((await core.graph(sessionId)).nodes.filter(n=>n.id===unitId).length,1);
        assert.equal((await core.commands.history({sessionId})).filter(h=>taskChain.tasks.some(item=>item.id===h.taskId)).length,2);
        await runtime.close();runtime=undefined;
        await core.close();core=new CourseService(resolve('dist/worker.cjs'));
        const reopened=await core.open(directory);
        assert.equal((await core.readUnit(reopened.sessionId,unitId)).reading.blocks.filter(b=>b.kind==='exercise').length,2);
        assert.equal((await core.graph(reopened.sessionId)).nodes.filter(n=>n.id===unitId).length,1);
        console.log(JSON.stringify({kind:'t30-actual-model',runtime:opened.runtime,courseId:opened.courseId,sourceVersionId:source.versionId,
          artifactId:page.artifactId,taskId:task.id,attemptId:task.attemptId,threadId:last.threadId,turnId:last.turnId,
          unitId,operationIds:allCommitted.map(g=>g.operationId),retainedAttempts:taskChain.tasks.flatMap(item=>item.groups??[]).length-allCommitted.length,
          stopContinue,attempts:taskChain.tasks.length,status:last.status}));
      }
    } finally {releaseLesson?.();await runtime?.close();await core.close();await rm(root,{recursive:true,force:true});}
  });
