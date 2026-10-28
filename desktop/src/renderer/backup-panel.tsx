import { useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { BackupManifest } from '../backup-api';
import './history-panel.css';
import './backup-panel.css';

export function BackupPanel({sessionId,prepare,onReturn}:{sessionId:string;prepare():Promise<void>;onReturn():void}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[result,setResult]=useState<BackupManifest>(),[error,setError]=useState('');
 const [upgradeInfo,setUpgradeInfo]=useState<Awaited<ReturnType<typeof window.yizhi.upgrade.info>>>(),[upgradeError,setUpgradeError]=useState(''),[upgrading,setUpgrading]=useState(false);
 const trigger=useRef<HTMLButtonElement>(null);
 const close=()=>{setOpen(false);onReturn();requestAnimationFrame(()=>trigger.current?.focus());};
 const show=()=>{setOpen(true);void window.yizhi.upgrade.info({sessionId}).then(setUpgradeInfo).catch(e=>setUpgradeError(e.message));};
 const run=async(resume:boolean)=>{
  setBusy(true);setError('');setResult(undefined);
  try{await prepare();const r=await window.yizhi.backup[resume?'chooseResume':'chooseCreate']({sessionId});if(r)setResult(r);}
  catch(e){setError((e as Error).message);}
  finally{setBusy(false);}
 };
 const upgrade=async()=>{setBusy(true);setUpgrading(true);setUpgradeError('');try{await window.yizhi.upgrade.choose({sessionId});}catch(e){setUpgradeError((e as Error).message);}finally{setBusy(false);setUpgrading(false);}};
 return <><button ref={trigger} aria-haspopup="dialog" onClick={show}>备份与升级</button>{open&&createPortal(<dialog aria-label="备份与升级" className="history-panel backup-panel" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={e=>{e.preventDefault();if(!upgrading)close();}} onKeyDown={e=>e.stopPropagation()}>
  <header className="history-heading"><h2>备份与升级</h2><button onClick={close}>返回课程</button></header>
  <section><h3>完整备份</h3><p>保存此刻的正文、个人记录、已确认草稿、固定资料与保留的历史。备份独立保存，原课程之后整理历史不会追删副本。</p>
   <div className="backup-actions"><button className="history-confirm" disabled={busy} onClick={()=>void run(false)}>新建完整备份</button><button disabled={busy} onClick={()=>void run(true)}>继续未完成备份</button></div>
   <p>复制期间可以返回课程继续学习。中断后选择原备份目录重试，会核对原快照的清单与摘要。</p>
   {error&&<p role="alert" className="history-error">备份未完成：{error}。修复后选择原目录继续；完成标记前不能作为完整备份打开。</p>}
   <div role="status" className={result?'history-result':''}>{busy?<p>正在保存输入并创建备份；完成后会核对全部资源…</p>:result?<><strong>完整备份已完成</strong><p>{result.resources.length} 个固定资源已核对。备份时间：{new Date(result.createdAt).toLocaleString('zh-CN')}</p></>:<p>选择新目录创建完整副本。</p>}</div>
  </section>
  <section className="backup-upgrade"><h3>课程格式升级</h3><p>先保存全部输入并暂停此课写入，创建完整备份；新副本核对通过后再切换。其他课程可以继续使用。</p>
   {upgradeInfo?.courseFormat===2?<><strong>课程格式已升级</strong>{upgradeInfo.decision?.kind==='format-upgrade'&&upgradeInfo.decision.report?.backupDirectory&&<p>升级时的备份位置：<code>{upgradeInfo.decision.report.backupDirectory}</code></p>}</>:<button disabled={busy||upgradeInfo?.courseFormat!==1} className="history-confirm" onClick={()=>void upgrade()}>备份并升级课程</button>}
   {upgradeError&&<p role="alert" className="history-error">升级未完成：{upgradeError}</p>}
   {upgrading&&<p role="status">正在保存输入、备份并核对工作副本。完成切换前，此课暂停写入…</p>}
   <p>中断后重新打开原课程，会按已保存的切换事实接回。课程已移动时，可选择其当前位置核对。</p>
   <button disabled={busy} onClick={()=>{setUpgradeError('');void window.yizhi.upgrade.chooseRecover().catch(e=>setUpgradeError(e.message));}}>核对并接回升级课程</button>
  </section>
 </dialog>,document.body)}</>;
}
