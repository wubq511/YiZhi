import { useEffect, useRef, useState } from 'react';
import type { SourceVersion } from '../sources-api';
import type { ArtifactRef, ParseTask, ParsedPage, ParseStructure } from '../parsing-api';
import './parsing-section.css';
const statuses={running:'正在解析',completed:'已完成',stopped:'已停止',interrupted:'已中断',failed:'解析失败'};
function Structure({node,page}:{node:ParseStructure;page:ParsedPage}) {
  const text=(n:ParseStructure):string=>n.id?page.text.filter(t=>t.markedContentId===n.id).map(t=>t.text).join(' '):n.children.map(text).join(' ');
  if(node.role==='Table') return <li className="parse-table"><strong>表格标签 · Table</strong><p>合并单元格与复杂排版以原页为准。</p><table><tbody>{node.children.filter(n=>n.role==='TR').map((row,i)=><tr key={i}>{row.children.map((cell,j)=>cell.role==='TH'?<th key={j}>{text(cell)}</th>:<td key={j}>{text(cell)}</td>)}</tr>)}</tbody></table></li>;
  if(node.role==='Formula') return <li className="parse-formula"><strong>公式 · Formula</strong><br/>{text(node)}</li>;
  if(node.role==='content') return null;
  return <li><span>{node.role}</span>{node.children.every(c=>c.role==='content')?' · '+text(node):<ul>{node.children.map((n,i)=><Structure key={i} node={n} page={page}/>)}</ul>}</li>;
}
export function ParsingSection({sessionId,generation,source,onSource}:{sessionId:string;generation:number;source:SourceVersion;onSource(pageIndex:number):void}) {
  const api=window.yizhi.parsing;
  const [tasks,setTasks]=useState<ParseTask[]>([]),[selected,setSelected]=useState(''),[refs,setRefs]=useState<ArtifactRef[]>([]);
  const [artifact,setArtifact]=useState<ParsedPage>(),[artifactId,setArtifactId]=useState(''),[textId,setTextId]=useState(''),[text,setText]=useState(''),[note,setNote]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const retry=useRef<(()=>Promise<void>)|undefined>(undefined),identity=useRef(0);
  const selectedRef=refs.find(ref=>ref.artifactId===artifactId);
  const task=tasks.find(t=>t.taskId===selected)??tasks[0];
  async function refresh() {
    const token=identity.current;
    const [all,artifacts]=await Promise.all([api.list({sessionId}),api.artifacts({sessionId,versionId:source.versionId})]);
    if(token!==identity.current) return;
    setTasks(all.filter(t=>t.source.versionId===source.versionId));setRefs(artifacts);
  }
  useEffect(()=>{
    identity.current++;let active=true;
    void refresh().catch(e=>{if(active)setError(e.message);});
    const interval=setInterval(()=>{if(active)void refresh().catch(e=>{if(active)setError(e.message);});},500);
    return()=>{active=false;identity.current++;clearInterval(interval);};
  },[sessionId,source.versionId]);
  async function run(action:()=>Promise<void>) {
    retry.current=action;setBusy(true);setError('');
    try {await action();retry.current=undefined;await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function view(ref:ArtifactRef) {
    const page=await api.artifact({sessionId,artifactId:ref.artifactId});
    setArtifact(page);setArtifactId(ref.artifactId);setTextId(page.text[0]?.id??'');setText(page.text[0]?.text??'');setNote('');setMessage('');
  }
  return <details className="parsing-section"><summary>解析此资料</summary>
    <p>保留文字位置、原生表格／公式标签及页面图像。扫描页需要另行 OCR；解析不会改写画板。</p>
    <div className="parse-actions"><button disabled={busy||source.mediaType!=='application/pdf'||task?.status==='running'} onClick={()=>{
      const request={sessionId,generation,operationId:crypto.randomUUID(),versionId:source.versionId};
      void run(async()=>{const result=await api.start(request);setSelected(result.taskId);});
    }}>{tasks.length?'重新解析为新版本':'开始解析此版本'}</button>
    {task?.status==='running'&&<button disabled={busy} onClick={()=>{const request={sessionId,generation,operationId:crypto.randomUUID(),taskId:task.taskId,attemptId:task.attemptId};void run(async()=>{await api.stop(request);});}}>停止解析</button>}
    {task&&['failed','stopped','interrupted'].includes(task.status)&&<button disabled={busy} onClick={()=>{const request={sessionId,generation,operationId:crypto.randomUUID(),taskId:task.taskId};void run(async()=>{await api.continue(request);});}}>从已确认页面继续</button>}</div>
    {source.mediaType!=='application/pdf'&&<p>当前入口只解析 PDF；图片未执行 OCR。</p>}
    {tasks.length>1&&<label>解析记录<select aria-label="解析记录" value={task?.taskId} onChange={e=>setSelected(e.target.value)}>{tasks.map((t,i)=><option key={t.taskId} value={t.taskId}>解析 {tasks.length-i} · {statuses[t.status]}</option>)}</select></label>}
    <p role="status" aria-label="解析进度">{task?`${statuses[task.status]} · 已确认 ${task.confirmed.length} / ${source.pdfPages} 页`:'尚未解析'}</p>
    {task?.failure&&<p className="parse-failure">{task.failure}</p>}
    {error&&<div role="alert" className="parse-failure"><p>{error}</p><button disabled={busy} onClick={()=>retry.current?void run(retry.current):void refresh().catch(e=>setError(e.message))}>重试解析操作</button></div>}
    {task&&<><div className="parse-artifacts">{task.confirmed.map(ref=><button key={ref.artifactId} disabled={busy} onClick={()=>void run(()=>view(ref))}>查看第 {ref.pdfPageIndex+1} 页产物</button>)}{refs.filter(ref=>ref.parentArtifactId).map(ref=><button key={ref.artifactId} disabled={busy} onClick={()=>void run(()=>view(ref))}>查看修正版</button>)}</div>
      <details><summary>输入、工具与尝试</summary><p>{task.tool.name} {task.tool.version} · {task.tool.adapter} · 配置 {task.config.version} · 不使用 OCR</p><p>固定输入版本 {task.source.versionId}</p><p>SHA-256 {task.source.sha256}</p>{task.attempts.map((attempt,i)=><p key={attempt.attemptId}>尝试 {i+1} · {attempt.startedAt} · 执行页 {attempt.pagesStarted.map(n=>n+1).join('、')}{attempt.failure&&` · ${attempt.failure}`}</p>)}</details></>}
    {artifact&&<section aria-label="结构化页面产物" className="parse-page"><h3>PDF 第 {artifact.pdfPageIndex+1} 页产物</h3>
      <p>{artifact.textStatus==='ocr-needed'?'没有可靠文本层，需要 OCR；未生成文字。':`${artifact.text.length} 个文字片段 · ${artifact.images.length} 个图片区域`}</p>
      <button onClick={()=>onSource(artifact.pdfPageIndex)}>核对产物原页</button>
      <details><summary>产物版本与依据</summary><p>产物 {artifactId}</p><p>SHA-256 {selectedRef?.digest}</p><p>固定来源版本 {artifact.source.versionId}</p>{artifact.correction&&<p>人工修正：{artifact.correction.note} · {artifact.correction.correctedAt} · 原产物 {artifact.correction.parentArtifactId}</p>}</details>
      <p className="parse-coordinate">原页坐标 [{artifact.view.join(', ')}] · PDF user space</p>
      {artifact.resources.filter(r=>r.mediaType==='image/png').map(r=><img key={r.sha256} className="parse-raster" alt={`PDF 第 ${artifact.pdfPageIndex+1} 页保留图像`} src={`yizhi-resource://course/${sessionId}/${artifactId}/${r.sha256}`}/>)}
      {artifact.structure?<ul aria-label="原生页面层级"><Structure node={artifact.structure} page={artifact}/></ul>:<p>原件无结构标签，未推断表格、公式或标题层级。</p>}
      {!!artifact.text.length&&<details open><summary>文字与原页位置</summary><ol className="parse-text">{artifact.text.map(item=><li key={item.id}><p>{item.text}</p><small>[{item.bounds.map(n=>n.toFixed(1)).join(', ')}]{item.corrected?' · 人工修正':''}</small></li>)}</ol></details>}
      {!!artifact.images.length&&<details><summary>图片定位</summary>{artifact.images.map(image=><p key={image.id}>原页图像区域 [{image.bounds.map(n=>n.toFixed(1)).join(', ')}]</p>)}</details>}
      {!!artifact.text.length&&<form onSubmit={e=>{e.preventDefault();const request={sessionId,generation,operationId:crypto.randomUUID(),artifactId,textId,text,note};void run(async()=>{const next=await api.correct(request);await view(next);setMessage('已保留新版本，原产物仍可查。');});}}>
        <h4>核对后修正文字</h4><label>文字片段<select aria-label="修正文字片段" value={textId} onChange={e=>{setTextId(e.target.value);setText(artifact.text.find(t=>t.id===e.target.value)?.text??'');}}>{artifact.text.map(item=><option key={item.id} value={item.id}>{item.text.slice(0,40)}</option>)}</select></label>
        <label>修正文字<textarea aria-label="修正文字" value={text} maxLength={100000} onChange={e=>setText(e.target.value)}/></label>
        <label>修正依据<input aria-label="修正依据" value={note} maxLength={2000} onChange={e=>setNote(e.target.value)} placeholder="说明与原页核对的结果"/></label>
        <button disabled={busy||!note.trim()}>保留为新产物版本</button><p role="status" aria-label="产物修正结果">{message}</p>
      </form>}
      <details><summary>解析能力与局限</summary><ul>{artifact.limitations.map(line=><li key={line}>{line}</li>)}</ul></details>
    </section>}
  </details>;
}
