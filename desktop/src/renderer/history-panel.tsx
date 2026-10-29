import { forwardRef,useImperativeHandle,useRef,useState,useEffect } from 'react';
import { createPortal } from 'react-dom';
import katex from 'katex';
import type { HistoryActivity,HistoryGroup,HistoryPreview,HistorySelection,HistoryResult } from '../history-api';
import type { ReadingBlock } from '../shared';
import './history-panel.css';
export interface HistoryPanelHandle { open(unitId?:string):void }
interface Props {
  sessionId:string; units:Array<{id:string;name:string}>;
  prepare():Promise<void>; capture():()=>Promise<void>; changed(result:HistoryResult):Promise<void>;
}
function valueText(value:Record<string,any>|null):string {
  if(!value||value.retired)return '（不存在）';
  if(value.payload?.text!==undefined)return value.payload.text;
  if(value.payload?.latex!==undefined)return value.payload.latex;
  if(value.unitId&&typeof value.x==='number')return `位置 (${value.x}, ${value.y}) · 宽度 ${value.width}`;
  return JSON.stringify(value,null,2);
}
function OldBlock({block}:{block:ReadingBlock}) {
  const p=block.payload;
  return <section className="history-old-block" data-history-block={block.id}>
    {block.kind==='paragraph'?<p>{p.text}</p>:block.kind==='formula'?<div role="math" aria-label={p.latex} dangerouslySetInnerHTML={{__html:katex.renderToString(p.latex,{throwOnError:false,trust:false,displayMode:true})}}/>:
      block.kind==='table'?<div className="history-table"><table><thead><tr>{p.columns.map((c:string,i:number)=><th key={i}>{c}</th>)}</tr></thead><tbody>{p.rows.map((r:any[],i:number)=><tr key={i}>{r.map((c,j)=><td key={j}>{String(c)}</td>)}</tr>)}</tbody></table></div>:
      <><h4>{p.title??p.caption??p.alt??({'interactive':'实验定义（不运行）','knowledge-reference':'知识引用','callout':'提示','steps':'步骤'}[block.kind]??block.kind)}</h4>{p.problem&&<p>{p.problem}</p>}{p.text&&<p>{p.text}</p>}{p.items&&<ol>{p.items.map((t:string,i:number)=><li key={i}>{t}</li>)}</ol>}<details><summary>查看此块完整内容</summary><pre>{JSON.stringify(p,null,2)}</pre></details></>}
    {block.children?.map(child=><OldBlock key={child.id} block={child}/>)}
  </section>;
}
export const HistoryPanel=forwardRef<HistoryPanelHandle,Props>(function HistoryPanel({sessionId,units,prepare,capture,changed},ref) {
  const [open,setOpen]=useState(false),[scope,setScope]=useState<string>(),[activities,setActivities]=useState<HistoryActivity[]>([]),[next,setNext]=useState<string>();
  const [details,setDetails]=useState<Record<string,HistoryGroup[]>>({}),[preview,setPreview]=useState<HistoryPreview>(),[result,setResult]=useState<HistoryResult>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),origin=useRef<(()=>Promise<void>)|undefined>(undefined),trigger=useRef<HTMLButtonElement>(null);
  const pending=useRef<{sessionId:string;operationId:string;preview:HistoryPreview}|undefined>(undefined);
  const held=useRef<{sessionId:string;pinId:string}|undefined>(undefined);
  const release=()=>{const p=held.current;held.current=undefined;if(p)void window.yizhi.formalHistory.release(p).catch(()=>{});};
  const replacePreview=(value?:HistoryPreview)=>{release();if(value?.retentionPin)held.current={sessionId,pinId:value.retentionPin};setPreview(value);};
  useEffect(()=>()=>{if(!pending.current)release();},[sessionId]);
  const load=async(unitId:string|undefined,before?:string)=>{
    const page=await window.yizhi.formalHistory.list({sessionId,unitId,limit:20,before});
    setActivities(old=>before?[...old,...page.activities]:page.activities);setNext(page.next);
  };
  const work=async(run:()=>Promise<void>)=>{setBusy(true);setError('');try{await run();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const show=(unitId?:string)=>{origin.current=capture();setScope(unitId);setOpen(true);setResult(undefined);if(!pending.current)replacePreview(undefined);setDetails({});void work(async()=>{await prepare();await load(unitId);});};
  useImperativeHandle(ref,()=>({open:show}));
  const close=()=>{if(busy)return;setOpen(false);if(!pending.current)replacePreview(undefined);void origin.current?.().catch(e=>setError(e.message));};
  const inspect=async(activity:HistoryActivity,count=10)=>{
    const groups=await Promise.all(activity.operationIds.slice(-count).reverse().map(operationId=>window.yizhi.formalHistory.detail({sessionId,operationId})));
    setDetails(old=>({...old,[activity.id]:groups}));
  };
  const undo=(selection:HistorySelection)=>void work(async()=>{await prepare();pending.current=undefined;setResult(undefined);replacePreview(await window.yizhi.formalHistory.preview({sessionId,selection}));});
  const oldVersion=(group:HistoryGroup,unitId:string,side:'before'|'after',includeLayout=false)=>void work(async()=>{await prepare();pending.current=undefined;setResult(undefined);replacePreview(await window.yizhi.formalHistory.preview({sessionId,unitId,atOperationId:group.operationId,side,includeLayout}));});
  const apply=()=>void work(async()=>{
    if(!preview)return;
    pending.current??={sessionId,operationId:crypto.randomUUID(),preview};
    const request=pending.current;
    const receipt=await window.yizhi.formalHistory.query({sessionId,operationId:request.operationId})??await window.yizhi.formalHistory.apply(request);
    setResult(receipt);pending.current=undefined;release();
    await changed(receipt);await load(scope);
  });
  const names=(ids:string[])=>ids.map(id=>units.find(u=>u.id===id)?.name??id).join('、');
  return <><button ref={trigger} onClick={()=>show()} aria-haspopup="dialog">课程历史</button>{open&&createPortal(<dialog className="history-panel" aria-label="修改历史" ref={node=>{dialog.current=node;if(node&&!node.open)node.showModal();}} onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>{
    e.stopPropagation();if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z')e.preventDefault();
  }}>
    <header className="history-heading"><h2>修改历史</h2><button disabled={busy} onClick={close}>返回原阅读位置</button></header>
    <div className="history-controls"><label>查看范围 <select aria-label="历史范围" value={scope??''} disabled={busy||!!pending.current} onChange={e=>{const id=e.target.value||undefined;setScope(id);replacePreview(undefined);setResult(undefined);void work(()=>load(id));}}><option value="">全课活动</option>{units.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label><button disabled={busy} onClick={()=>void work(()=>load(scope))}>刷新历史</button></div>
    {error&&<div className="history-error" role="alert"><p>{error}</p>{pending.current&&<button disabled={busy} onClick={apply}>核对并重试原操作</button>}</div>}
    {busy&&<p role="status">正在核对历史与当前内容…</p>}
    {result&&<section className="history-result" role="status" aria-label="历史操作结果"><p>{result.status==='committed'?(preview?.kind==='restore'?'已恢复所选版本；恢复前内容仍在历史中。':'已撤回所选修改。'):result.status==='partial'?`已撤回 ${result.applied.length} 组；${result.conflicts.length} 组因冲突保留。`:'当前内容已保留，未执行撤回或恢复。'}</p>{result.conflicts.map(c=><p key={c.operationId}>{c.reason} · {c.objectIds.join('、')}</p>)}</section>}
    <div className={`history-columns${preview?' has-preview':''}`}>
      <section className="history-list" aria-label="正式活动">
        {!busy&&!activities.length&&<p>此范围还没有正式修改。输入草稿不作为正式版本。</p>}
        {activities.map(a=><details className="history-activity" key={a.id} onToggle={e=>{if(e.currentTarget.open&&!details[a.id])void work(()=>inspect(a));}}>
          <summary><strong>{a.explanation}</strong><span>{a.actor==='agent'?'Agent':'学生'} · {new Date(a.committedAt).toLocaleString('zh-CN',{hour12:false})}</span><span>{names(a.unitIds)} · {a.operationIds.length} 组修改</span></summary>
          {a.taskId&&<button disabled={busy||!!pending.current} onClick={()=>undo({kind:'task',taskId:a.taskId!})}>撤回整个任务</button>}
          {(details[a.id]??[]).map(g=><section className="history-group" key={g.operationId}>
            <h3>{g.explanation} · {new Date(g.committedAt).toLocaleTimeString('zh-CN',{hour12:false})}</h3>
            <p className="history-scope">影响：{names(g.unitIds)}</p>
            <div className="history-actions"><button disabled={busy||!!pending.current} onClick={()=>undo({kind:'operations',operationIds:[g.operationId]})}>撤回这次修改</button>{g.unitIds.filter(id=>units.some(u=>u.id===id)).slice(0,1).map(id=><span key={id}><button disabled={busy||!!pending.current} onClick={()=>oldVersion(g,scope&&g.unitIds.includes(scope)?scope:id,'before')}>查看修改前版本</button><button disabled={busy||!!pending.current} onClick={()=>oldVersion(g,scope&&g.unitIds.includes(scope)?scope:id,'after')}>查看修改后版本</button></span>)}</div>
            {g.changes.map(c=><section className="history-difference" key={c.objectId} aria-label={`差异 ${c.objectId}`}>
              <h4>{c.objectId}</h4><div><section><h5>修改前</h5><pre>{valueText(c.before)}</pre></section><section><h5>修改后</h5><pre>{valueText(c.after)}</pre></section></div>
              {(c.before?.payload||c.after?.payload)&&<details><summary>查看完整对象差异</summary>
                <h5>修改前 · 全部属性</h5><pre>{JSON.stringify(c.before,null,2)}</pre>
                <h5>修改后 · 全部属性</h5><pre>{JSON.stringify(c.after,null,2)}</pre>
              </details>}
            </section>)}
          </section>)}
          {details[a.id]&&details[a.id].length<a.operationIds.length&&<button disabled={busy} onClick={()=>void work(()=>inspect(a,details[a.id].length+10))}>展开更早提交</button>}
        </details>)}
        {next&&<button disabled={busy} onClick={()=>void work(()=>load(scope,next))}>加载更早活动</button>}
      </section>
      {preview&&<section className="history-preview" aria-label="旧版只读预览"><header><h3>{preview.kind==='restore'?'旧版只读预览':'撤回范围预览'}</h3><button disabled={busy||!!pending.current} onClick={()=>{replacePreview(undefined);setResult(undefined);}}>返回历史列表</button></header>
        <p>{names(preview.unitIds)}</p>{preview.explanations.map(t=><p key={t}>{t}</p>)}
        {preview.runningTaskIds.length>0&&<p>此任务仍在运行。执行时先停止，再核对已完成修改；若集合有变化，需要重新预览。</p>}
        {preview.drafts>0&&<p>{preview.drafts} 份相关输入草稿已保留，不会转为正文。</p>}
        <details><summary>必要一致范围 · {preview.affectedObjectIds.length} 个对象</summary><ul>{preview.affectedObjectIds.map(id=><li key={id}>{id}</li>)}</ul></details>
        {preview.sourceVersions.length>0&&<details open><summary>使用当时的来源版本</summary><ul>{preview.sourceVersions.map(id=><li key={id}>{id}</li>)}</ul></details>}
        {preview.kind==='restore'&&<label className="history-layout"><input type="checkbox" checked={!!preview.includeLayout} disabled={busy||!!pending.current||!!result} onChange={e=>oldVersion(preview.groups[0],preview.unitId!,preview.side!,e.target.checked)}/>同时恢复当时布局</label>}
        {!result&&<button className="history-confirm" disabled={busy} onClick={apply}>{pending.current?'核对并重试原操作':preview.kind==='restore'?'恢复此版本':preview.runningTaskIds.length?'停止并撤回已完成修改':'确认撤回'}</button>}
        {result?.status==='conflict'&&<button disabled={busy} onClick={()=>preview.kind==='undo'?undo(preview.selection!):oldVersion(preview.groups[0],preview.unitId!,preview.side!,!!preview.includeLayout)}>重新预览当前影响</button>}
        {preview.unit&&<article className="history-old-unit"><h3>{preview.unit.name}</h3>{preview.unit.reading.blocks.map(b=><OldBlock key={b.id} block={b}/>)}</article>}
      </section>}
    </div>
  </dialog>,document.body)}</>;
});
