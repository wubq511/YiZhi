import { useEffect,useState } from 'react';
import type { AgentTask } from '../agent-api';
import type { GenerationCandidateView } from '../generation-api';

const stageName={lesson:'完整讲解',practice:'追加练习'} as const;
const checkName={structure:'内容结构',identity:'身份',reference:'引用',version:'版本与输入',course:'课程一致性',
  'source-meaning':'来源含义',finite:'有限域计算',experiment:'实验适用性'} as const;

/** Read-only business progress; a retained proposal remains separate from the board. */
export function GenerationTask({sessionId,task}:{sessionId:string;task:AgentTask}) {
  const [candidates,setCandidates]=useState<GenerationCandidateView[]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [expanded,setExpanded]=useState(false),[reload,setReload]=useState(0);
  const progress=task.generationProgress;
  const revision=task.groups?.map(group=>`${group.operationId}:${group.status}`).join('|');
  useEffect(()=>{
    if(!expanded)return;
    let active=true;setBusy(true);setError('');
    void window.yizhi.agent.generationCandidates({sessionId,taskId:task.id}).then(found=>{if(active)setCandidates(found);})
      .catch(failure=>{if(active)setError((failure as Error).message);}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[sessionId,task.id,expanded,revision,reload]);
  return <section className="agent-generation-task" aria-label="小主题生产进度">
    <p>已确认：{progress?.completedStages.length?progress.completedStages.map(stage=>stageName[stage]).join('、'):'暂无'}；待完成：{progress?.pendingStages.length?progress.pendingStages.map(stage=>stageName[stage]).join('、'):'无'}。</p>
    <p>正式内容可在画板查看；未通过的候选保留在任务记录中。</p>
    <details onToggle={event=>setExpanded(event.currentTarget.open)}>
      <summary>查看未完成候选与校验</summary>
      {busy&&<p role="status">正在读取候选…</p>}
      {error&&<p role="alert">候选读取失败：{error} <button type="button" onClick={()=>setReload(value=>value+1)}>重试</button></p>}
      {candidates?.length===0&&<p>暂无未完成候选。</p>}
      {candidates?.map(candidate=><article key={candidate.operationId} className="agent-generation-candidate">
        <strong>{stageName[candidate.stage]} · 草稿未发布</strong><p>{candidate.reason}</p>
        <details><summary>阅读草稿和逐项结果</summary>
          {candidate.proposal.title&&<h3>{candidate.proposal.title}</h3>}
          {candidate.proposal.outcome&&<p>{candidate.proposal.outcome}</p>}
          {candidate.proposal.intro&&<p>{candidate.proposal.intro}</p>}
          {candidate.proposal.derivation&&<p>{candidate.proposal.derivation}</p>}
          {candidate.proposal.formula&&<p><code>{candidate.proposal.formula}</code></p>}
          {candidate.proposal.example&&<p>例题：{candidate.proposal.example.problem} {candidate.proposal.example.steps} {candidate.proposal.example.answer}</p>}
          {candidate.proposal.exercise&&<p>练习：{candidate.proposal.exercise.problem} 提示：{candidate.proposal.exercise.hint} 答案：{candidate.proposal.exercise.answer}</p>}
          <ul>{candidate.checks.map(check=><li key={check.layer}>{checkName[check.layer]} · {check.status==='passed'?'通过':check.status==='failed'?'未通过':check.status==='not-applicable'?'不适用':'待核对'}：{check.detail}</li>)}</ul>
        </details>
      </article>)}
    </details>
  </section>;
}
