import {useEffect,useRef,useState} from 'react';
import {ExtensionRuntime} from './extension-runtime';
import './extension-experiment.css';
const live=new Set<ExtensionRuntime>();
export async function flushExtensions(sessionId:string){const results=await Promise.all([...live].filter(c=>c.sessionId===sessionId).map(c=>c.pause().catch(()=>false)));return results.every(Boolean);}
function Lab({sessionId,active,disabled}:{sessionId:string;active:boolean;disabled:boolean}){
 const host=useRef<HTMLDivElement>(null),region=useRef<HTMLElement>(null),runtime=useRef<ExtensionRuntime>(null);
 const [,paint]=useState(0);
 const [localInputs,setLocalInputs]=useState<Record<string,number>>();
 useEffect(()=>{const c=new ExtensionRuntime(window.yizhi,sessionId,host.current!);runtime.current=c;live.add(c);const unsub=c.subscribe(()=>paint(n=>n+1));return()=>{unsub();void c.pause().finally(()=>{c.dispose();live.delete(c);});};},[sessionId]);
 useEffect(()=>{let inView=false,last:boolean|undefined;
  const update=()=>{const visible=active&&inView&&!document.hidden;if(visible!==last&&runtime.current?.view){last=visible;void runtime.current.send({kind:'visibility',visible}).catch(()=>{});}};
  const o=new IntersectionObserver(e=>{inView=e[0].isIntersecting;update();},{root:region.current?.closest('main.board')});if(region.current)o.observe(region.current);
  document.addEventListener('visibilitychange',update);const t=setInterval(update,250);
  return()=>{o.disconnect();clearInterval(t);document.removeEventListener('visibilitychange',update);if(runtime.current?.view)void runtime.current.send({kind:'visibility',visible:false}).catch(()=>{});};
 },[active,runtime.current?.view?.generation]);
 useEffect(()=>{const release=()=>{if(runtime.current?.view?.gesture)void runtime.current.send({kind:'gesture',active:false}).catch(()=>{});};
  window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);window.addEventListener('blur',release);
  return()=>{window.removeEventListener('pointerup',release);window.removeEventListener('pointercancel',release);window.removeEventListener('blur',release);};
 },[]);
 const c=runtime.current,v=c?.view;
 useEffect(()=>{if(localInputs&&v&&JSON.stringify(localInputs)===JSON.stringify(v.inputs))setLocalInputs(undefined);},[v?.revision,localInputs]);
 const send=(a:Parameters<ExtensionRuntime['send']>[0])=>void c?.send(a).catch(()=>{});
 return <section ref={region} role="region" aria-label="奇偶校验扩展实验" className="extension-lab nodrag nopan nowheel" inert={disabled}>
  <h3>奇偶校验扩展实验</h3><p>输入位中有奇数个 1 时，检测结果 P = 1。模拟每步推进 250 ms，输入由你控制。</p>
  {!v?<p role="status">正在打开课程扩展…</p>:<>
  <p>当前定义 {v.definition.packageVersion} · 第 {v.state.step} 步 · 模拟时间 {v.state.simulationTime} ms</p>
  <fieldset disabled={v.phase==='needs-check'||v.phase==='pause-incomplete'} onPointerDown={()=>send({kind:'gesture',active:true})} onPointerUp={()=>send({kind:'gesture',active:false})} onPointerCancel={()=>send({kind:'gesture',active:false})} onKeyDown={()=>send({kind:'gesture',active:true})} onKeyUp={()=>send({kind:'gesture',active:false})} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))send({kind:'gesture',active:false});}}>
   <legend>输入位</legend>{v.definition.inputs.map(n=><label key={n}><input type="checkbox" aria-label={n} checked={!!(localInputs??v.inputs)[n]} onChange={e=>{const inputs={...(localInputs??v.inputs),[n]:Number(e.target.checked)};setLocalInputs(inputs);send({kind:'inputs',inputs});}}/>{n}</label>)}
  </fieldset>
  <div className="extension-actions"><button disabled={!c?.ready} onClick={()=>send({kind:'run',running:!v.running})}>{v.running?'暂停模拟':'开始模拟'}</button><label><input type="checkbox" checked={v.background} disabled={!c?.ready} onChange={e=>send({kind:'background',enabled:e.target.checked})}/>离屏时继续模拟</label></div>
  <p role="status" aria-label="扩展保存状态">{c?.error||v.phase==='pause-incomplete'?'暂停未完成':!c?.ready||v.phase==='needs-check'?'正在检查扩展…':c.pending||v.phase==='pausing'||JSON.stringify(v.inputs)!==JSON.stringify(v.state.inputs)?'正在确认现场…':'现场已保存'}</p>
  {(c?.error||v.error)&&<p role="alert">{c?.error??v.error}</p>}
  {(v.phase==='pause-incomplete'||c?.error)&&<button onClick={()=>void c?.recover().then(()=>setLocalInputs(undefined)).catch(()=>{})}>恢复最近确认现场</button>}
  {v.pending&&<p role="status">新定义 {v.pending.packageVersion}：{v.gesture?'等待本次操作结束':v.error?'与旧现场不能接续；当前仍使用旧定义。':'正在检查现场兼容性…'}</p>}
  {v.error&&v.pending&&v.checked.includes(v.pending.packageVersion)&&<button onClick={()=>send({kind:'restart',version:v.pending!.packageVersion,baseRevision:v.revision})}>按新定义重新开始</button>}
  <details><summary>扩展版本与资源</summary><p>包 {v.definition.packageVersion} · 接口 {v.definition.interfaceVersion} · 输入 {v.definition.inputVersion} · 现场 {v.definition.stateVersion} · MIT</p><ul>{v.definition.resources.map(r=><li key={r.path}>{r.path} · {r.byteLength} bytes · <code>{r.sha256}</code></li>)}</ul>
  <p>以下入口只演示本课程已预构建的两个定义更新。</p><div className="extension-actions"><button disabled={v.definition.packageVersion!=='1.0.0'} onClick={()=>send({kind:'definition',version:'1.1.0'})}>载入兼容定义 1.1.0</button><button disabled={v.definition.packageVersion==='2.0.0'} onClick={()=>send({kind:'definition',version:'2.0.0'})}>载入四位定义 2.0.0</button></div></details>
  </>}
  <div ref={host} className="extension-frame" hidden={!c?.ready || v?.phase==='needs-check' || v?.phase==='pause-incomplete'}/>
 </section>;
}
export function ExtensionExperiment(props:{sessionId:string;active:boolean;disabled:boolean}){
 const [open,setOpen]=useState(false);
 return <div className="extension-entry"><button aria-expanded={open} disabled={props.disabled} onClick={async()=>{if(!open||await flushExtensions(props.sessionId))setOpen(!open);}}>奇偶校验扩展实验</button>{open&&<Lab {...props}/>}</div>;
}
