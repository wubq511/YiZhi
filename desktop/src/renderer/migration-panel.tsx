import {useEffect,useRef,useState} from 'react';
import type {DirectoryDecision} from '../core/directory-authority';
import './migration-panel.css';
export function MigrationPanel({sessionId}:{sessionId?:string}){
 const [open,setOpen]=useState(false),[records,setRecords]=useState(false),[source,setSource]=useState(''),[target,setTarget]=useState(''),[decision,setDecision]=useState<DirectoryDecision>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[data,setData]=useState<any>(),[next,setNext]=useState<string>(),[history,setHistory]=useState<any>(),[detail,setDetail]=useState<any>();
 const dialog=useRef<HTMLDialogElement>(null),operation=useRef<string>(crypto.randomUUID()),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(open)dialog.current?.showModal();else dialog.current?.close();},[open]);
 const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 const readRecords=async(after?:string)=>{const result=await window.yizhi.migration.records({sessionId:sessionId!,after,limit:30});setData(result);setNext(result.next);};
 const close=()=>{if(busy)return;setOpen(false);trigger.current?.focus();};
 return <>
  <button ref={trigger} onClick={()=>{setRecords(false);setOpen(true);}}>迁移旧课程</button>
  {sessionId&&<button onClick={()=>{setRecords(true);setOpen(true);void run(()=>readRecords());}}>迁移记录</button>}
  <dialog ref={dialog} className="migration-panel" onCancel={e=>{e.preventDefault();close();}} aria-label={records?'迁移记录':'迁移旧课程'}>
   <section aria-label={records?'迁移记录':'迁移核对'} aria-busy={busy}>
    <div className="migration-heading"><h2>{records?'迁移记录':'迁移旧课程'}</h2><button disabled={busy} onClick={close}>关闭迁移面板</button></div>
    {records?<>
     <p>旧版身份、原时间和语境保留在这里。旧明细遵循本课历史保留期限；有效草稿和当前个人记录继续保留。</p>
     <div className="migration-actions"><button disabled={busy} onClick={()=>void run(()=>readRecords())}>当前记录</button><button disabled={busy} onClick={()=>void run(async()=>setHistory(await window.yizhi.migration.history({sessionId:sessionId!,limit:30})))}>旧版历史</button><button disabled={busy} onClick={()=>void run(async()=>setDetail(await window.yizhi.migration.pending({sessionId:sessionId!})))}>待核对草稿</button></div>
     {data?.records?.length===0&&<p>本课没有迁入的旧版记录。</p>}
     {data?.records?.map((r:any)=><details key={r.namespace+':'+r.key}><summary>{r.namespace} · {r.key} · 原版本 {r.revision}{r.deleted?' · 已删除':''}</summary><pre>{JSON.stringify(r.extra,null,2)}</pre></details>)}
     {next&&<button disabled={busy} onClick={()=>void run(()=>readRecords(next))}>下一页记录</button>}
     {history?.entries?.map((r:any)=><details key={r.id}><summary>{r.namespace}/{r.key} · {r.savedAt??'旧版未记录时间'}</summary><p>原操作：{r.operationId}</p><pre>{JSON.stringify({before:r.before,after:r.after},null,2)}</pre><button onClick={()=>void run(async()=>setDetail(await window.yizhi.migration.operation({sessionId:sessionId!,operationId:r.operationId})))}>核对原收据</button></details>)}
     {history?.next&&<button disabled={busy} onClick={()=>void run(async()=>setHistory(await window.yizhi.migration.history({sessionId:sessionId!,before:history.next,limit:30})))}>更早历史</button>}
     {detail&&<pre aria-label="原记录详情">{JSON.stringify(detail,null,2)}</pre>}
    </>:<>
     <p>先在旧窗口使用“保存并停止旧课程”，确认最后输入并释放写入锁。新课程核验完成后再发布，原目录保留为迁移前副本。</p>
     <label>旧课程文件夹<input value={source} disabled={busy||!!decision} onChange={e=>setSource(e.target.value)} /></label>
     <button disabled={busy||!!decision} onClick={()=>void run(async()=>{const p=await window.yizhi.migration.chooseDirectory();if(p)setSource(p);})}>选择旧课程文件夹</button>
     <label>新课程文件夹<input value={target} disabled={busy||!!decision} onChange={e=>setTarget(e.target.value)} /></label>
     <button disabled={busy||!!decision} onClick={()=>void run(async()=>{const p=await window.yizhi.migration.chooseDirectory('target');if(p)setTarget(p);})}>选择新课程位置</button>
     {!decision&&<button disabled={busy||!source||!target} onClick={()=>void run(async()=>setDecision(await window.yizhi.migration.stage({sourceDirectory:source,directory:target,operationId:operation.current})))}>核对并准备迁移</button>}
     {decision&&<>
      <h3>{decision.phase==='published'?'新课程已发布':'已核验，等待发布'}</h3><p>课程：{decision.courseId}。原第 {String(decision.sourceVersion.generation)} 代，已确认到 {String(decision.sourceVersion.sequence)}。</p>
      <dl><dt>迁移前副本</dt><dd>{decision.sourceDirectory}</dd><dt>新课程</dt><dd>{decision.targetDirectory}</dd></dl>
      <p>个人记录逐类核对，任务执行事实保留，重开后须核对并明确继续。旧版未记录的精确锚点或时间列为缺口。</p>
      <details><summary>逐类核对与缺口</summary><pre>{JSON.stringify(decision.report?.namespaces,null,2)}</pre><ul>{decision.report?.gaps?.map((g:string,i:number)=><li key={i}>{g}</li>)}</ul></details>
      <button disabled={busy} onClick={()=>void run(async()=>{const r=await window.yizhi.migration.publish({sourceDirectory:source,operationId:operation.current});setDecision(r);await window.yizhi.migration.openDirectory(target);})}>发布并打开新课程</button>
     </>}
     <h3>中断后继续</h3><p>选择原目录或已发布课程的当前位置，先核对完成事实，再接回唯一可写课程。</p>
     <button disabled={busy||!source} onClick={()=>void run(async()=>{const status=await window.yizhi.migration.status({directory:source});if(status.phase==='abandoned'){setDecision(undefined);setTarget('');operation.current=crypto.randomUUID();setError('旧准备已放弃；请选择全新目标重新迁移。');return;}const r=await window.yizhi.migration.recover({directory:source});if(r.decision?.phase==='published')await window.yizhi.migration.openDirectory(r.directory);else if(r.decision){setDecision(r.decision);setTarget(r.decision.targetDirectory);operation.current=r.decision.operationId;await window.yizhi.migration.stage({sourceDirectory:source,directory:r.decision.targetDirectory,operationId:r.decision.operationId});}else setError('此目录尚无切换完成事实，可先准备迁移。');})}>核对并接回课程</button>
     <button disabled={busy||!source} onClick={()=>void run(async()=>{const s=await window.yizhi.migration.status({directory:source});if(!s.decision)throw new Error('此目录没有未发布准备');await window.yizhi.migration.abandon({sourceDirectory:source,operationId:s.decision.operationId});setDecision(undefined);setTarget('');operation.current=crypto.randomUUID();setError('未发布准备已放弃，旧目标仍只读；请选择新目标重新迁移。');})}>放弃未发布准备</button>
    </>}
    {busy&&<p role="status">正在核对课程文件与保存事实…</p>}{error&&<p role="alert">{error}</p>}
   </section>
  </dialog>
 </>;
}
