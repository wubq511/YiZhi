import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';

const executablePath = process.env.PROBE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const result = { capturedAt: new Date().toISOString(), environment: { browser: browser.version(),
  platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0].model,
  logicalCpus: os.cpus().length, memoryGB: +(os.totalmem() / 2**30).toFixed(1),
  viewport: {width:1440,height:1000}, deviceScaleFactor:1, headless:true },
  caveats: ['Synthetic 500-unit load repeats 84 real units; not 500 unique course units.',
    'Single run per scenario; warm OS/browser assets; no statistical confidence interval.',
    'rAF timings from headless Chrome are not physical mouse/trackpad or display-frame acceptance.',
    'DOM counts exclude shadow DOM; JS heap is an approximate Chromium snapshot, not total memory.',
    'Agent updates are simulated; sample localStorage is not CourseService durability or real Agent integration.'], scenarios: [], checks: [] };
function assert(name, condition, evidence) {
  result.checks.push({ name, pass: Boolean(condition), evidence });
  if (!condition) throw new Error(`Failed: ${name}: ${JSON.stringify(evidence)}`);
}
const settle = page => page.waitForTimeout(380);
async function workload(page, overview = false) {
  return page.evaluate(async overview => {
    const probe = window.probe;
    probe.manual();
    probe.setViewport({x:95,y:35,zoom:overview ? .008 : .7});
    await new Promise(resolve => setTimeout(resolve,180));
    probe.startRecording();
    const start = performance.now(); let lastUpdate = -100;
    await new Promise(resolve => {
      function frame(now) {
        const elapsed = now - start, angle = elapsed / 1800;
        probe.setViewport({x:95-Math.sin(angle)*420,y:35-Math.sin(angle*.7)*320,
          zoom:overview ? .008 + (Math.sin(angle)+1)*.002 : .7 + Math.sin(angle*.8)*.04});
        if (elapsed-lastUpdate >= 50) {
          probe.emit(0, `模拟增量 ${Math.floor(elapsed/50)}：位置记数法把数码与位权相乘，再将各位结果相加；此更新只替换一个段落。`);
          lastUpdate = elapsed;
        }
        if (elapsed < (overview ? 3000 : 6000)) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    return probe.stopRecording();
  }, overview);
}

try {
  for (const [count,mode] of [[84,'all'],[84,'managed'],[500,'all'],[500,'managed']]) {
    const context = await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:8772/?count=${count}&mode=${mode}`,{waitUntil:'load',timeout:90000});
    try {
      await page.waitForFunction(()=>window.probe?.ready || window.probe?.failure,{},{timeout:30000});
    } catch (error) {
      result.startupFailure = await page.evaluate(()=>({phase:window.probe?.phase,failure:window.probe?.failure,assets:window.probe?.assetErrors,
        fonts:[...document.fonts].filter(f=>f.status==='loading').map(f=>f.family),snapshot:window.probe?.snapshot()}));
      result.startupFailure.errors=errors; throw error;
    }
    assert(`${count}/${mode}: source images decoded`,await page.evaluate(()=>window.probe.ready && !window.probe.assetErrors.length),await page.evaluate(()=>window.probe.assetErrors));
    const scenario = {count,mode,initial:await page.evaluate(()=>window.probe.initial)};
    scenario.readingAndStreaming = await workload(page);
    scenario.overviewAndStreaming = await workload(page,true);
    scenario.errors = errors;
    result.scenarios.push(scenario);
    console.log(JSON.stringify(scenario));
    assert(`${count}/${mode}: no page errors`, errors.length===0, errors);
    await context.close();
  }

  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8772/?count=500&mode=managed');
  await page.waitForFunction(()=>window.probe?.ready);

  // A real browser wheel event interrupts an in-flight follow animation.
  await page.evaluate(()=>window.probe.emit(1,'跟随测试一'));
  await page.waitForTimeout(55);
  await page.mouse.move(25,500);
  await page.mouse.wheel(0,250);
  await settle(page);
  const taken = await page.evaluate(()=>window.probe.snapshot());
  await page.evaluate(()=>{window.probe.emit(2,'后续输出不应抢回');window.probe.emit(3,'最新修改对象');});
  await settle(page);
  const after = await page.evaluate(()=>window.probe.snapshot());
  assert('wheel cancels animation and future following',taken.owner==='manual' && after.owner==='manual' &&
    Math.abs(taken.viewport.x-after.viewport.x)<.1 && Math.abs(taken.viewport.y-after.viewport.y)<.1,{taken:taken.viewport,after:after.viewport,owner:after.owner});
  await page.locator('[data-resume]').click(); await settle(page);
  const resumed = await page.evaluate(()=>window.probe.snapshot());
  assert('return resumes at the latest object',resumed.owner==='follow' && resumed.workIndex===3 &&
    Math.abs(resumed.viewport.x-(95-3*810*.7))<1,{viewport:resumed.viewport,workIndex:resumed.workIndex});

  await page.evaluate(()=>{window.probe.manual();window.probe.jump(0);}); await settle(page);
  const paragraph = page.locator('[data-unit="KU-001"] .source-content .reading-paragraph p').first();
  const box = await paragraph.boundingBox();
  const beforeSelect = await page.evaluate(()=>window.probe.viewport());
  await page.mouse.move(box.x+10,box.y+10); await page.mouse.down();
  await page.mouse.move(box.x+230,box.y+10,{steps:12}); await page.mouse.up();
  const selection = await page.evaluate(()=>getSelection().toString());
  const afterSelect = await page.evaluate(()=>window.probe.viewport());
  assert('pointer selects text without panning',selection.length>2 && JSON.stringify(beforeSelect)===JSON.stringify(afterSelect),{selection,viewport:afterSelect});
  await page.evaluate(()=>window.probe.emit(0,'同一段新内容，选文结束后再显示。'));
  assert('selected paragraph is retained during incoming update',await page.evaluate(()=>getSelection().toString())===selection,{selection});
  await page.evaluate(()=>getSelection().removeAllRanges()); await page.waitForTimeout(50);
  assert('deferred paragraph appears after selection ends',(await paragraph.innerText())==='同一段新内容，选文结束后再显示。',await paragraph.innerText());

  const input = page.locator('[data-unit="KU-001"] [data-draft]');
  await input.fill('中文草稿与光标保持');
  const editBefore = await page.evaluate(()=>{
    const input=document.querySelector('[data-unit="KU-001"] [data-draft]');input.setSelectionRange(2,4);
    window.inputBefore=input;
    input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'测试'}));
    window.probe.resume();
    return window.probe.viewport();
  });
  for(let i=0;i<20;i++) await page.evaluate(i=>window.probe.emit(i%3+1,`修改其他单元 ${i}`),i);
  const inputRetained = await page.evaluate(()=>{
    const el=document.querySelector('[data-unit="KU-001"] [data-draft]');
    return {same:el===window.inputBefore,value:el.value,start:el.selectionStart,end:el.selectionEnd,active:document.activeElement===el,viewport:window.probe.viewport()};
  });
  assert('focused Chinese draft and selection survive other updates',inputRetained.same && inputRetained.value==='中文草稿与光标保持' && inputRetained.start===2 && inputRetained.end===4 && inputRetained.active && JSON.stringify(inputRetained.viewport)===JSON.stringify(editBefore),inputRetained);
  await input.dispatchEvent('compositionend',{data:'测试'});
  await page.evaluate(()=>{window.probe.manual();window.probe.setViewport({x:-100000,y:-100000,zoom:.7});}); await settle(page);
  assert('focused editor remains mounted offscreen',await page.evaluate(()=>document.querySelector('[data-unit="KU-001"] [data-draft]')===window.inputBefore));
  await page.evaluate(()=>document.activeElement.blur()); await settle(page);
  assert('inactive offscreen body is unmounted',await input.count()===0);
  await page.evaluate(()=>window.probe.jump(0)); await settle(page);
  assert('draft returns after remount',(await input.inputValue())==='中文草稿与光标保持');

  const formula = page.locator('[data-unit="KU-001"] math-field');
  const formulaBefore = await formula.evaluate(el=>{
    el.value='\\frac{A+B}{C}';el.dispatchEvent(new InputEvent('input',{bubbles:true}));el.focus();el.position=3;window.formulaBefore=el;
    return {value:el.value,position:el.position};
  });
  await page.evaluate(()=>{window.probe.resume();for(let i=0;i<20;i++) window.probe.emit(1,`公式旁的增量 ${i}`);});
  const formulaAfter=await formula.evaluate(el=>({same:el===window.formulaBefore,value:el.value,position:el.position}));
  assert('MathLive value and cursor survive sibling updates',formulaAfter.same && formulaAfter.value===formulaBefore.value && formulaAfter.position===formulaBefore.position,{before:formulaBefore,after:formulaAfter});

  await page.evaluate(()=>{document.activeElement.blur();getSelection().removeAllRanges();window.probe.manual();window.probe.jump(34);}); await settle(page);
  const control=page.locator('[data-unit="KU-035"] [data-interactive-input]').first();
  const controlBox=await control.boundingBox();
  await page.evaluate(y=>{const v=window.probe.viewport();window.probe.setViewport({...v,y:v.y+350-y});},controlBox.y); await settle(page);
  const experimentBefore=await page.evaluate(()=>({state:ReviewContentProvider.captureState(),viewport:window.probe.viewport()}));
  await control.click();
  const experimentAfter=await page.evaluate(()=>({state:ReviewContentProvider.captureState(),viewport:window.probe.viewport()}));
  assert('real experiment input changes without moving camera',JSON.stringify(experimentBefore.state)!==JSON.stringify(experimentAfter.state) && JSON.stringify(experimentBefore.viewport)===JSON.stringify(experimentAfter.viewport),{before:experimentBefore,after:experimentAfter});
  await page.evaluate(()=>{document.activeElement.blur();window.probe.jump(499);}); await settle(page);
  assert('experiment body unmounts offscreen',await control.count()===0);
  await page.evaluate(()=>window.probe.jump(34)); await settle(page);
  const afterRemount=await page.evaluate(()=>ReviewContentProvider.captureState());
  assert('experiment state survives remount',Object.entries(experimentAfter.state).every(([id,value])=>JSON.stringify(afterRemount[id])===JSON.stringify(value)));
  await page.reload();await page.waitForFunction(()=>window.probe?.ready);
  assert('sample autosaved draft survives reload',(await input.inputValue())==='中文草稿与光标保持');
  assert('sample autosaved formula survives reload',(await formula.evaluate(el=>el.value))===formulaBefore.value);
  await page.evaluate(()=>{window.probe.manual();window.probe.jump(34);});await settle(page);
  const afterReload=await page.evaluate(()=>ReviewContentProvider.captureState());
  assert('sample autosaved experiment survives reload',Object.entries(experimentAfter.state).every(([id,value])=>JSON.stringify(afterReload[id])===JSON.stringify(value)));
  await page.evaluate(()=>{document.activeElement.blur();window.probe.manual();window.probe.jump(0);}); await settle(page);
  await page.evaluate(()=>window.probe.moveNode(0,{x:50000,y:50000})); await settle(page);
  assert('moved offscreen object uses current geometry for culling',await input.count()===0);
  await page.evaluate(()=>window.probe.jump(0)); await settle(page);
  assert('navigation finds the moved object and restores its draft',(await input.inputValue())==='中文草稿与光标保持');
  assert('interaction sequence: no page errors',errors.length===0,errors);
  await page.screenshot({path:'preview.png'});
  await context.close();
} catch(error) {
  result.failure=error.stack;
  process.exitCode=1;
} finally {
  await writeFile('results.json',JSON.stringify(result,null,2));
  await browser.close();
  console.log(JSON.stringify({checks:result.checks.length,failed:result.checks.filter(c=>!c.pass),failure:result.failure}));
}
