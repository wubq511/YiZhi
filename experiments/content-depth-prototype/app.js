/* Disposable, local reading prototype. UI state is held in this page only. */
(() => {
  'use strict';
  const data = window.COURSE_DATA;
  const content = window.READING_CONTENT;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const units = new Map(data.units.map(u => [u.id, u]));
  const themes = new Map(data.themes.map(t => [t.id, t]));
  const states = new Map(data.units.map(u => [u.id, '待复习']));
  const themeOrder = ['TH-08','TH-09','TH-10','TH-13','TH-14'];
  const themePlacement = {
    'TH-08':{col:0,row:0,main:true,first:'KU-034',short:'卡诺图基础与化简',outcome:'从格雷排列和相邻规则开始，再学习圈组化简及其扩展。',terms:['相邻规则','圈组化简','覆盖与扩展']},
    'TH-09':{col:1,row:0,main:false,first:'KU-039',short:'无关项与或-与式',outcome:'在圈组方法的基础上，分别学习利用无关项和合并 0。',terms:['无关项','最大项法']},
    'TH-10':{col:2,row:0,main:false,first:'KU-044',short:'组合逻辑设计',outcome:'从输入输出的定义出发，经过真值表和化简得到电路。',terms:['设计步骤','可选化简路线']},
    'TH-13':{col:0,row:1,main:true,first:'KU-055',short:'复用器 MUX',outcome:'先理解如何选择输入，再学习实现函数和扩展通道。',terms:['功能与表达式','函数实现','级联扩展']},
    'TH-14':{col:1,row:1,main:true,first:'KU-063',short:'译码器 74LS138',outcome:'先判断是否允许工作，再根据地址确定哪一路输出有效。',terms:['使能条件','地址位序','低有效输出']}
  };
  const unitOrder = ['KU-034','KU-035','KU-036','KU-037','KU-039','KU-040','KU-044','KU-055','KU-056','KU-057','KU-063'];
  // Columns follow dependencies; independent extensions share the following column.
  const unitPlacement = {'KU-034':[0,0],'KU-035':[1,0],'KU-036':[2,0],'KU-037':[2,1],'KU-039':[0,0],'KU-040':[1,0],'KU-044':[0,0],'KU-055':[0,0],'KU-056':[1,0],'KU-057':[1,1],'KU-063':[0,0]};
  const shortNames = {'KU-034':'卡诺图的排列与相邻规则','KU-035':'卡诺图圈组化简','KU-036':'质蕴含与最简覆盖','KU-037':'5–6 变量卡诺图','KU-039':'利用无关项化简','KU-040':'求最简或-与式','KU-044':'组合逻辑设计流程','KU-055':'MUX 的功能与表达式','KU-056':'用 MUX 实现逻辑函数','KU-057':'MUX 器件与级联扩展','KU-063':'74LS138 的使能与输出'};
  const readingSummaries = {
    'KU-034':'先了解每个格子代表什么，以及为什么首尾也相邻。',
    'KU-035':'把相邻的 1 合并成组，保留组内不变的变量，写出化简结果。',
    'KU-036':'找出不能继续扩大的圈，再选择能够覆盖全部 1 的最简组合。',
    'KU-037':'把四变量卡诺图的方法扩展到多张子图，判断跨图的相邻关系。',
    'KU-039':'利用不影响功能的输入组合扩大圈组，进一步简化表达式。',
    'KU-040':'合并卡诺图中的 0，再通过取反得到或-与式。',
    'KU-044':'定义输入输出，列出真值表，再化简、实现并验证电路。',
    'KU-055':'选择端决定接通哪一个数据端，输出等于该数据端的值。',
    'KU-056':'确定选择变量，再逐组求出每个数据端应连接的信号。',
    'KU-057':'认识常见 MUX 器件，并用多级连接增加可选择的通道数。',
    'KU-063':'检查使能电平，再按地址找到输出为 0 的那一路。'
  };
  const sourcePages = {
    'KU-034':['c03-p07.png'],'KU-036':['c03-p14.png'],'KU-037':['c03-p19.png'],
    'KU-039':['c03-p23.png'],'KU-040':['c03-p29.png'],'KU-044':['c04-p19.png'],'KU-057':['c05-p13.png']
  };
  const kindNames={concept:'概念与规律',method:'方法与技能',module:'模块与器件',device:'模块与器件'};
  const typeNames={requires:'学习前置',constructs:'构造',improves:'优化方法',inverse:'互逆'};
  const camera={x:0,y:0,scale:0.25};
  const history=[];
  const mux={s1:0,s0:1,z:0};
  const decoder={a2:0,a1:0,a0:1,s1:1,s2:0,s3:0};
  const viewport=$('#viewport'),world=$('#world');
  const rgen=rough.generator();
  let selected='KU-034',relationMode='main',mode='overview',drag=null,framePending=false,toastTimer;
  let paintPending=false,spacePressed=false,minimapDirty=true,animation=0;
  const unitRects=new Map(),themeRects=new Map();
  let boardBounds={x:0,y:0,w:14000,h:7000};
  let corners=false,initialized=false,autoCollapsedMap=false;
  const NS='http://www.w3.org/2000/svg';
  const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const markup=s=>MathLive.convertLatexToMarkup(s,{displayMode:false});
  const stars=n=>'★'.repeat(n)+'☆'.repeat(5-n);
  const seed=s=>[...s].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,17)%2147483646+1;

  function svgEl(tag,attrs={},text){const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text!==undefined)el.textContent=text;return el;}
  function paths(svg,drawable,attrs={}){for(const p of rgen.toPaths(drawable))svg.append(svgEl('path',{d:p.d,stroke:p.stroke,'stroke-width':p.strokeWidth,fill:p.fill||'none','stroke-linecap':'round','stroke-linejoin':'round',...attrs}));}
  function line(svg,d,color='#7798bc',width=1.8,s=17){paths(svg,rgen.path(d,{stroke:color,strokeWidth:width,roughness:.8,bowing:1.35,preserveVertices:true,seed:s}));}
  function rect(svg,x,y,w,h,stroke='#7798bc',fill='none',s=77){paths(svg,rgen.rectangle(x,y,w,h,{stroke,fill,fillStyle:'solid',roughness:1.45,bowing:1.35,preserveVertices:true,strokeWidth:1.5,seed:s,disableMultiStrokeFill:true}));}
  function txt(svg,x,y,text,size=25,cls='',anchor='start'){svg.append(svgEl('text',{x,y,'font-size':size,class:cls,'text-anchor':anchor},text));}
  function circle(svg,x,y,r,stroke,fill='white'){svg.append(svgEl('circle',{cx:x,cy:y,r,stroke,fill,'stroke-width':1.8}));}

  function renderMath(root=document){root.querySelectorAll('[data-math]').forEach(el=>{el.innerHTML=markup(el.dataset.math);});}
  function contextBody(u){
    const explanations={
      'KU-034':['卡诺图的每个格子对应一个最小项。行、列按格雷码排列，使上下或左右相邻的格子只差一个变量。','两位坐标常按 00、01、11、10 排列。首列与末列、首行与末行也相邻，因此四变量卡诺图的四个角可以连成一组。','理解这些相邻关系后，再学习怎样圈组并消去变化的变量。'],
      'KU-036':['一个圈如果不能再扩展为更大的合法圈，它对应的项就是质蕴含。','如果某个 1 只被一个质蕴含覆盖，这个质蕴含就是必要质蕴含，化简时必须保留。','先找出全部质蕴含，再选出必要质蕴含；若还有未覆盖的 1，再选择其他质蕴含补足覆盖。'],
      'KU-037':['变量增多时，可以用多张较小的卡诺图表示同一个函数：五变量常用两张四变量子图，六变量可以用四张。','除了图内相邻，还要检查子图之间的相邻关系。选择码只差一位的两张子图，其对应位置可以相邻。','跨子图圈组仍须组成合法的 2ᵏ 格组合，不能把任意子图中的对应格直接合并。'],
      'KU-039':['有些输入组合不会出现，或它们的输出取 0、取 1 都不影响电路要求。这些组合可以记为无关项 d。','圈组时，如果加入某个 d 能扩大圈，就把它当作 1；如果没有帮助，可以不把它圈入。每个 d 可以分别选择，不必全部取同一个值。','无关项的自由选择只用于化简，不能把它当作题目已确定的输出值。'],
      'KU-040':['要求或-与式时，可以从卡诺图中的 0 入手。把这些 0 看作 F′ 的 1，先圈组求出 F′，再取反得到 F。','另一种做法是先对原函数取反，化简 F′，最后再取反。两种方法都需要在最后一步使用德摩根律。'],
      'KU-044':['组合逻辑设计从题目要求出发，依次完成下面四步。','① 定义输入、输出及其符号。② 列出真值表。③ 选择合适的方法化简函数。④ 用指定器件实现，并验证结果。','化简可以选代数法，也可以选卡诺图法，两种方法不必同时使用。器件、门数、延迟等题目约束也要在实现时检查。'],
      'KU-057':['常见器件包括双路 4 选 1 的 74153、8 选 1 的 74151 和 16 选 1 的 74150。','74153 的 G 是低有效使能端，A、B 是两路 MUX 共用的选择端，Y 是输出端。使用前应先确认使能和选择端的含义。','需要更多输入通道时，可以把多个 MUX 分级连接。先看每一级选择哪一组信号，再确定最后输出来自哪一路。']
    };
    return (explanations[u.id]||[u.summary]).map((s,i)=>`<p class="${i===0?'lead':'context-caution'}">${esc(s)}</p>`).join('');
  }
  function unitHTML(u){
    const c=content[u.id];
    const stateControl=`<div class="unit-meta"><span class="unit-stars" title="课程重要性 ${u.rating.stars} 星">${stars(u.rating.stars)}</span><select class="state-picker" data-state-unit="${u.id}" aria-label="${esc(u.name)}复习状态"><option>待复习</option><option>薄弱</option><option>已掌握</option></select></div>`;
    const siblings=unitOrder.filter(id=>units.get(id).themeId===u.themeId),index=siblings.indexOf(u.id),next=siblings[index+1];
    return `<article class="unit frame tint-neutral ${c?'primary-unit':'context-unit'}" id="${u.id}" data-unit="${u.id}"><div class="unit-heading"><div><div class="unit-kicker">${index+1} / ${siblings.length} · ${kindNames[u.kind]||'知识单元'}</div><h3>${esc(c?.title||u.name)}</h3></div>${stateControl}</div><div class="unit-content">${c?c.body:contextBody(u)}</div><div class="unit-footer"><button data-source="${u.id}">课程来源 ↗</button><button data-related="${u.id}">查看相关知识</button>${next?`<button class="next-unit" data-focus="${next}">继续阅读：${shortNames[next]} →</button>`:'<button class="next-unit" data-fit-theme>查看本主题的全部单元</button>'}</div><button class="unit-glance" data-focus="${u.id}" aria-label="阅读${shortNames[u.id]}"><span class="glance-number">${index+1} / ${siblings.length}</span><h3>${shortNames[u.id]}</h3><p>${readingSummaries[u.id]}</p><span class="glance-enter">点击阅读 ↗</span></button></article>`;
  }
  function renderBoard(){
    $('#themes').innerHTML=themeOrder.map(id=>{
      const t=themes.get(id),p=themePlacement[id],list=unitOrder.filter(uid=>units.get(uid).themeId===id);
      return `<section class="theme ${p.main?'theme-main':'theme-context'}" data-theme="${id}"><div class="theme-overview frame ${p.main?'tint-blue':'tint-neutral'}" role="button" tabindex="0" data-focus="${p.first}" aria-label="阅读${p.short}"><div class="chapter-label">${t.lessonId==='L03'?'03 / 卡诺图':t.lessonId==='L04'?'04 / 组合逻辑设计':'05 / 组合模块'}</div><h2>${esc(t.name)}</h2><p class="overview-outcome">${p.outcome}</p><div class="overview-terms">${p.terms.map(s=>`<span>${s}</span>`).join('')}</div><div class="rating" title="主题整体重要性">${stars(t.rating.stars)}</div><p class="overview-state" data-theme-state="${id}"></p><span class="overview-enter">从第一个单元开始 ↗</span></div><div class="theme-heading"><div class="chapter-label">${t.lessonId.slice(1)} / 知识主题</div><h2>${esc(t.name)} <span>${stars(t.rating.stars)}</span></h2><p class="theme-subline" data-theme-state="${id}"></p></div><div class="theme-units">${list.map(uid=>unitHTML(units.get(uid))).join('')}</div></section>`;
    }).join('');
    renderMath();
    updateThemeStates();
    renderNavigation();
    updateInteractiveContent();
  }
  function renderNavigation(){
    $('#nav-items').innerHTML=themeOrder.map((id,i)=>{
      const t=themes.get(id),p=themePlacement[id],list=unitOrder.filter(uid=>units.get(uid).themeId===id);
      const chapter=i===0?'03 · 卡诺图与化简':i===2?'04 · 组合逻辑设计':i===3?'05 · 组合模块':'';
      return `${chapter?`<div class="nav-chapter">${chapter}</div>`:''}<div class="nav-group"><button data-focus="${p.first}">${esc(p.short)}</button>${list.map((uid,n)=>`<button class="nav-unit" data-focus="${uid}">${n+1}. ${shortNames[uid]}</button>`).join('')}</div>`;
    }).join('');
  }
  function updateThemeStates(){
    for(const id of themeOrder){const list=data.units.filter(u=>u.themeId===id).map(u=>u.id);const mastered=list.filter(uid=>states.get(uid)==='已掌握').length,weak=list.filter(uid=>states.get(uid)==='薄弱').length;
      $$(`[data-theme-state="${id}"]`).forEach(el=>{el.textContent=list.length?`本页单元：已掌握 ${mastered}/${list.length}${weak?' · 薄弱 '+weak:''}`:'关联摘要 · 可沿关系回到原处';});}
  }
  function frameSize(el){return {width:el.offsetWidth,height:el.offsetHeight};}
  function drawFrames(){
    $$('.frame').forEach(el=>{
      if(!el.offsetHeight||!el.offsetWidth||el.closest('[hidden]'))return;
      const {width:w,height:h}=frameSize(el),drawingScale=el.classList.contains('theme-overview')?12:el.classList.contains('unit')&&mode==='units'?4:1;const sig=`${w}:${h}:${drawingScale}`;
      if(el.dataset.frameSize===sig)return;
      el.dataset.frameSize=sig;
      let svg=[...el.children].find(x=>x.classList.contains('sketch-border'));
      if(!svg){svg=svgEl('svg',{class:'sketch-border','aria-hidden':'true'});el.prepend(svg);}
      svg.setAttribute('viewBox',`0 0 ${w/drawingScale} ${h/drawingScale}`);svg.replaceChildren();
      const styles=getComputedStyle(el),stroke=styles.getPropertyValue('--frame-line').trim()||'#aebecb',fill=styles.getPropertyValue('--frame-fill').trim()||'#fff';
      rect(svg,4,4,w/drawingScale-8,h/drawingScale-8,stroke,fill,seed(el.id||el.parentElement.dataset.theme||el.className));
    });
  }
  function layout(){
    // Measure the full content once; zoom changes presentation, never these positions.
    unitRects.clear();themeRects.clear();
    for(const id of themeOrder){
      const theme=$(`[data-theme="${id}"]`),p=themePlacement[id];
      const list=unitOrder.filter(uid=>units.get(uid).themeId===id),columns=new Map();
      for(const uid of list){const el=document.getElementById(uid),[col,row]=unitPlacement[uid];const y=row?(columns.get(col)||230)+170:230;el.style.left=(30+1440*col)+'px';el.style.top=y+'px';columns.set(col,y+el.offsetHeight);}
      const h=Math.max(2900,...columns.values())+120;
      const above=p.row?themeRects.get(themeOrder.find(t=>themePlacement[t].row===0&&themePlacement[t].col===p.col)):null;
      const x=120+p.col*4800,y=p.row?Math.max(3600,above.y+above.h+440):620;
      theme.style.left=x+'px';theme.style.top=y+'px';theme.style.width='4250px';theme.style.height=h+'px';
      themeRects.set(id,{x,y,w:4250,h});
      for(const uid of list){const el=document.getElementById(uid);unitRects.set(uid,{x:x+el.offsetLeft,y:y+el.offsetTop,w:el.offsetWidth,h:el.offsetHeight});}
    }
    boardBounds={x:0,y:0,w:Math.max(...[...themeRects.values()].map(b=>b.x+b.w))+120,h:Math.max(...[...themeRects.values()].map(b=>b.y+b.h))+120};
    world.style.width=boardBounds.w+'px';world.style.height=boardBounds.h+'px';
    drawFrames();drawRelations();minimapDirty=true;paintCamera();
  }
  function scheduleLayout(){if(framePending)return;framePending=true;requestAnimationFrame(()=>{framePending=false;layout();});}
  function unitBox(id){return unitRects.get(id);}
  function themeBox(id){return themeRects.get(id);}
  function themeUnitBounds(id=units.get(selected).themeId){
    const boxes=unitOrder.filter(uid=>units.get(uid).themeId===id).map(unitBox).filter(Boolean);
    const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
    return{x,y,w:Math.max(...boxes.map(b=>b.x+b.w))-x,h:Math.max(...boxes.map(b=>b.y+b.h))-y};
  }
  function fitScale(box){return Math.min((viewport.clientWidth-110)/box.w,(viewport.clientHeight-165)/box.h);}
  function overviewThreshold(){return Math.max(.018,Math.min(.11,fitScale(themeUnitBounds())*.42));}
  function readingScale(){return Math.min(.86,(viewport.clientWidth-100)/1040);}
  function setSelected(id){selected=id;$$('.nav-unit').forEach(b=>b.classList.toggle('active',b.dataset.focus===id));if(relationMode==='related'){renderRelationPanel();drawRelations();}minimapDirty=true;if(initialized)requestPaint();}
  function remember(){history.push({...camera,selected,mode});$('#back').disabled=false;}
  function setMode(next){
    if(next===mode&&viewport.classList.contains(next+'-mode'))return;
    mode=next;for(const m of ['overview','units','detail'])viewport.classList.toggle(m+'-mode',mode===m);
    drawFrames();drawRelations();minimapDirty=true;
  }
  function paintCamera(){
    world.style.transform=`translate3d(${camera.x}px,${camera.y}px,0) scale(${camera.scale})`;
    world.style.setProperty('--relation-stroke',1.05/camera.scale+'px');
    world.style.setProperty('--map-title',16/camera.scale+'px');world.style.setProperty('--map-copy',12/camera.scale+'px');world.style.setProperty('--map-small',10/camera.scale+'px');
    world.style.setProperty('--overview-title',18/camera.scale+'px');world.style.setProperty('--overview-copy',11/camera.scale+'px');
    $('#zoom-label').textContent=Math.round(camera.scale*100)+'%';
    $('#depth-label').textContent={overview:'主题总览',units:'主题内单元全览',detail:'单元阅读'}[mode];
    $('#location-label').textContent=mode==='overview'?'整张画板':mode==='units'?themePlacement[units.get(selected).themeId].short:shortNames[selected];
    $('#theme-fit').hidden=mode==='overview';
    if(mode==='units')for(const [id,b] of unitRects)document.getElementById(id).classList.toggle('compact-glance',b.h*camera.scale<160);
    $$('#relations-layer [data-label-x]').forEach(el=>el.setAttribute('transform',`translate(${el.dataset.labelX} ${el.dataset.labelY}) scale(${1/camera.scale})`));
    drawMinimap();
  }
  function requestPaint(){if(paintPending)return;paintPending=true;requestAnimationFrame(()=>{paintPending=false;paintCamera();});}
  function moveCamera(target,nextMode,animate=true){
    cancelAnimationFrame(animation);animation=0;setMode(nextMode);
    if(!animate||window.matchMedia('(prefers-reduced-motion: reduce)').matches){Object.assign(camera,target);paintCamera();return;}
    const start={...camera},at=performance.now();
    const tick=now=>{const t=Math.min(1,(now-at)/180),ease=1-Math.pow(1-t,3);for(const k of ['x','y','scale'])camera[k]=start[k]+(target[k]-start[k])*ease;paintCamera();if(t<1)animation=requestAnimationFrame(tick);else animation=0;};
    animation=requestAnimationFrame(tick);
  }
  function focusUnit(id,record=true){
    if(record)remember();setSelected(id);const box=unitBox(id),scale=readingScale();
    moveCamera({scale,x:(viewport.clientWidth-box.w*scale)/2-box.x*scale,y:72-box.y*scale},'detail');
  }
  function fitTheme(record=true){
    if(record)remember();const b=themeUnitBounds(),scale=Math.min(readingScale()*.64,fitScale(b));
    moveCamera({scale,x:(viewport.clientWidth-b.w*scale)/2-b.x*scale,y:70+(viewport.clientHeight-150-b.h*scale)/2-b.y*scale},'units');
  }
  function fit(record=true){
    if(record)remember();const b=boardBounds,scale=Math.max(.012,Math.min(fitScale(b),overviewThreshold()*.8));
    moveCamera({scale,x:(viewport.clientWidth-b.w*scale)/2-b.x*scale,y:65+(viewport.clientHeight-150-b.h*scale)/2-b.y*scale},'overview',record);
  }
  function zoom(factor,x=viewport.clientWidth/2,y=viewport.clientHeight/2){
    cancelAnimationFrame(animation);animation=0;
    const next=Math.max(.012,Math.min(3,camera.scale*factor));if(next===camera.scale)return;
    // Excalidraw's pointer-anchored transform, with limits applied before the ratio.
    const ratio=next/camera.scale;camera.x=x-(x-camera.x)*ratio;camera.y=y-(y-camera.y)*ratio;camera.scale=next;
    const threshold=overviewThreshold(),detailThreshold=readingScale()*.66;
    if(mode==='overview'&&factor>1&&next>threshold*1.2){focusUnit(themePlacement[units.get(selected).themeId].first);return;}
    if(mode!=='overview'&&next<threshold)setMode('overview');
    else if(mode==='detail'&&next<detailThreshold)setMode('units');
    else if(mode==='units'&&next>detailThreshold*1.1)setMode('detail');
    requestPaint();
  }
  function visibleEdges(){if(relationMode==='main')return data.edges.filter(e=>e.view==='main');if(relationMode==='all')return data.edges;return data.edges.filter(e=>e.fromUnitId===selected||e.toUnitId===selected);}
  function relationLabel(e){if(e.id==='REL-011')return'化简路线（可选）';if(e.id==='REL-014')return'级联扩展';return typeNames[e.type]||e.type;}
  function arrow(svg,d,ex,ey,direction,color,s,dashed=false){
    const group=svgEl('g',{'data-edge':s});const drawable=rgen.path(d,{stroke:color,strokeWidth:mode==='overview'?3:2,roughness:1,bowing:1.35,preserveVertices:true,seed:seed(s)});
    paths(group,drawable,dashed?{'stroke-dasharray':'8 6'}:{});
    const size=mode==='overview'?170:mode==='units'?38:12;
    const pts=direction==='down'?[[ex-size*.45,ey-size],[ex,ey],[ex+size*.45,ey-size]]:direction==='left'?[[ex+size,ey-size*.45],[ex,ey],[ex+size,ey+size*.45]]:[[ex-size,ey-size*.45],[ex,ey],[ex-size,ey+size*.45]];
    line(group,`M${pts[0]}L${pts[1]}L${pts[2]}`,color,mode==='overview'?3:2,seed(s+'arrow'));svg.append(group);
  }
  function relationText(svg,x,y,label){
    const w=label.length*12+18,g=svgEl('g',{'data-label-x':x,'data-label-y':y,transform:`translate(${x} ${y}) scale(${1/camera.scale})`});
    g.append(svgEl('rect',{x:-w/2,y:-17,width:w,height:24,fill:'white',rx:4}));
    g.append(svgEl('text',{x:0,y:0,class:'relation-label','text-anchor':'middle'},label));svg.append(g);
  }
  function drawRelations(){
    const svg=$('#relations-layer');svg.replaceChildren();svg.setAttribute('width',boardBounds.w);svg.setAttribute('height',boardBounds.h);
    if(!unitRects.size)return;
    const edges=visibleEdges(),groups=[];
    if(mode==='overview'){
      const seen=new Map();for(const e of edges){const from=units.get(e.fromUnitId).themeId,to=units.get(e.toUnitId).themeId;if(from===to)continue;const key=from+to;if(!seen.has(key))seen.set(key,{a:themeBox(from),b:themeBox(to),e,label:e.id==='REL-011'?'卡诺图化简路线（代数法可替代）':'圈组方法的扩展'});}
      groups.push(...seen.values());
    }else for(const e of edges)groups.push({a:unitBox(e.fromUnitId),b:unitBox(e.toUnitId),e,label:relationLabel(e)});
    let crossLane=0;
    for(const {a,b,e,label} of groups){
      const aux=e.view==='auxiliary',color=aux?'#9584b1':e.type==='constructs'?'#5f967e':'#7b94a6';
      const same=units.get(e.fromUnitId).themeId===units.get(e.toUnitId).themeId;
      const sy=a.y+Math.min(a.h*.32,mode==='overview'?700:140),ey=b.y+Math.min(b.h*.32,mode==='overview'?700:140),sx=a.x+a.w,ex=b.x;
      if(mode==='overview'||!same){
        const fromTheme=themeBox(units.get(e.fromUnitId).themeId),toTheme=themeBox(units.get(e.toUnitId).themeId);
        const lane=Math.min(fromTheme.y,toTheme.y)-180-crossLane++*260;
        arrow(svg,`M${sx} ${sy}H${sx+100}V${lane}H${ex-100}V${ey}H${ex}`,ex,ey,'right',color,e.id,aux);
        relationText(svg,(sx+ex)/2,lane-25,label);
      }else{
        const lane=(sx+ex)/2;
        arrow(svg,`M${sx} ${sy}H${lane}V${ey}H${ex}`,ex,ey,'right',color,e.id,aux);
        relationText(svg,lane,sy===ey?sy-28:(sy+ey)/2,label);
      }
    }
  }
  function renderRelationPanel(){
    const edges=visibleEdges();$$('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===relationMode)));
    $('#relation-summary').textContent=relationMode==='related'?`${units.get(selected).name}：${edges.length?edges.length+' 条已审核关系':'当前没有已审核关系'}`:relationMode==='all'?'本页 8 条已审核关系：5 条主关系、3 条辅助关系。':'常态显示 5 条主关系。辅助关系可从“当前相关”或“全部关系”查看。';
    $('#relation-list').innerHTML=edges.map(e=>`<article class="relation-item"><span class="relation-kind">${e.view==='main'?'主关系':'辅助关系'} · ${relationLabel(e)}</span><h3>${esc(units.get(e.fromUnitId).name)}<br>↓ ${esc(units.get(e.toUnitId).name)}</h3><p>${esc(e.value)}</p>${e.id==='REL-011'?'<p>设计的化简步骤可以选择代数法或卡诺图；这条箭头不是要求两条路线同时满足。</p>':''}<button data-focus="${e.fromUnitId}">前往起点</button><button data-focus="${e.toUnitId}">前往目标</button><button data-edge-source="${e.id}">查看依据</button></article>`).join('');
  }
  function syncPanelSpace(){const cramped=(!$('#relationship-panel').hidden||!$('#source-panel').hidden)&&viewport.clientWidth<1050;if(cramped&&!$('#minimap-panel').hidden){autoCollapsedMap=true;$('#minimap-panel').hidden=true;$('#minimap-open').hidden=false;}else if(!cramped&&autoCollapsedMap){$('#minimap-panel').hidden=false;$('#minimap-open').hidden=true;autoCollapsedMap=false;}}
  function panelChange(fn){const old=viewport.clientWidth;fn();camera.x+=(viewport.clientWidth-old)/2;syncPanelSpace();paintCamera();}
  function openRelations(id,related=false){if(id)setSelected(id);if(related)relationMode='related';panelChange(()=>{$('#source-panel').hidden=true;$('#relationship-panel').hidden=false;});$('#relations-toggle').setAttribute('aria-expanded','true');renderRelationPanel();drawRelations();}
  function openSource(id,relation=false){const edge=relation?data.edges.find(e=>e.id===id):null;const u=relation?units.get(edge.toUnitId):units.get(id);const edgePages={'REL-007':['c03-p07.png'],'REL-008':['c03-p07.png','c03-p23.png'],'REL-011':['c04-p19.png'],'REL-013':['c05-p04.png','c05-p18.png'],'REL-014':['c05-p13.png'],'REL-034':['c03-p14.png'],'REL-035':['c03-p19.png'],'REL-036':['c03-p29.png']};const pages=relation?edgePages[id]:(content[id]?.sources||sourcePages[id]||[]);$('#source-title').textContent=relation?'关系依据':'课程来源';$('#source-caption').textContent=(relation?edge.value:u.name)+' · 完整原页，可放大核对。';$('#source-pages').innerHTML=pages.map(file=>`<div class="source-page"><p>${esc(SOURCE_CAPTIONS[file]||file)}</p><a href="sources/${file}" target="_blank" rel="noopener"><img src="sources/${file}" alt="${esc(SOURCE_CAPTIONS[file]||file)}" loading="lazy"></a><a href="sources/${file}" target="_blank" rel="noopener">打开完整原页 ↗</a></div>`).join('');panelChange(()=>{$('#relationship-panel').hidden=true;$('#source-panel').hidden=false;});$('#relations-toggle').setAttribute('aria-expanded','false');}
  function drawMinimap(){
    const svg=$('#minimap');if(!svg)return;
    if(minimapDirty){
      svg.setAttribute('viewBox',`0 0 ${boardBounds.w} ${boardBounds.h}`);svg.replaceChildren();
      for(const [id,b] of themeRects){svg.append(svgEl('rect',{x:b.x,y:b.y,width:b.w,height:b.h,fill:themePlacement[id].main?'#e7eff7':'#f1f3f5',stroke:'#a5b9ca','stroke-width':18,rx:35,'data-minimap-theme':id}));}
      if(mode!=='overview')for(const [id,b] of unitRects)svg.append(svgEl('rect',{x:b.x,y:b.y,width:b.w,height:b.h,fill:id===selected?'#c7d9e9':'#fff',stroke:'#9baebf','stroke-width':12,'data-minimap-unit':id}));
      svg.append(svgEl('rect',{id:'minimap-camera',fill:'#6965db10',stroke:'#6965db','stroke-width':22,rx:12,'pointer-events':'none'}));minimapDirty=false;
    }
    const frame=$('#minimap-camera');if(frame)for(const [k,v] of Object.entries({x:-camera.x/camera.scale,y:-camera.y/camera.scale,width:viewport.clientWidth/camera.scale,height:viewport.clientHeight/camera.scale}))frame.setAttribute(k,v);
  }
  function renderMux(svg){svg.replaceChildren();paths(svg,rgen.path('M180 30L360 66V230L180 267Z',{stroke:'#7798bc',fill:'#f6f9fc',fillStyle:'solid',strokeWidth:1.8,roughness:1.45,bowing:1.35,preserveVertices:true,seed:310}));const active=mux.s1*2+mux.s0,values=[mux.z,1-mux.z,0,1],labels=['z','¬z','0','1'];for(let i=0;i<4;i++){const y=63+i*53,on=i===active;line(svg,`M95 ${y}H180`,on?'#286b58':'#c4cdd5',on?3.5:1.6,320+i);txt(svg,20,y+8,`I${i} = ${labels[i]}`,23,on?'output-text':'muted-text');if(on){line(svg,`M180 ${y}Q240 ${y} 270 143H440`,'#286b58',3.5,330+i);circle(svg,180,y,4,'#286b58','#286b58');}}
    txt(svg,270,100,'4:1 MUX',26,'','middle');txt(svg,450,151,'Y',28,'output-text');line(svg,'M270 248V279','#345d88',1.8,340);txt(svg,270,307,`S₁S₀ = ${mux.s1}${mux.s0}`,23,'input-text','middle');$('#mux-result').innerHTML=`选中 I${active}<br><strong>Y = ${labels[active]} = ${values[active]}</strong>`;
  }
  function renderKmap(svg,example=false){svg.replaceChildren();if(example){const x=140,y=70,w=100,h=70;rect(svg,x,y,4*w,2*h,'#7798bc','#fff',510);for(let c=1;c<4;c++)line(svg,`M${x+c*w} ${y}V${y+2*h}`,'#a9bac9',1.2,511+c);line(svg,`M${x} ${y+h}H${x+4*w}`,'#a9bac9',1.2,516);['00','01','11','10'].forEach((v,c)=>txt(svg,x+c*w+w/2,y-18,v,24,'input-text','middle'));line(svg,'M85 15L132 62','#7798bc',1.3,517);txt(svg,80,68,'A',23);txt(svg,115,28,'BC',23);for(let r=0;r<2;r++){txt(svg,x-25,y+r*h+45,String(r),25,'input-text','middle');for(let c=0;c<4;c++)txt(svg,x+c*w+w/2,y+r*h+46,c===0||c===3?'1':'0',30,c===0||c===3?'output-text':'','middle');}line(svg,`M${x-18} ${y+9}Q${x+80} ${y+1} ${x+83} ${y+35}V${y+105}Q${x+80} ${y+139} ${x-18} ${y+132}`,'#286b58',3,519);line(svg,`M${x+418} ${y+9}Q${x+320} ${y+1} ${x+317} ${y+35}V${y+105}Q${x+320} ${y+139} ${x+418} ${y+132}`,'#286b58',3,520);txt(svg,335,260,'左右边界接起来，就是一个四格圈',23,'output-text','middle');return;}
    const x=105,y=65,w=91,h=58,gray=[0,1,3,2];rect(svg,x,y,w*4,h*4,'#7798bc','#fff',410);if(corners){for(const [r,c] of [[0,0],[0,3],[3,0],[3,3]])rect(svg,x+c*w+3,y+r*h+3,w-6,h-6,'#5f967e','#e2f1e8',420+r*4+c);}
    for(let i=1;i<4;i++){line(svg,`M${x+i*w} ${y}V${y+h*4}`,'#acbecb',1.2,440+i);line(svg,`M${x} ${y+i*h}H${x+w*4}`,'#acbecb',1.2,450+i);}
    ['00','01','11','10'].forEach((v,i)=>{txt(svg,x+i*w+w/2,y-17,v,25,'input-text','middle');txt(svg,x-31,y+i*h+39,v,25,'input-text','middle');});line(svg,'M50 12L98 60','#7798bc',1.3,460);txt(svg,28,67,'AB',23);txt(svg,88,25,'CD',23);
    for(let r=0;r<4;r++)for(let c=0;c<4;c++)txt(svg,x+c*w+w/2,y+r*h+39,String(gray[r]*4+gray[c]),27,corners&&[0,3].includes(r)&&[0,3].includes(c)?'output-text':'','middle');
    txt(svg,285,342,'每跨一格，只改变一个变量',22,'muted-text','middle');
  }
  function renderDecoder(svg){svg.replaceChildren();const n=decoder.a2*4+decoder.a1*2+decoder.a0,enabled=decoder.s1===1&&decoder.s2===0&&decoder.s3===0;rect(svg,175,20,150,315,'#7798bc','#f0f5fc',610);txt(svg,250,48,'74LS138',26,'','middle');const addr=[['A₂',decoder.a2],['A₁',decoder.a1],['A₀',decoder.a0]];addr.forEach(([label,value],i)=>{const y=105+i*64;line(svg,`M65 ${y}H175`,'#345d88',1.8,611+i);txt(svg,15,y+8,`${label}=${value}`,24,'input-text');});
    for(let i=0;i<8;i++){const y=68+i*33,on=enabled&&i===n;line(svg,`M337 ${y}H440`,on?'#286b58':'#b2c0cc',on?3.5:1.5,625+i);circle(svg,331,y,6,on?'#286b58':'#7798bc');txt(svg,343,y-8,`Y̅${i}`,19,on?'output-text':'muted-text');txt(svg,457,y+7,on?'0':'1',24,on?'output-text':'muted-text');}
    const inputs=[['S₁',decoder.s1,false],['S̅₂',decoder.s2,true],['S̅₃',decoder.s3,true]];inputs.forEach(([label,val,low],i)=>{const x=202+i*49;if(low)circle(svg,x,342,6,'#7798bc');line(svg,`M${x} ${low?348:335}V378`,'#345d88',1.5,640+i);txt(svg,x,407,`${label}=${val}`,19,'input-text','middle');});
    $('#decoder-result').innerHTML=enabled?`已使能 · 地址 ${decoder.a2}${decoder.a1}${decoder.a0}<br><strong>第 ${n} 路输出为 0</strong><br>其余 7 路为 1`:'使能条件不满足<br><strong>8 路输出全部为 1</strong>';
  }
  function updateInteractiveContent(){
    $$('[data-diagram="mux"]').forEach(renderMux);$$('[data-diagram="kmap"]').forEach(svg=>renderKmap(svg));$$('[data-diagram="kmap-example"]').forEach(svg=>renderKmap(svg,true));$$('[data-diagram="decoder"]').forEach(renderDecoder);
    $$('[data-bit]').forEach(b=>{const state=b.dataset.bitScope==='mux'?mux:decoder;const value=state[b.dataset.bit];b.querySelector('b').textContent=value;b.setAttribute('aria-pressed',String(!!value));});
  }
  function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('#toast').hidden=true;},3500);}

  document.addEventListener('click',event=>{
    const focus=event.target.closest('[data-focus]');if(focus){focusUnit(focus.dataset.focus);return;}
    const unit=event.target.closest('[data-unit]');if(unit)setSelected(unit.dataset.unit);
    if(event.target.closest('[data-fit-theme]')){fitTheme();return;}
    const edgeSource=event.target.closest('[data-edge-source]');if(edgeSource){openSource(edgeSource.dataset.edgeSource,true);return;}
    const source=event.target.closest('[data-source]');if(source){openSource(source.dataset.source);return;}
    const related=event.target.closest('[data-related]');if(related){openRelations(related.dataset.related,true);return;}
    const bit=event.target.closest('[data-bit]');if(bit){const state=bit.dataset.bitScope==='mux'?mux:decoder;state[bit.dataset.bit]=1-state[bit.dataset.bit];updateInteractiveContent();scheduleLayout();return;}
    const reveal=event.target.closest('[data-reveal]');if(reveal){const target=document.getElementById(reveal.dataset.reveal);target.hidden=!target.hidden;reveal.setAttribute('aria-expanded',String(!target.hidden));reveal.textContent=target.hidden?(target.classList.contains('hint')?'看提示':'看答案与步骤'):(target.classList.contains('hint')?'收起提示':'收起答案');scheduleLayout();return;}
    const relmode=event.target.closest('[data-mode]');if(relmode){relationMode=relmode.dataset.mode;renderRelationPanel();drawRelations();}
  });
  document.addEventListener('keydown',event=>{const f=event.target.closest('.theme-overview');if(f&&event.key==='Enter'){event.preventDefault();focusUnit(f.dataset.focus);}});
  document.addEventListener('change',event=>{const id=event.target.dataset.stateUnit;if(id){states.set(id,event.target.value);updateThemeStates();scheduleLayout();}});
  document.addEventListener('toggle',event=>{if(event.target.matches('details'))scheduleLayout();},true);
  document.addEventListener('input',event=>{if(event.target.matches('.unit-note')){event.target.style.height='auto';event.target.style.height=event.target.scrollHeight+'px';scheduleLayout();}});
  $('#themes').addEventListener('click',event=>{if(event.target.id==='kmap-corners'){corners=!corners;event.target.setAttribute('aria-pressed',String(corners));event.target.textContent=corners?'收起四角示意':'看看四角为什么相邻';$('#kmap-corner-copy').textContent=corners?'四角可合并：A、C 变化，B、D 恒为 0':'格内数字是最小项编号';$$('[data-diagram="kmap"]').forEach(svg=>renderKmap(svg));}});
  $('#back').addEventListener('click',()=>{const prev=history.pop();if(!prev)return;Object.assign(camera,{x:prev.x,y:prev.y,scale:prev.scale});setSelected(prev.selected);cancelAnimationFrame(animation);animation=0;setMode(prev.mode);paintCamera();$('#back').disabled=!history.length;});
  $('#theme-fit').addEventListener('click',()=>fitTheme());
  $('#fit').addEventListener('click',()=>fit());$('#zoom-in').addEventListener('click',()=>zoom(1.18));$('#zoom-out').addEventListener('click',()=>zoom(1/1.18));
  $('#nav-close').addEventListener('click',()=>panelChange(()=>{$('#navigation').hidden=true;$('#nav-open').hidden=false;document.body.classList.add('nav-hidden');}));
  $('#nav-open').addEventListener('click',()=>panelChange(()=>{$('#navigation').hidden=false;$('#nav-open').hidden=true;document.body.classList.remove('nav-hidden');}));
  $('#minimap-close').addEventListener('click',()=>{autoCollapsedMap=false;$('#minimap-panel').hidden=true;$('#minimap-open').hidden=false;});$('#minimap-open').addEventListener('click',()=>{autoCollapsedMap=false;$('#minimap-panel').hidden=false;$('#minimap-open').hidden=true;});
  $('#relations-toggle').addEventListener('click',()=>{if($('#relationship-panel').hidden)openRelations();else{panelChange(()=>{$('#relationship-panel').hidden=true;});$('#relations-toggle').setAttribute('aria-expanded','false');}});
  $('#relations-close').addEventListener('click',()=>{panelChange(()=>{$('#relationship-panel').hidden=true;});$('#relations-toggle').setAttribute('aria-expanded','false');});
  $('#source-close').addEventListener('click',()=>panelChange(()=>{$('#source-panel').hidden=true;}));
  $('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('可使用浏览器菜单进入全屏阅读');}});
  $('#search').addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();$('#nav-items').hidden=!!q;$('#search-results').hidden=!q;if(!q)return;const hits=data.units.filter(u=>JSON.stringify([u.name,u.aliases,u.summary,u.internals]).toLowerCase().includes(q));$('#search-results').innerHTML=hits.length?hits.map(u=>`<button class="search-result" data-focus="${u.id}">${esc(u.name)}<small>${esc(u.theme.name)}</small></button>`).join(''):'<p class="panel-copy">本页没有匹配内容。</p>';});
  const isEditing=target=>!!target.closest('input,select,textarea,[contenteditable="true"]');
  const cancelMotion=()=>{cancelAnimationFrame(animation);animation=0;};
  $('#input-mode').addEventListener('change',event=>{$('#gesture-help').textContent=event.target.value==='trackpad'?'双指平移 · 捏合缩放 · 空格 / 中键拖动':'拖动平移 · 捏合缩放 · Shift＋滚轮平移';});
  viewport.addEventListener('wheel',event=>{
    if(event.target.closest('#minimap-panel,.canvas-input'))return;
    event.preventDefault();cancelMotion();
    const unit=event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1,dx=event.deltaX*unit,dy=event.deltaY*unit;
    const pinch=event.ctrlKey||event.metaKey;
    if(event.shiftKey){const delta=dy||dx;if(pinch)camera.y-=delta;else camera.x-=delta;requestPaint();return;}
    if(!pinch&&($('#input-mode').value==='trackpad'||(!dy&&dx))){camera.x-=dx;camera.y-=dy;requestPaint();return;}
    if(mode==='overview'&&dy<0){const theme=event.target.closest('[data-theme]');if(theme)setSelected(themePlacement[theme.dataset.theme].first);}
    const bounds=viewport.getBoundingClientRect();
    // Bound individual steps; keep every event's accumulated motion, then paint once per frame.
    const delta=Math.max(-.28,Math.min(.28,-dy*(pinch?.012:.004)));
    zoom(Math.exp(delta),event.clientX-bounds.left,event.clientY-bounds.top);
    if(drag){drag.ox=camera.x;drag.oy=camera.y;drag.x=drag.lastX;drag.y=drag.lastY;}
  },{passive:false});
  let suppressClick=false;
  viewport.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopPropagation();suppressClick=false;}},true);
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0&&event.button!==1)return;
    if(event.target.closest('#minimap-panel,.canvas-tools,.canvas-input'))return;
    if(event.button===0&&!spacePressed&&event.target.closest('button,input,select,textarea,summary,a,.theme-overview'))return;
    event.preventDefault();cancelMotion();
    drag={pointerId:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,ox:camera.x,oy:camera.y,moved:false};
    viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved=drag.moved||Math.abs(dx)+Math.abs(dy)>3;drag.lastX=event.clientX;drag.lastY=event.clientY;
    camera.x=drag.ox+dx;camera.y=drag.oy+dy;requestPaint();
  });
  const endDrag=event=>{if(drag){suppressClick=event?.type==='pointerup'&&drag.moved;if(viewport.hasPointerCapture(drag.pointerId))viewport.releasePointerCapture(drag.pointerId);}drag=null;viewport.classList.remove('dragging');paintCamera();};
  viewport.addEventListener('pointerup',endDrag);viewport.addEventListener('pointercancel',endDrag);viewport.addEventListener('lostpointercapture',()=>{drag=null;viewport.classList.remove('dragging');});
  viewport.addEventListener('auxclick',event=>{if(event.button===1)event.preventDefault();});
  document.addEventListener('keydown',event=>{if(event.code==='Space'&&!isEditing(event.target)){event.preventDefault();spacePressed=true;viewport.classList.add('space-pan');}});
  document.addEventListener('keyup',event=>{if(event.code==='Space'){spacePressed=false;viewport.classList.remove('space-pan');}});
  window.addEventListener('blur',()=>{spacePressed=false;viewport.classList.remove('space-pan');endDrag();});
  let safariGesture=null;
  viewport.addEventListener('gesturestart',event=>{event.preventDefault();safariGesture={scale:camera.scale};},{passive:false});
  viewport.addEventListener('gesturechange',event=>{if(!safariGesture)return;event.preventDefault();const b=viewport.getBoundingClientRect();zoom(safariGesture.scale*event.scale/camera.scale,event.clientX-b.left,event.clientY-b.top);},{passive:false});
  viewport.addEventListener('gestureend',()=>{safariGesture=null;});
  $('#minimap').addEventListener('click',event=>{
    const unit=event.target.closest('[data-minimap-unit]');if(unit){focusUnit(unit.dataset.minimapUnit);return;}
    const target=event.target.closest('[data-minimap-theme]');if(target){focusUnit(themePlacement[target.dataset.minimapTheme].first);return;}
    const svg=$('#minimap'),point=svg.createSVGPoint();point.x=event.clientX;point.y=event.clientY;const p=point.matrixTransform(svg.getScreenCTM().inverse());cancelMotion();camera.x=viewport.clientWidth/2-p.x*camera.scale;camera.y=viewport.clientHeight/2-p.y*camera.scale;requestPaint();
  });
  let previousSize={w:viewport.clientWidth,h:viewport.clientHeight};
  window.addEventListener('resize',()=>{if(!initialized)return;camera.x+=(viewport.clientWidth-previousSize.w)/2;camera.y+=(viewport.clientHeight-previousSize.h)/2;previousSize={w:viewport.clientWidth,h:viewport.clientHeight};paintCamera();scheduleLayout();});

  renderBoard();
  const observer=new ResizeObserver(scheduleLayout);$$('.unit,.theme-overview').forEach(el=>observer.observe(el));
  viewport.classList.add('overview-mode');layout();fit(false);initialized=true;
  document.fonts.ready.then(()=>{layout();if(mode==='overview')fit(false);});
  // Bounded inspection hook for local acceptance checks; never writes course files.
  window.readingPrototype={getState:()=>({camera:{...camera},mode,selected,relationMode,shownRelations:visibleEdges().map(e=>e.id),openMaterials:$$('details[open]').map(el=>el.id),revealed:$$('.answer,.hint').filter(el=>!el.hidden).map(el=>el.id),statuses:Object.fromEntries(states),mux:{...mux},decoder:{...decoder}})};
})();
