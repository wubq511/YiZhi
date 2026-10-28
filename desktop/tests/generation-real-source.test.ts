import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CourseService } from '../src/core/course-service';
import { AgentRuntime } from '../src/agent/executor';

const prepared=process.env.YIZHI_T30_PREPARED_COURSE;
const runModel=process.env.YIZHI_T30_ACTUAL_MODEL==='1';
const stopContinue=process.env.YIZHI_T30_STOP_CONTINUE==='1';
const evidenceDirectory=process.env.YIZHI_T30_EVIDENCE_DIR;

test('real original parsed TI source drives the bounded Core read and, when requested, actual app-server generation',
  {skip:!prepared},async()=>{
    if(evidenceDirectory)await mkdir(evidenceDirectory,{recursive:true});
    const root=await mkdtemp(join(evidenceDirectory??tmpdir(),'yizhi-t30-actual-'));
    let core=new CourseService(resolve('dist/worker.cjs'));
    let runtime:AgentRuntime|undefined;
    let releaseLesson:(()=>void)|undefined;
    let capture:(()=>Promise<void>)|undefined;
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
        target:{unitId:'KU-001'},intent:'generate' as const,generationSpec:spec,model:process.env.YIZHI_T30_MODEL??'gpt-6-luna'};
      if(evidenceDirectory){
        capture=async()=>{
          const view=await core.agent.get({sessionId,conversationId:conversation.id});
          await writeFile(join(root,'evidence.json'),JSON.stringify({capturedAt:new Date().toISOString(),request,view,
            candidates:await Promise.all(view.tasks.map(task=>core.generationCandidates({sessionId,taskId:task.id}))),
            formalHistory:await core.commands.history({sessionId}),graph:await core.graph(sessionId),
            unit:await core.readUnit(sessionId,unitId).catch(()=>null)},null,2));
        };
        console.log(JSON.stringify({kind:'t30-actual-evidence',root,model:request.model,stopContinue}));
      }
      if(!runModel){
        const task=await core.agent.submit(request);
        const context=await core.readAgentGeneration({sessionId,taskId:task.id,attemptId:task.attemptId,generation:task.generation});
        assert.equal(context.sourceTable.length,8);
        assert.equal(context.artifact.structureRole,null);
        assert.equal(context.sourceText.length,97);
        assert.deepEqual(context.pendingStages,['lesson','practice']);
        assert.deepEqual((await core.read(sessionId)).unit,opened.unit);
      }else{
        runtime=new AgentRuntime(core,{directory:join(root,'agent'),cliPath:process.env.YIZHI_T30_CLI_PATH??'/opt/homebrew/bin/codex'});
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
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{await Promise.race([firstLesson,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('actual model did not commit the first lesson')),120_000);})]);}
          finally{if(timer)clearTimeout(timer);}
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
          const stoppedView=await core.agent.get({sessionId,conversationId:conversation.id});
          assert.deepEqual(stoppedView.tasks.find(item=>item.id===task.id)?.generationProgress?.pendingStages,['practice']);
          const resumed=await runtime.continue({sessionId,taskId:task.id,operationId:'actual-explicit-continue'});
          assert.notEqual(resumed.attemptId,task.attemptId);
          activeTaskId=resumed.id;
        }
        let last=task;
        let settledWaitingPolls=0;
        for(let i=0;i<300;i++){
          last=await core.agentTask({sessionId,taskId:activeTaskId});
          if(i%15===0){
            await capture?.();
            console.log(JSON.stringify({kind:'t30-actual-progress',seconds:i,taskId:last.id,status:last.status,
              groups:last.groups?.map(group=>({status:group.status,reason:group.reason})),error:last.error}));
          }
          if(['completed','partial','failed','interrupted','unknown','stopped'].includes(last.status) ||
            ['waiting','pending'].includes(last.status) && !!last.executorStatus && last.executorStatus!=='unknown' && ++settledWaitingPolls>=12)break;
          if(!['waiting','pending'].includes(last.status)||!last.executorStatus||last.executorStatus==='unknown')settledWaitingPolls=0;
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
        await capture?.();capture=undefined;
        await runtime.close();runtime=undefined;
        await core.close();core=new CourseService(resolve('dist/worker.cjs'));
        const reopened=await core.open(directory);
        assert.equal((await core.readUnit(reopened.sessionId,unitId)).reading.blocks.filter(b=>b.kind==='exercise').length,2);
        assert.equal((await core.graph(reopened.sessionId)).nodes.filter(n=>n.id===unitId).length,1);
        console.log(JSON.stringify({kind:'t30-actual-model',runtime:opened.runtime,courseId:opened.courseId,sourceVersionId:source.versionId,
          artifactId:page.artifactId,taskId:task.id,attemptId:task.attemptId,threadId:last.threadId,turnId:last.turnId,
          unitId,operationIds:allCommitted.map(g=>g.operationId),retainedAttempts:taskChain.tasks.flatMap(item=>item.groups??[]).length-allCommitted.length,
          model:request.model,stopContinue,attempts:taskChain.tasks.length,status:last.status}));
      }
    } finally {
      releaseLesson?.();await capture?.().catch(error=>console.error('evidence capture failed:',error));
      await runtime?.close();await core.close();
      if(!evidenceDirectory)await rm(root,{recursive:true,force:true});
    }
  });
