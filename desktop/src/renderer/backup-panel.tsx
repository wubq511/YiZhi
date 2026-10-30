import { forwardRef, useImperativeHandle } from 'react';
import { useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { BackupManifest } from '../backup-api';
import './history-panel.css';
import './backup-panel.css';

export const BackupPanel = forwardRef<{ open(): void }, {sessionId:string;prepare():Promise<void>;onReturn():void}>(function BackupPanel({sessionId,prepare,onReturn}, ref) {
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[result,setResult]=useState<BackupManifest>(),[error,setError]=useState('');
 const trigger=useRef<HTMLButtonElement>(null);
 const close=()=>{setOpen(false);onReturn();requestAnimationFrame(()=>document.querySelector<HTMLButtonElement>('[aria-label="课程菜单"]')?.focus());};
 const show=()=>setOpen(true);
 const run=async(resume:boolean)=>{
  setBusy(true);setError('');setResult(undefined);
  try{await prepare();const r=await window.yizhi.backup[resume?'chooseResume':'chooseCreate']({sessionId});if(r)setResult(r);}
  catch(e){setError((e as Error).message);}
  finally{setBusy(false);}
 };
 useImperativeHandle(ref, () => ({ open: show }));
 return <>{open&&createPortal(<dialog aria-label="完整备份" className="history-panel backup-panel" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>e.stopPropagation()}>
  <header className="history-heading"><h2>完整备份</h2><button onClick={close}>返回课程</button></header>
  <section><p>保存此刻的正文、个人记录、已确认草稿、固定资料与保留的历史。备份独立保存，原课程之后整理历史不会追删副本。</p>
   <div className="backup-actions"><button className="history-confirm" disabled={busy} onClick={()=>void run(false)}>新建完整备份</button><button disabled={busy} onClick={()=>void run(true)}>继续未完成备份</button></div>
   <p>复制期间可以返回课程继续学习。中断后选择原备份目录重试，会核对原快照的清单与摘要。</p>
   {error&&<p role="alert" className="history-error">备份未完成：{error}。修复后选择原目录继续；完成标记前不能作为完整备份打开。</p>}
   <div role="status" className={result?'history-result':''}>{busy?<p>正在保存输入并创建备份；完成后会核对全部资源…</p>:result?<><strong>完整备份已完成</strong><p>{result.resources.length} 个固定资源已核对。备份时间：{new Date(result.createdAt).toLocaleString('zh-CN')}</p></>:<p>选择新目录创建完整副本。</p>}</div>
  </section>
 </dialog>,document.body)}</>;
});
