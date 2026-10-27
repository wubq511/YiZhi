// Shared DOM-level compatibility probe, evaluated against the unchanged built page.
// Native input/host lifecycle evidence is collected separately by each host.
(async () => {
  const out = { checks: [], stages: [], errors: window.spikeErrors || [],
    userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    visibility: document.visibilityState };
  const check = (name, pass, evidence) => out.checks.push({ name, pass: Boolean(pass), evidence });
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const settle = async () => {
    await pause(400);
    const deadline=Date.now()+1500;
    while(window.probe?.layout()?.pending && Date.now()<deadline)await pause(50);
  };
  try {
    const deadline = Date.now() + 15000;
    while (!window.probe?.ready && !window.probe?.failure && Date.now() < deadline) await pause(50);
    if (!window.probe?.ready) throw new Error(JSON.stringify({ failure: window.probe?.failure, phase: window.probe?.phase }));
    const p = window.probe;
    p.manual(); p.setViewport({ x: 95, y: 35, zoom: .7 }); await settle();
    const source = document.querySelector('[data-unit="KU-001"]');
    const body = source.querySelector('.source-content');
    const paragraph = body.querySelector('.reading-paragraph p, .reading-block p');
    const original = paragraph.textContent;
    const formula = source.querySelector('.probe-editors math-field');
    const summary = body.querySelector('details summary');
    function geometry(label) {
      const v = p.viewport(), top = document.querySelector('.board').getBoundingClientRect().top;
      const rects = Object.fromEntries([...document.querySelectorAll('[data-unit]')].map(el => {
        const r = el.getBoundingClientRect();
        return [el.dataset.unit, { x: (r.x-v.x)/v.zoom, y: (r.y-top-v.y)/v.zoom, w: r.width/v.zoom, h: r.height/v.zoom }];
      }));
      let overlaps = 0, minGap = Infinity;
      const list = Object.values(rects);
      for (let i=0;i<list.length;i++) for (let j=i+1;j<list.length;j++) {
        const a=list[i], b=list[j];
        if (Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1) {
          const gap = a.y<b.y ? b.y-a.y-a.h : a.y-b.y-b.h;
          minGap=Math.min(minGap,gap); if (gap < -1) overlaps++;
        }
      }
      const value = { label, rects, overlaps, minGap, snapshot: p.snapshot() };
      out.stages.push(value); return value;
    }
    const baseline = geometry('baseline');
    out.initial = { paragraph: original, bodyCharacters: body.textContent.length,
      images: [...body.querySelectorAll('img')].map(x => ({src:x.getAttribute('src'),width:x.naturalWidth})),
      mathfields: body.querySelectorAll('math-field').length, assetErrors: p.assetErrors };
    check('500 managed dynamic objects, real heavy bodies', Object.keys(baseline.rects).length===500 &&
      baseline.snapshot.mode==='managed' && baseline.snapshot.dynamic && baseline.snapshot.heavyBodies>0 &&
      baseline.snapshot.heavyBodies<500 && body.textContent.length>500 && original.length>10, out.initial);
    check('initial real source images loaded', !p.assetErrors.length && out.initial.images.every(x=>x.width>0));
    summary.click(); await settle();
    const expanded=geometry('material expanded');
    check('native DOM disclosure changes measured height and projection',
      expanded.rects['KU-001'].h>baseline.rects['KU-001'].h+100 && expanded.overlaps===0,
      { before:baseline.rects['KU-001'].h,after:expanded.rects['KU-001'].h });

    formula.focus(); formula.value='x+1'; formula.executeCommand('moveToMathfieldEnd');
    formula.insert('+2'); formula.dispatchEvent(new Event('input',{bubbles:true})); await pause(150);
    const mathBefore={value:formula.value,selection:JSON.stringify(formula.selection),position:formula.position,
      focused:document.activeElement===formula,readOnly:formula.readOnly};
    const mathHeight=source.getBoundingClientRect().height/p.viewport().zoom;
    p.emit(0, original.repeat(8)); await settle();
    const grown=geometry('growth while MathLive focused');
    out.math={before:mathBefore,after:{value:formula.value,selection:JSON.stringify(formula.selection),position:formula.position,
      focused:document.activeElement===formula,sameNode:source.querySelector('.probe-editors math-field')===formula}};
    check('MathLive API edit and caret/focus survive actual content growth',mathBefore.value==='x+1+2' && mathBefore.focused && !mathBefore.readOnly &&
      out.math.after.value===mathBefore.value && out.math.after.focused && out.math.after.sameNode &&
      out.math.after.selection===mathBefore.selection,out.math);
    check('actual paragraph patch drives RO projection without overlap',paragraph.textContent===original.repeat(8) &&
      grown.rects['KU-001'].h>mathHeight+100 && grown.overlaps===0 &&
      grown.snapshot.sizeReports>expanded.snapshot.sizeReports && grown.snapshot.layoutCommits>expanded.snapshot.layoutCommits,
      {height:grown.rects['KU-001'].h,paragraphCharacters:paragraph.textContent.length});

    formula.blur(); document.querySelector('select').focus(); await pause(150); p.emit(0,original); await settle();
    const text=paragraph.firstChild, range=document.createRange();
    range.setStart(text,0);range.setEnd(text,Math.min(12,text.length));
    const selection=getSelection(); selection.removeAllRanges();selection.addRange(range);
    await pause(100);
    const selectedBefore={text:selection.toString(),rangeText:range.toString(),y:range.getBoundingClientRect().y,
      userSelect:getComputedStyle(paragraph).userSelect,collapsed:selection.isCollapsed,
      anchorOffset:selection.anchorOffset,focusOffset:selection.focusOffset,rangeCount:selection.rangeCount};
    const deferredBefore=p.snapshot().deferredUpdates;
    p.emit(0, original.repeat(4)); await settle();
    const selectedAfter={text:selection.toString(),y:selection.getRangeAt(0).getBoundingClientRect().y,
      sameText:paragraph.firstChild===text,pending:paragraph.dataset.pendingPatch};
    out.selection={before:selectedBefore,after:selectedAfter,ancestors:[]};
    for(let el=paragraph;el;el=el.parentElement)out.selection.ancestors.push({tag:el.tagName,class:el.className,
      userSelect:getComputedStyle(el).userSelect,webkitUserSelect:getComputedStyle(el).webkitUserSelect});
    check('DOM Range selection and Text survive same-paragraph patch',selectedBefore.text.length>0 && selectedAfter.text===selectedBefore.text &&
      selectedAfter.sameText && selectedAfter.pending==='true' && Math.abs(selectedAfter.y-selectedBefore.y)<1 &&
      p.snapshot().deferredUpdates>deferredBefore,out.selection);
    selection.removeAllRanges(); await settle();
    check('deferred patch reaches actual DOM after selection release',paragraph.textContent===original.repeat(4),
      {characters:paragraph.textContent.length,expectedCharacters:original.length*4,activeElement:document.activeElement?.tagName,pending:paragraph.dataset.pendingPatch});

    p.setViewport({x:95,y:35,zoom:.7}); await settle();
    const start=performance.now(), events=[]; let frames=0, violations=0;
    let active=true; const visibilityEvents=[{at:0,state:document.visibilityState,hasFocus:document.hasFocus()}];
    const visibilityListener=()=>visibilityEvents.push({at:performance.now()-start,state:document.visibilityState,hasFocus:document.hasFocus()});
    document.addEventListener('visibilitychange',visibilityListener);
    function camera() {
      if (!active) return;
      const t=performance.now()-start;
      p.setViewport({x:95+12*Math.sin(t/700),y:35+8*Math.sin(t/900),zoom:.7+.005*Math.sin(t/800)});
      if (!body.isConnected || source.querySelector('.source-content')!==body) violations++;
      frames++; requestAnimationFrame(camera);
    }
    requestAnimationFrame(camera);
    for (let i=0;i<8;i++) {
      const value=original.repeat(4+i)+'（宿主隔离更新 '+i+'）';
      p.emit(0,value); await pause(120);
      events.push({index:i,applied:paragraph.textContent===value,viewport:p.viewport(),
        height:source.getBoundingClientRect().height/p.viewport().zoom});
    }
    active=false; await settle();document.removeEventListener('visibilitychange',visibilityListener);
    const final=geometry('after bounded camera and paragraph updates');
    out.camera={durationMs:performance.now()-start,frames,violations,events,visibilityEvents};
    check('bounded continuous camera plus eight actual updates',frames>5 && violations===0 && events.every(x=>x.applied) &&
      new Set(events.map(x=>x.viewport.x)).size>2 && final.overlaps===0,out.camera);
    out.final={paragraphCharacters:paragraph.textContent.length,sameBody:source.querySelector('.source-content')===body,
      snapshot:p.snapshot(),sourceRect:source.getBoundingClientRect().toJSON(),visibility:document.visibilityState,
      hasFocus:document.hasFocus(),layoutPending:p.layout().pending};
    if(!selectedBefore.text.length){
      // A separately labeled, temporary CSS diagnostic. Original-path checks above stay failed.
      const diagnosticStyle=document.createElement('style');diagnosticStyle.textContent='.unit-body{-webkit-user-select:text}';
      document.head.append(diagnosticStyle);await pause(100);
      const candidate=document.createRange();candidate.setStart(paragraph.firstChild,0);candidate.setEnd(paragraph.firstChild,12);
      selection.removeAllRanges();selection.addRange(candidate);await pause(100);
      out.selectionPrefixDiagnostic={injectedCSS:diagnosticStyle.textContent,selectedText:selection.toString(),
        rangeText:candidate.toString(),webkitUserSelect:getComputedStyle(paragraph).webkitUserSelect};
      selection.removeAllRanges();diagnosticStyle.remove();
    }
    window.spikeMathfield=formula;
  } catch (e) { out.failure=String(e.stack || e); }
  out.errors=window.spikeErrors || [];
  return out;
})()
