import { useEffect,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { RetentionStatus,RetentionSpace } from '../retention-api';
import './history-panel.css';
import './retention-panel.css';
const bytes=(n:number)=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
const date=(s:string)=>new Date(s).toLocaleString('zh-CN',{hour12:false});
export function RetentionPanel({sessionId,prepare}:{sessionId:string;prepare():Promise<void>}) {
 const [open,setOpen]=useState(false),[status,setStatus]=useState<RetentionStatus>(),[space,setSpace]=useState<RetentionSpace>();
 const [days,setDays]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState('');
 const trigger=useRef<HTMLButtonElement>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const work=async(run:()=>Promise<void>)=>{setBusy(true);setError('');try{await run();}catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}};
 const refresh=async()=>{const [s,p]=await Promise.all([window.yizhi.retention.get({sessionId}),window.yizhi.retention.space({sessionId})]);if(alive.current){setStatus(s);setSpace(p);}return s;};
 const show=()=>{setOpen(true);setResult('');void work(async()=>{await prepare();const s=await refresh();setDays(String(s.days));});};
 const close=()=>{if(busy)return;setOpen(false);trigger.current?.focus();};
 useEffect(()=>{
  if(!open)return;
  let cancelled=false;
  const timer=setInterval(()=>{void window.yizhi.retention.get({sessionId}).then(s=>{if(!cancelled)setStatus(s);}).catch(e=>{if(!cancelled)setError(e.message);});},1000);
  return()=>{cancelled=true;clearInterval(timer);};
 },[open,sessionId]);
 return <><button ref={trigger} onClick={show} aria-haspopup="dialog">历史与空间</button>{open&&createPortal(<dialog className="history-panel retention-panel" aria-label="历史与空间" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>e.stopPropagation()}>
  <header className="history-heading"><h2>历史与空间</h2><button disabled={busy} onClick={close}>返回课程</button></header>
  {error&&<p role="alert" className="history-error">{error}</p>}
  <section aria-labelledby="retention-heading"><h3 id="retention-heading">正式历史期限</h3>
   <p>按正式提交时间保留完整修改组。当前正文、个人记录、未处理草稿与有效任务的恢复依据会继续保留。</p>
   <form noValidate onSubmit={e=>{e.preventDefault();void work(async()=>{
    if(!/^[0-9]+$/.test(days)||!Number.isSafeInteger(Number(days))||Number(days)<1)throw new Error('历史保留天数必须为正整数，请输入至少 1 天。');
    await prepare();setStatus(await window.yizhi.retention.set({sessionId,days:Number(days)}));setResult('期限已保存，将自动分批整理。');
   });}}><label htmlFor="retention-days">历史保留天数</label><div className="retention-field"><input id="retention-days" type="text" inputMode="numeric" value={days} onChange={e=>setDays(e.target.value)} disabled={busy||!status} aria-describedby="retention-notice"/><span>天</span><button type="submit" className="history-confirm" disabled={busy||!status}>保存期限</button></div></form>
   <p id="retention-notice">{status?.notice??'调大期限不能找回已清理的明细。独立备份单独管理。'}</p>
   <div role="status" aria-label="历史保留状态" className="retention-range">{status?<>
    <strong>保留 {status.days} 天</strong><p>窗口起点：{date(status.cutoff)}</p><p>最早保留提交：{status.oldestAvailable?date(status.oldestAvailable):'暂无正式提交'}</p>
    <p>{status.pendingGroups?`${status.pendingGroups} 组已到期，正分批整理或等待有效引用释放。`:'已到期的正式组已整理。'}</p>
    {status.blocked&&<p>{status.blocked}</p>}
   </>:<p>正在读取课程的保留范围…</p>}</div>
   <button disabled={busy||!status} onClick={()=>void work(async()=>{await prepare();const r=await window.yizhi.retention.run({sessionId});await refresh();setResult(r.blocked??(r.pending?'已完成一批整理，后台会继续。':'本轮整理已完成。'));})}>继续整理</button>
  </section>
  <section aria-labelledby="space-heading"><div className="retention-space-heading"><h3 id="space-heading">课程占用</h3><button disabled={busy} onClick={()=>void work(async()=>{await refresh();})}>刷新空间</button></div>
   {space?<><table><caption>逻辑载荷与资源文件</caption><thead><tr><th scope="col">类别</th><th scope="col">条目</th><th scope="col">大小</th></tr></thead><tbody>{space.categories.map(c=><tr key={c.id}><th scope="row">{c.label}</th><td>{c.rows}</td><td>{bytes(c.bytes)}</td></tr>)}</tbody></table>
    <p>SQLite 文件占用 {bytes(space.databaseBytes)}，其中 {bytes(space.reusableBytes)} 空闲页可复用。</p><p>{space.notice}</p></>:<p>正在统计课程空间…</p>}
   <button disabled={busy||!space} onClick={()=>void work(async()=>{await prepare();let r;do{r=await window.yizhi.retention.clearCache({sessionId});}while(r.pending&&alive.current);await refresh();setResult('缓存已清除；下次搜索时会重建索引。');})}>清除搜索缓存</button>
  </section>
  <p role="status" aria-label="空间操作结果">{busy?'正在核对并保存…':result}</p>
 </dialog>,document.body)}</>;
}
