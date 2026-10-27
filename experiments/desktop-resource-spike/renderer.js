// Same injected sampler in both engines; never changes the source fixture.
async function resourceProbe(origin, run, mode) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = () => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    visible: document.visibilityState, focus: document.hasFocus()});
  const mark = (kind, phase, data={}) => fetch(origin+'/mark', {method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({run,kind,phase,...data})}).then(r=>r.json());
  async function sample(phase, load=false) {
    const before = state(), frames=[], events=[], updates=[];
    const changed = e => events.push({event:e.type, at:performance.now(), ...state()});
    for(const n of ['visibilitychange','focus','blur','resize']) addEventListener(n,changed);
    await mark('begin',phase,{state:before});
    const start=performance.now(); let last=null, active=true;
    function frame(t) {
      if(!active) return;
      frames.push({t,dt:last===null?null:t-last,...state()}); last=t;
      if(load) probe.setViewport({x:95+12*Math.sin((t-start)/700),y:35+8*Math.sin((t-start)/900),zoom:.7+.005*Math.sin((t-start)/800)});
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    if(load) {
      for(let i=0;i<16;i++) {
        const target=start+i*500; await sleep(Math.max(0,target-performance.now()));
        const text=window.resourceOriginal.repeat(4+i)+'（资源实验 '+i+'）';
        probe.emit(0,text); await sleep(120);
        updates.push({index:i,at:performance.now()-start,applied:window.resourceParagraph.textContent===text,
          chars:window.resourceParagraph.textContent.length,viewport:probe.viewport(),
          height:window.resourceBody.getBoundingClientRect().height});
      }
    }
    await sleep(Math.max(0,8000-(performance.now()-start))); active=false;
    const durationMs=performance.now()-start;
    const after=state();
    const payload={before,after,durationMs,frames,events,updates,
      snapshot:window.probe?.snapshot(),layout:window.probe?.layout(),
      sameBody:mode==='content'?document.querySelector('[data-unit="KU-001"] .source-content')===window.resourceBody:null};
    await mark('end',phase,{renderer:payload});
    for(const n of ['visibilitychange','focus','blur','resize']) removeEventListener(n,changed);
    return payload;
  }
  if(mode==='blank') { await sleep(2000); return await sample('blank'); }
  const deadline=performance.now()+20000;
  while(!window.probe?.ready && !window.probe?.failure && performance.now()<deadline) await sleep(50);
  if(!window.probe?.ready) throw Error('Fixture not ready: '+JSON.stringify(window.probe));
  probe.manual(); probe.setViewport({x:95,y:35,zoom:.7});
  await document.fonts.ready; await sleep(3000);
  window.resourceBody=document.querySelector('[data-unit="KU-001"] .source-content');
  window.resourceParagraph=resourceBody.querySelector('.reading-paragraph p, .reading-block p');
  window.resourceOriginal=resourceParagraph.textContent;
  const fixture={articles:document.querySelectorAll('[data-unit]').length,snapshot:probe.snapshot(),
    bodyChars:resourceBody.textContent.length,paragraph:resourceOriginal,assetErrors:probe.assetErrors,
    userAgent:navigator.userAgent,viewport:state(),prefixInjected:false};
  await mark('fixture','setup',{fixture});
  const reading=await sample('reading');
  const load=await sample('load',true);
  return {fixture,reading,load};
}
