'use strict';
// Responsive lifecycle controller: no timers/animation/media; one outstanding finite Worker step.
const hostOrigin = 'yizhi-app://app';
const packageVersion = location.pathname.split('/')[2];
let identity, worker, sequence=0, dead=false;
const waiting=new Map();
function stop() {dead=true;worker?.terminate();for(const p of waiting.values())p.reject(Error('扩展已销毁'));waiting.clear();}
function call(q) {
  if(!worker) worker=new Worker('./compute.js');
  worker.onmessage=({data:r})=>{const p=waiting.get(r.id);if(!p)return;waiting.delete(r.id);r.error?p.reject(Error(r.error)):p.resolve(r.state);};
  const id=++sequence;
  return new Promise((resolve,reject)=>{waiting.set(id,{resolve,reject});worker.postMessage({...q,id,version:packageVersion});});
}
// Intrinsic content size is bounded again by the trusted reader; no parent DOM access.
new ResizeObserver(()=>{if(identity&&!dead)parent.postMessage({kind:'size',identity,height:Math.ceil(document.body.getBoundingClientRect().height+40)},hostOrigin);}).observe(document.body);
let chain=Promise.resolve();
addEventListener('message',event=>{
  if(event.source!==parent || event.origin!==hostOrigin || dead) return;
  const q=event.data;
  if(!q || q.identity?.definitionVersion!==packageVersion || typeof q.id!=='string')return;
  if(!identity) identity=q.identity;
  if(JSON.stringify(q.identity)!==JSON.stringify(identity)) return;
  if(q.kind==='dispose'){stop();return;}
  chain=chain.then(async()=>{
    try {
      const state=await call(q);
      document.querySelector('output').textContent=`奇数检测 P = ${state.output}`;
      parent.postMessage({id:q.id,identity,state},hostOrigin);
    }catch(error){parent.postMessage({id:q.id,identity,error:String(error)},hostOrigin);}
  });
});
addEventListener('pagehide',stop);
