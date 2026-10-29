import { useEffect,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { CourseRestorePermit,CourseRestorePreview,CourseRestoreResult,PreservedDraft } from '../course-restore-api';
import type { HistoryActivity } from '../history-api';
import './course-restore-panel.css';
type Request={sessionId:string;operationId:string;preview:CourseRestorePermit};
function PreservedInput({draft}:{draft:PreservedDraft}) {
 const input=draft.input,values=[...input.changes.map(c=>c.text),...(input.patch?.updates??[]).flatMap(u=>typeof u.after.text==='string'?[u.after.text]:typeof u.after.latex==='string'?[u.after.latex]:[])];
 return <>
  {values.length>0&&<section aria-label="恢复前正文草稿"><h4>正文草稿</h4>{values.map((text,i)=><pre key={i}>{text}</pre>)}</section>}
  {(input.formulaDrafts??[]).map((formula,i)=><section key={formula.blockId} aria-label="未完成公式草稿"><h4>未完成公式{(input.formulaDrafts?.length??0)>1?` ${i+1}`:''}</h4><pre>{formula.latex}</pre></section>)}
  {input.patch?.structure&&<p>正文结构变化也已保留，可展开原始输入核对。</p>}
  <details><summary>原始输入与版本依据</summary><pre>{JSON.stringify(input,null,2)}</pre></details>
 </>;
}
export function CourseRestorePanel({sessionId,courseId,units,prepare}:{sessionId:string;courseId:string;units:Array<{id:string;name:string}>;prepare():Promise<void>}) {
 const key=`yizhi-course-restore:${courseId}`;
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[activities,setActivities]=useState<HistoryActivity[]>([]),[next,setNext]=useState<string>();
 const [point,setPoint]=useState(''),[side,setSide]=useState<'before'|'after'>('after'),[selected,setSelected]=useState(units.map(u=>u.id)),[layout,setLayout]=useState(false),[review,setReview]=useState(false);
 const [preview,setPreview]=useState<CourseRestorePreview>(),[result,setResult]=useState<CourseRestoreResult>(),[pending,setPending]=useState<Request>(),[drafts,setDrafts]=useState<PreservedDraft[]>([]),[showDrafts,setShowDrafts]=useState(false);
 const trigger=useRef<HTMLButtonElement>(null);
 const work=async(run:()=>Promise<void>)=>{setBusy(true);setError('');try{await run();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const load=async(before?:string)=>{const page=await window.yizhi.formalHistory.list({sessionId,limit:20,before});setActivities(old=>before?[...old,...page.activities]:page.activities);setNext(page.next);if(!before&&!point)setPoint(page.activities[0]?.operationIds.at(-1)??'');};
 useEffect(()=>{
  const raw=localStorage.getItem(key);if(!raw)return;
  let request:Request;try{request=JSON.parse(raw);}catch{localStorage.removeItem(key);return;}
  setOpen(true);setPending(request);
  void work(async()=>{const receipt=await window.yizhi.courseRestore.query({sessionId:request.sessionId,operationId:request.operationId});if(receipt){setResult(receipt);setPending(undefined);localStorage.removeItem(key);}else setError('上次整课恢复尚无完整结果。请核对并重试原操作；不会自动执行。');setDrafts(await window.yizhi.courseRestore.drafts({sessionId}));});
 },[key,sessionId]);
 const show=()=>{setOpen(true);if(!pending){setResult(undefined);setPreview(undefined);setShowDrafts(false);}void work(async()=>{await prepare();await load();setDrafts(await window.yizhi.courseRestore.drafts({sessionId}));});};
 const close=()=>{if(busy)return;setOpen(false);requestAnimationFrame(()=>trigger.current?.focus());};
 const invalidate=()=>{setPreview(undefined);setResult(undefined);};
 const inspect=()=>void work(async()=>{await prepare();setResult(undefined);setPreview(await window.yizhi.courseRestore.preview({sessionId,atOperationId:point,side,unitIds:selected,userState:{layout,review}}));});
 const apply=()=>void work(async()=>{
  let request=pending;
  if(!request){if(!preview)return;const {atOperationId,side,unitIds,userState,token,generation}=preview;request={sessionId,operationId:crypto.randomUUID(),preview:{atOperationId,side,unitIds,userState,token,generation}};localStorage.setItem(key,JSON.stringify(request));setPending(request);}
  // Query first on an uncertain result; exact apply also refreshes the host's cached view/session.
  await window.yizhi.courseRestore.query({sessionId:request.sessionId,operationId:request.operationId});
  const receipt=await window.yizhi.courseRestore.apply({...request,sessionId});setResult(receipt);
 });
 const locked=busy||!!pending||!!result;
 return <><button ref={trigger} aria-haspopup="dialog" onClick={show}>整课历史恢复</button>{open&&createPortal(<dialog className="history-panel course-restore-panel" aria-label="整课历史恢复" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>{e.stopPropagation();if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z')e.preventDefault();}}>
  <header className="history-heading"><h2>整课历史恢复</h2><button disabled={busy} onClick={close}>返回当前课程</button></header>
  <p>从课程历史恢复所选学习范围，并隔离恢复前任务。单元取回和编辑器即时 Undo 使用各自入口；独立课程备份不在这里覆盖。</p>
  {error&&<div className="history-error" role="alert">{error}</div>}{busy&&<p role="status">正在核对整课范围与持久结果…</p>}
  {result&&<section className="history-result" role="status" aria-label="整课恢复结果">已完成整课所选范围恢复。恢复前内容仍在正式历史，旧任务需重新核对后明确继续。</section>}
  {pending&&<section><p>原操作 {pending.operationId} 已保留，先核对其结果再继续。</p><button disabled={busy} onClick={apply}>核对并重试原操作</button></section>}
  {!result&&!pending&&<>
   <div className="course-restore-selection"><label>历史时间点<select aria-label="历史时间点" value={point} disabled={locked} onChange={e=>{setPoint(e.target.value);invalidate();}}><option value="">选择实际提交</option>{activities.flatMap(a=>[...a.operationIds].reverse().map(id=><option key={id} value={id}>{new Date(a.committedAt).toLocaleString('zh-CN',{hour12:false})} · {a.explanation} · {id}</option>))}</select></label><label>版本位置<select value={side} disabled={locked} onChange={e=>{setSide(e.target.value as 'before'|'after');invalidate();}}><option value="after">此次提交后</option><option value="before">此次提交前</option></select></label></div>
   {next&&<button disabled={busy} onClick={()=>void work(()=>load(next))}>加载更早时间点</button>}
   {!activities.length&&!busy&&<p>还没有可恢复的正式提交。当前输入草稿不是历史版本。</p>}
   <fieldset disabled={locked}><legend>课程内容范围 · 已选 {selected.length} 个知识单元</legend><label><input type="checkbox" checked={selected.length===units.length} onChange={e=>{setSelected(e.target.checked?units.map(u=>u.id):[]);invalidate();}}/>选择全部知识单元</label><details><summary>调整知识单元范围</summary><div className="course-restore-unit-options">{units.map(u=><label key={u.id}><input type="checkbox" checked={selected.includes(u.id)} onChange={e=>{setSelected(old=>e.target.checked?[...old,u.id]:old.filter(id=>id!==u.id));invalidate();}}/>{u.name}</label>)}</div></details></fieldset>
   <fieldset disabled={locked}><legend>另选用户状态 · 默认保留当前值</legend><label><input type="checkbox" checked={layout} onChange={e=>{setLayout(e.target.checked);invalidate();}}/>恢复所选单元的布局</label><label><input type="checkbox" checked={review} onChange={e=>{setReview(e.target.checked);invalidate();}}/>恢复所选单元的掌握状态</label><p>个人笔记、图形、对话与新导入资料保持当前记录。</p></fieldset>
   <button disabled={busy||!point||!selected.length} onClick={inspect}>预览整课所选范围</button>
  </>}
  {preview&&!result&&<section className="history-preview" aria-label="整课恢复影响"><h3>恢复影响</h3>{preview.explanations.map(t=><p key={t}>{t}</p>)}<p>{preview.affectedUnitIds.length} 个知识单元在本次范围内；{preview.changes.length} 个对象发生变化。{preview.preservedDrafts} 份有效草稿将单独保留。</p>
   <details><summary>核对必要一致范围与内容差异</summary>{preview.units.map(u=><p key={u.id}>{u.name} · {u.id} · {u.blockCount} 个正文块</p>)}{preview.changes.map(c=><section className="history-difference" key={c.objectId}><h4>{c.objectId}</h4><div><section><h5>恢复前</h5><pre>{JSON.stringify(c.before,null,2)}</pre></section><section><h5>将恢复为</h5><pre>{JSON.stringify(c.after,null,2)}</pre></section></div></section>)}</details>
   {preview.sourceVersions.length>0&&<details><summary>旧内容使用的固定来源版本</summary>{preview.sourceVersions.map(v=><p key={v}>{v}</p>)}</details>}
   {!pending&&<button className="history-confirm" disabled={busy} onClick={apply}>确认恢复并隔离旧任务</button>}
  </section>}
  {drafts.length>0&&<><button disabled={busy} onClick={()=>setShowDrafts(v=>!v)}>查看恢复前草稿</button>{showDrafts&&<section aria-label="恢复前草稿（只读）"><h3>恢复前草稿（只读）</h3><p>原输入与依据保留在原代际；请对照当前课程后重新编辑，不会自动提交旧输入。</p>{drafts.map((d,i)=><details key={`${d.restoreOperationId}:${i}`} open><summary>{units.find(u=>u.id===(d.input.unitId??'KU-001'))?.name??d.input.unitId??'KU-001'} · 输入 {d.input.inputSeq}</summary><PreservedInput draft={d}/></details>)}</section>}</>}
 </dialog>,document.body)}</>;
}
