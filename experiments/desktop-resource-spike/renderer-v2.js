// Same injected sampler in both engines; never changes the source fixture.
async function resourceProbe(origin, run, mode) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = () => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    visible: document.visibilityState, focus: document.hasFocus()});
  const mark = (kind, phase, data={}) => fetch(origin+'/mark', {method:'POST',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({run,kind,phase,...data})}).then(r=>r.json());
  const valid = s => s.width===1000 && s.height===700 && s.dpr===2 && s.visible==='visible' && s.focus===true;
  // Host activates once per phase. Wait for that one attempt; never refocus from JS.
  await sleep(500);
  const readiness=[];
  for(let i=0;i<3;i++){const s=state();readiness.push(s);if(!valid(s)) {
    await mark('failure',mode,{error:'Initial focus/viewport readiness failed',state:s,readiness});
    throw Error('Initial '+mode+' focus/viewport readiness failed');
  }await sleep(100);}
  await mark('readiness',mode,{readiness,activationAttempts:1});
  async function sample(phase, load=false) {
    const before = state(), frames=[], events=[], updates=[];
    if(!valid(before)) {await mark('failure',phase,{error:'Condition failed before phase begin',state:before});throw Error('Invalid begin '+phase);}
    let rejectInvalid,active=true,failed=false;
    const invalid=new Promise((_,reject)=>{rejectInvalid=reject;});
    const fail=s=>{if(failed)return;failed=true;active=false;
      mark('failure',phase,{error:'Focus/viewport/visibility changed during phase; abort immediately',state:s})
        .finally(()=>rejectInvalid(Error('Invalid condition during '+phase)));};
    const changed = e => {const s=state();events.push({event:e.type, at:performance.now(), ...s});if(!valid(s))fail(s);};
    for(const n of ['visibilitychange','focus','blur','resize']) addEventListener(n,changed);
    await mark('begin',phase,{state:before});
    const start=performance.now(); let last=null;
    function frame(t) {
      if(!active) return;
      frames.push({t,dt:last===null?null:t-last,...state()}); last=t;
      if(!valid(state())){fail(state());return;}
      if(load) probe.setViewport({x:95+12*Math.sin((t-start)/700),y:35+8*Math.sin((t-start)/900),zoom:.7+.005*Math.sin((t-start)/800)});
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    const work=(async()=>{if(load) {
      for(let i=0;i<16;i++) {
        const target=start+i*500; await sleep(Math.max(0,target-performance.now()));
        if(failed)return;
        const text=window.resourceOriginal.repeat(4+i)+'（资源实验 '+i+'）';
        probe.emit(0,text); await sleep(120);
        updates.push({index:i,at:performance.now()-start,applied:window.resourceParagraph.textContent===text,
          chars:window.resourceParagraph.textContent.length,viewport:probe.viewport(),
          height:window.resourceBody.getBoundingClientRect().height});
      }
    }
    await sleep(Math.max(0,8000-(performance.now()-start)));})();
    await Promise.race([work,invalid]);active=false;
    const durationMs=performance.now()-start;
    const after=state();
    const payload={before,after,durationMs,frames,events,updates,
      snapshot:window.probe?.snapshot(),layout:window.probe?.layout(),
      sameBody:mode!=='blank'?document.querySelector('[data-unit="KU-001"] .source-content')===window.resourceBody:null};
    if(!valid(after)){await mark('failure',phase,{error:'Condition failed at phase end',state:after});throw Error('Invalid end '+phase);}
    await mark('end',phase,{renderer:payload});
    for(const n of ['visibilitychange','focus','blur','resize']) removeEventListener(n,changed);
    return payload;
  }
  if(mode==='blank') { await sleep(2000); return await sample('blank'); }
  if(mode==='load') return await sample('load',true);
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
  return {fixture,reading};
}
