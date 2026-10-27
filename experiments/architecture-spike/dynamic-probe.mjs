import { chromium } from 'playwright-core';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

// A dedicated loopback server and a fresh headless context; never attaches to a user browser.
const reservation = net.createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const server = spawn('python3', ['start.py', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', x => serverLog += x); server.stderr.on('data', x => serverLog += x);
const browser = await chromium.launch({ executablePath: process.env.PROBE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const result = { capturedAt: new Date().toISOString(), scope: 'Frontend isolated sequence; simulated Agent patch; no CourseService or real Agent',
  sample: '500 synthetic objects repeat 84 real course units', environment: { browser: browser.version(), node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, headless: true },
  hashes: {}, checks: [], stages: [] };
for (const file of ['fixture.json','heights.json','src/main.jsx','src/dynamic-layout.js','dist/app.js','dynamic-probe.mjs']) result.hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
const context = await browser.newContext({ viewport: result.environment.viewport, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
function check(name, pass, evidence) { result.checks.push({ name, pass: Boolean(pass), evidence }); if (!pass) throw new Error(name); }
const settle = async () => { await page.waitForTimeout(450); await page.waitForFunction(() => !probe.layout().pending); };
const unit = id => `[data-unit="${id}"]`;
async function geometry(label) {
  const value = await page.evaluate(() => {
    const v = probe.viewport(), board = document.querySelector('.board').getBoundingClientRect();
    const rects = Object.fromEntries([...document.querySelectorAll('[data-unit]')].map(el => {
      const r = el.getBoundingClientRect(); return [el.dataset.unit, { x: (r.x-v.x)/v.zoom, y: (r.y-board.y-v.y)/v.zoom, w: r.width/v.zoom, h: r.height/v.zoom }];
    }));
    let overlaps = 0, minGap = Infinity;
    const entries = Object.entries(rects);
    for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
      const a=entries[i][1], b=entries[j][1];
      if (Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1) {
        const gap = a.y<b.y ? b.y-a.y-a.h : a.y-b.y-b.h;
        minGap = Math.min(minGap,gap); if (gap < -1) overlaps++;
      }
    }
    return { rects, overlaps, minGap, viewport: v, snapshot: probe.snapshot() };
  });
  result.stages.push({ label, ...value }); return value;
}
async function show(selector, top=400) {
  await page.locator(selector).first().waitFor();
  await page.evaluate(({selector,top}) => { probe.manual(); const el=document.querySelector(selector),r=el.getBoundingClientRect(),v=probe.viewport(); probe.setViewport({...v,y:v.y+top-r.y}); },{selector,top});
  await settle();
}
async function zoomAt(id, zoom) {
  await page.evaluate(({id,zoom})=>{const r=document.querySelector(`[data-unit="${id}"]`).getBoundingClientRect(),v=probe.viewport(),top=document.querySelector('.board').getBoundingClientRect().top;
    probe.setViewport({x:95-(r.x-v.x)/v.zoom*zoom,y:35-(r.y-top-v.y)/v.zoom*zoom,zoom});},{id,zoom});await settle();
}
const delta = (a,b) => Object.keys(a.rects).filter(id=>Math.abs(a.rects[id].y-b.rects[id].y)>.5 || Math.abs(a.rects[id].x-b.rects[id].x)>.5);
try {
  for (let i=0;i<60;i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,50)); }
  await page.goto(`http://127.0.0.1:${port}/?count=500&mode=managed&dynamic=1`);
  await page.waitForFunction(()=>window.probe?.ready); await settle();
  const baseline = await geometry('baseline');
  check('500 actual DOM objects; initially no overlap', Object.keys(baseline.rects).length===500 && baseline.overlaps===0, {objects:500,overlaps:baseline.overlaps,minGap:baseline.minGap});
  const source='KU-001';
  const next=Object.keys(baseline.rects).filter(id=>id!==source && Math.abs(baseline.rects[id].x-baseline.rects[source].x)<1).sort((a,b)=>baseline.rects[a].y-baseline.rects[b].y)[0];
  const nextIndex=await page.evaluate(id=>probe.unitIds.indexOf(id),next);
  result.source=source;result.neighbor=next;
  const summary=`${unit(source)} details summary`;
  await show(summary);
  await page.locator(summary).first().click(); await settle();
  const expanded=await geometry('native material expanded');
  check('native disclosure changes actual article height',expanded.rects[source].h-baseline.rects[source].h>100,{before:baseline.rects[source].h,after:expanded.rects[source].h,moved:delta(baseline,expanded)});
  check('expanded rectangles do not overlap',expanded.overlaps===0,{overlaps:expanded.overlaps,minGap:expanded.minGap});
  const paragraph=`${unit(source)} .reading-paragraph p, ${unit(source)} .reading-block p`;
  const original=await page.locator(paragraph).first().textContent();
  result.originalParagraph=original;
  // Keep the first article intersecting the viewport while reading the next article.
  await page.evaluate(index=>{probe.manual();probe.jump(index);},nextIndex);await settle();
  const input=page.locator(`${unit(next)} textarea[data-draft]`);
  await show(`${unit(next)} textarea[data-draft]`,420);
  await input.fill('本地草稿：展开期间继续推导，不接受旧快照覆盖。');
  await input.evaluate(el=>{el.setSelectionRange(5,12);window.dynamicInput=el;});
  const inputBefore=await input.boundingBox();
  const stream=[];
  for (const repetitions of [20,40,60,80]) {
    await page.evaluate(({text,n})=>probe.emit(0,text.repeat(n)),{text:original,n:repetitions}); await settle();
    const g=await geometry(`paragraph growth ${repetitions}`);stream.push(g.rects[source].h);
    check(`growth ${repetitions}: actual rectangles do not overlap`,g.overlaps===0,{height:g.rects[source].h,overlaps:g.overlaps,minGap:g.minGap});
  }
  const grown=await geometry('stream complete');
  const moved=delta(expanded,grown);
  const unrelated=Object.keys(baseline.rects).filter(id=>Math.abs(baseline.rects[id].x-baseline.rects[source].x)>700);
  check('growth propagates through at least two actual neighbors',moved.filter(id=>id!==source).length>=2,{movedCount:moved.length,moved:moved.slice(0,12),heights:stream});
  check('unrelated columns remain at their measured positions',unrelated.every(id=>Math.abs(expanded.rects[id].y-grown.rects[id].y)<.5),{objects:unrelated.length});
  const inputAfter=await input.boundingBox();
  check('input DOM identity, selection, focus and screen anchor survive growth',await input.evaluate(el=>el===window.dynamicInput && document.activeElement===el && el.selectionStart===5 && el.selectionEnd===12) && Math.abs(inputAfter.y-inputBefore.y)<1,{before:inputBefore,after:inputAfter});
  const reading=`${unit(next)} .reading-paragraph p, ${unit(next)} .reading-block p`;
  await show(reading,420);
  await page.evaluate(selector=>{document.activeElement.blur();const text=document.querySelector(selector).firstChild;const r=document.createRange();r.setStart(text,2);r.setEnd(text,8);getSelection().removeAllRanges();getSelection().addRange(r);window.readingText=text;window.readingQuote=getSelection().toString();},reading);
  await page.waitForTimeout(80);
  const readingBefore=await page.evaluate(()=>getSelection().getRangeAt(0).getBoundingClientRect().toJSON());
  await page.evaluate(text=>probe.emit(0,text.repeat(90)),original);await settle();
  const readingAfter=await page.evaluate(()=>({rect:getSelection().getRangeAt(0).getBoundingClientRect().toJSON(),same:getSelection().anchorNode===readingText,quote:getSelection().toString()}));
  check('actual reading range stays at its screen anchor during upstream growth',readingAfter.same && readingAfter.quote===await page.evaluate(()=>readingQuote) && Math.abs(readingAfter.rect.y-readingBefore.y)<1,{before:readingBefore,after:readingAfter});
  // Real text selection remains on the same Text node while a patch to that paragraph waits.
  await page.evaluate(({selector})=>{const el=document.querySelector(selector),text=el.firstChild;const r=document.createRange();r.setStart(text,2);r.setEnd(text,8);getSelection().removeAllRanges();getSelection().addRange(r);window.dynamicSelection={text,quote:getSelection().toString()};},{selector:paragraph.split(',')[0]});
  await page.evaluate(()=>probe.emit(0,'这条模拟更新应等待选区结束。')); await settle();
  check('actual text node and selected quote survive same-paragraph patch',await page.evaluate(()=>getSelection().anchorNode===dynamicSelection.text && getSelection().toString()===dynamicSelection.quote),await page.evaluate(()=>({quote:getSelection().toString(),pending:document.querySelectorAll('[data-pending-patch]').length})));
  await page.evaluate(()=>getSelection().removeAllRanges());await settle();
  // Restore real paragraph, keep disclosure expanded; use actual drag to establish a new baseline.
  await page.evaluate(text=>probe.emit(0,text.repeat(50)),original);await settle();
  await geometry("before drag navigation");
  await show(`${unit(next)} .unit-handle`,230);
  await geometry("after drag navigation");
  const handle=page.locator(`${unit(next)} .unit-handle`),h=await handle.boundingBox();
  await page.mouse.move(h.x+170,h.y+24);await page.mouse.down();await page.mouse.move(h.x+205,h.y+94,{steps:8});
  const held=await handle.boundingBox();
  await page.evaluate(text=>probe.emit(0,text.repeat(70)),original);await settle();
  const heldAfter=await handle.boundingBox();
  check('in-progress pointer drag owns its DOM position during growth',Math.abs(heldAfter.y-held.y)<1 && Math.abs(heldAfter.x-held.x)<1,{held,heldAfter});
  await page.mouse.up();await settle();
  const manual=await geometry('drag committed during expansion');
  result.draggedBaseline=await page.evaluate(id=>probe.layout().baseline[id],next);
  // A delayed real source-page decode and a delayed MathLive layout must feed the same observer.
  await page.evaluate(()=>{document.activeElement.blur();getSelection().removeAllRanges();probe.manual();probe.jump(0);});await settle();
  await show(summary); // first material remains open
  const image=(await readdir('source-pages', {recursive:true})).find(x=>/\.(png|jpg|webp)$/i.test(x));
  await page.route('**/*dynamic-delay=1',async route=>{await new Promise(r=>setTimeout(r,260));await route.continue();});
  const beforeImage=await geometry('before delayed image');
  await page.evaluate(({source,image})=>{const target=document.querySelector(`[data-unit="${source}"] details .material-content`);const img=document.createElement('img');img.dataset.dynamicImage='true';img.src=`/source-pages/${image}?dynamic-delay=1`;target.append(img);},{source,image});
  await page.locator('[data-dynamic-image]').evaluate(img=>img.decode());await settle();
  const afterImage=await geometry('after delayed image');
  check('delayed real image decode grows actual layout without overlap',afterImage.rects[source].h>beforeImage.rects[source].h+100 && afterImage.overlaps===0,await page.locator('[data-dynamic-image]').evaluate(img=>({naturalWidth:img.naturalWidth,rendered:img.getBoundingClientRect().toJSON()})));
  await page.evaluate(source=>{const m=document.createElement('math-field');m.readOnly=true;m.dataset.dynamicFormula='true';m.value='a';document.querySelector(`[data-unit="${source}"] details .material-content`).append(m);},source);await settle();
  const beforeFormula=await page.locator('[data-dynamic-formula]').boundingBox();
  await page.locator('[data-dynamic-formula]').evaluate(el=>new Promise(resolve=>setTimeout(()=>{el.value='\\displaystyle\\frac{\\frac{a+b}{c+d}}{\\frac{x+y}{z+w}}';resolve();},160)));await settle();
  const afterFormula=await page.locator('[data-dynamic-formula]').boundingBox(),formulaLayout=await geometry('delayed formula');
  check('delayed MathLive typesetting changes real height without overlap',afterFormula.height>beforeFormula.height+10 && formulaLayout.overlaps===0,{before:beforeFormula,after:afterFormula});
  // Two native disclosures on distinct objects are open at the same time.
  await page.evaluate(index=>{probe.manual();probe.jump(index);},nextIndex);await settle();
  const neighborSummary=`${unit(next)} details summary`;
  await zoomAt(next,.3);
  await show(neighborSummary,700);
  const beforeMulti=await geometry('before second object expands');
  await page.locator(neighborSummary).first().click();await settle();
  const multi=await geometry('two objects expanded');
  check('two distinct actual bodies expand together without overlap',
    await page.locator(`${unit(source)} details[open]`).count()>0 && await page.locator(`${unit(next)} details[open]`).count()>0 && multi.rects[next].h>beforeMulti.rects[next].h+10 && multi.overlaps===0,
    {beforeHeight:beforeMulti.rects[next].h,afterHeight:multi.rects[next].h,overlaps:multi.overlaps});
  await page.locator(neighborSummary).first().click();await settle();
  // Cross-column movement is an actual pointer gesture while the upstream source is expanded.
  await zoomAt(next,.7);
  async function dragAcross(screenDelta) {
    await show(`${unit(next)} .unit-handle`,230);
    const box=await handle.boundingBox();
    await page.mouse.move(box.x+100,box.y+24);await page.mouse.down();
    await page.mouse.move(box.x+100+screenDelta,box.y+24,{steps:14});await page.mouse.up();await settle();
  }
  const beforeCross=await geometry('before cross-column drag');
  await dragAcross(567);
  const cross=await geometry('cross-column drag while expanded');
  check('real cross-column drag reaches destination and resolves actual collisions',cross.rects[next].x-beforeCross.rects[next].x>700 && Math.abs(cross.rects[next].x-810)<100 && cross.overlaps===0,
    {from:beforeCross.rects[next],to:cross.rects[next],overlaps:cross.overlaps});
  await dragAcross(-567);
  result.draggedBaseline=await page.evaluate(id=>probe.layout().baseline[id],next);
  // Follow animation + actual wheel takeover + later simulated updates in another region.
  await page.evaluate(()=>{document.activeElement.blur();probe.resume();probe.emit(1,'模拟 Agent 更新，供手动视口接管检查。');});await page.waitForTimeout(40);
  await page.mouse.move(20,500);await page.mouse.wheel(0,220);await settle();
  const taken=await page.evaluate(()=>probe.viewport());
  await page.evaluate(()=>{probe.emit(2,'手动接管后模拟输出一');probe.emit(3,'手动接管后模拟输出二');});await settle();
  const afterTakeover=await page.evaluate(()=>({v:probe.viewport(),owner:probe.snapshot().owner}));
  check('real wheel cancels follow and later simulated output cannot reclaim viewport',afterTakeover.owner==='manual' && Math.abs(taken.x-afterTakeover.v.x)<1 && Math.abs(taken.y-afterTakeover.v.y)<1,{taken,afterTakeover});
  // Re-enter the source after manual takeover; collapse below must retain ownership.
  await page.evaluate(()=>probe.jump(0));await settle();
  // Rapid multi-disclosure changes in the same and successive frames, including a second object.
  await page.evaluate(async source=>{const list=[...document.querySelectorAll(`[data-unit="${source}"] details`)];for(let i=0;i<12;i++){list.forEach(d=>d.open=i%2===0);await new Promise(requestAnimationFrame);}list.forEach(d=>d.open=false);},source);await settle();
  await page.evaluate(text=>probe.emit(0,text),original);await settle();
  const collapsed=await geometry('collapse to latest manual baseline');
  check('collapse uses latest actual drag baseline',Math.abs(collapsed.rects[next].x-result.draggedBaseline.x)<1 && Math.abs(collapsed.rects[next].y-result.draggedBaseline.y)<1,{rect:collapsed.rects[next],baseline:result.draggedBaseline,old:baseline.rects[next],dragged:manual.rects[next]});
  check('collapse after takeover does not restore Agent follow',await page.evaluate(()=>probe.snapshot().owner)==='manual');
  check('rapid disclosure ends with no stale size or overlap',collapsed.overlaps===0 && Math.abs(collapsed.rects[source].h-baseline.rects[source].h)<1,{overlaps:collapsed.overlaps,height:collapsed.rects[source].h,initial:baseline.rects[source].h});
  // Draft offscreen unmount, remount and fresh load are checked through the actual textarea.
  await page.evaluate(()=>{document.activeElement.blur();getSelection().removeAllRanges();probe.jump(499);});await settle();
  check('draft body actually unmounts offscreen',await input.count()===0);
  await page.evaluate(index=>probe.jump(index),nextIndex);await settle();
  check('local draft returns after actual remount',await input.inputValue()==='本地草稿：展开期间继续推导，不接受旧快照覆盖。');
  const stable1=await geometry('offscreen feedback settled');await page.waitForTimeout(800);const stable2=await geometry('idle stability');
  check('mount feedback settles without resize oscillation',stable1.snapshot.layoutCommits===stable2.snapshot.layoutCommits && stable2.overlaps===0,{commitsBefore:stable1.snapshot.layoutCommits,commitsAfter:stable2.snapshot.layoutCommits,overlaps:stable2.overlaps});
  await page.reload();await page.waitForFunction(()=>window.probe?.ready);await page.evaluate(index=>{probe.manual();probe.jump(index);},nextIndex);await settle();
  check('saved local draft survives a fresh page load',await input.inputValue()==='本地草稿：展开期间继续推导，不接受旧快照覆盖。');
  await page.screenshot({path:'dynamic-preview.png'});
  check('no page/console errors including ResizeObserver loop errors',errors.length===0,errors);
} catch(e) { result.failure=e.stack;result.errors=errors;process.exitCode=1;await page.screenshot({path:'dynamic-failure.png'}).catch(()=>{}); }
finally { await context.close();await browser.close();server.kill();result.serverLog=serverLog;await writeFile('dynamic-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({checks:result.checks.length,failed:result.checks.filter(x=>!x.pass),failure:result.failure})); }
