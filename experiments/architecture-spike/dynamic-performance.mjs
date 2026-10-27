import { chromium } from 'playwright-core';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

// One bounded new scenario. Never attaches to a user browser or runs old probes.
const result = {
  capturedAt: new Date().toISOString(),
  scope: 'Candidate renderer only; simulated paragraph patches, no Agent/CourseService',
  sample: '500 synthetic objects repeat 84 real course units',
  workload: {
    count: 500, mode: 'managed', dynamic: true, durationMs: 7000, updateIntervalMs: 50,
    camera: 'Continuous local sinusoids: x=95+110*sin(t/1100), y=35+75*sin(t/1600), zoom=.7+.025*sin(t/1400)',
    growth: 'Existing first paragraph repeats 1+floor(updateIndex/2) times; every patch also changes its sequence suffix',
    disclosure: 'Native HTMLSummaryElement.click() on existing material at 1200/2600/4100/5800ms; not physical pointer acceptance',
    instrumentation: 'Existing probe rAF/longtask recorder; additional 250ms DOM samples and raw longtask timestamps; no CPU trace',
  },
  environment: {
    node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model, logicalCpus: os.cpus().length,
    memoryGB: +(os.totalmem()/2**30).toFixed(1),
    viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, headless: true,
  },
  hashes: {}, pageerrors: [], consoleErrors: [], failedRequests: [], checks: [],
};
for (const file of ['src/main.jsx','src/dynamic-layout.js','dist/app.js','fixture.json','heights.json','dynamic-performance.mjs']) {
  result.hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
const reservation = net.createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
let server, browser;
let serverLog = '';
function check(name, pass, evidence) { result.checks.push({ name, pass: Boolean(pass), evidence }); }
try {
  server = spawn('python3', ['start.py','--port',String(port)], { stdio:['ignore','pipe','pipe'] });
  server.stdout.on('data', x => serverLog += x);
  server.stderr.on('data', x => serverLog += x);
  for (let i=0;i<60;i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
    await new Promise(r => setTimeout(r,50));
  }
  browser = await chromium.launch({
    executablePath: process.env.PROBE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--disable-background-timer-throttling','--disable-renderer-backgrounding'],
  });
  result.environment.browser = browser.version();
  const context = await browser.newContext({ viewport:result.environment.viewport, deviceScaleFactor:1 });
  const page = await context.newPage();
  page.on('pageerror', e => result.pageerrors.push(e.message));
  page.on('console', m => { if (m.type()==='error') result.consoleErrors.push(m.text()); });
  page.on('requestfailed', r => result.failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
  await page.goto(`http://127.0.0.1:${port}/?count=500&mode=managed&dynamic=1`);
  await page.waitForFunction(() => window.probe?.ready || window.probe?.failure);
  const failure = await page.evaluate(() => probe.failure);
  if (failure) throw new Error(failure);
  await page.waitForTimeout(450);
  result.measurement = await page.evaluate(async config => {
    const p = window.probe;
    const source = document.querySelector('[data-unit="KU-001"]');
    const body = source.querySelector('.source-content');
    const paragraph = body.querySelector('.reading-paragraph p, .reading-block p');
    const summary = body.querySelector('details summary');
    const details = summary.parentElement;
    const original = paragraph.textContent;
    if (details.open) throw new Error('Expected a fresh collapsed material');
    p.manual();
    p.setViewport({x:95,y:35,zoom:.7});
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const before = p.snapshot();
    const initialArticleHeight = source.getBoundingClientRect().height/p.viewport().zoom;
    const initialObjects = document.querySelectorAll('[data-unit]').length;
    const updates = [], events = [], timeline = [], longTasks = [], cameraSamples = [];
    let observer;
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e=>({startTime:e.startTime,duration:e.duration}))));
      observer.observe({type:'longtask',buffered:false});
    }
    let recording = true, start = 0, cameraFrames = 0, maxCameraStep = 0;
    let lastCamera = p.viewport(), mountingViolations = 0, paragraphIdentityViolations = 0;
    const updateGaps = [], cameraCosts = [];
    let lastUpdateTime, minHeight = initialArticleHeight, maxHeight = initialArticleHeight;
    function mounted() {
      if (!body.isConnected || source.querySelector('.source-content')!==body) mountingViolations++;
      if (!paragraph.isConnected || body.querySelector('.reading-paragraph p, .reading-block p')!==paragraph) paragraphIdentityViolations++;
    }
    function sample() {
      mounted();
      const snap = p.snapshot(), v = p.viewport(), r = source.getBoundingClientRect();
      const height = r.height/v.zoom;
      minHeight = Math.min(minHeight,height); maxHeight = Math.max(maxHeight,height);
      timeline.push({elapsedMs:performance.now()-start,articleHeight:height,
        intersectsViewport:r.right>0 && r.left<innerWidth && r.bottom>document.querySelector('.board').getBoundingClientRect().top && r.top<innerHeight,
        sourceRect:r.toJSON(), materialOpen:details.open, viewport:v,
        domElements:snap.domElements,heavyBodies:snap.heavyBodies,sizeReports:snap.sizeReports,layoutCommits:snap.layoutCommits,
        paragraphUpdates:snap.paragraphUpdates,bodyMounts:snap.bodyMounts,bodyUnmounts:snap.bodyUnmounts});
    }
    function camera() {
      if (!recording) return;
      const t = performance.now()-start, costStart = performance.now();
      const v = {x:95+110*Math.sin(t/1100),y:35+75*Math.sin(t/1600),zoom:.7+.025*Math.sin(t/1400)};
      p.setViewport(v);
      maxCameraStep = Math.max(maxCameraStep,Math.hypot(v.x-lastCamera.x,v.y-lastCamera.y));
      lastCamera=v;cameraFrames++;cameraCosts.push(performance.now()-costStart);mounted();
      requestAnimationFrame(camera);
    }
    const disclosureTimers = [];
    p.startRecording();start=performance.now();sample();
    requestAnimationFrame(camera);
    // A timer independent of the camera rAF: stalls are reflected in effective update Hz.
    const updateTimer = setInterval(() => {
      const at = performance.now(), index = updates.length;
      mounted();
      const text = `${original.repeat(1+Math.floor(index/2))}（模拟段落更新 ${index+1}）`;
      const emitStart = performance.now();p.emit(0,text);
      updates.push({elapsedMs:at-start,characters:text.length,emitMs:performance.now()-emitStart,
        appliedToActualParagraph:paragraph.textContent===text});
      if (lastUpdateTime!==undefined) updateGaps.push(at-lastUpdateTime);
      lastUpdateTime=at;
    },config.updateIntervalMs);
    for (const at of [1200,2600,4100,5800]) {
      disclosureTimers.push(setTimeout(() => {
        const beforeHeight=source.getBoundingClientRect().height/p.viewport().zoom;
        summary.click();
        const event={elapsedMs:performance.now()-start,open:details.open,beforeHeight};events.push(event);
        requestAnimationFrame(()=>requestAnimationFrame(()=>{
          event.afterHeight=source.getBoundingClientRect().height/p.viewport().zoom;
          event.measuredAtMs=performance.now()-start;
        }));
      },at));
    }
    const sampleTimer=setInterval(sample,250);
    await new Promise(r=>setTimeout(r,config.durationMs));
    const elapsedMs=performance.now()-start;
    recording=false;clearInterval(updateTimer);clearInterval(sampleTimer);
    disclosureTimers.forEach(clearTimeout);sample();
    const metrics=p.stopRecording();
    // Let pending observer delivery complete without extending the timed workload.
    await new Promise(r=>setTimeout(r,0));
    observer?.disconnect();
    const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.floor(values.length*q)] || 0;
    return {source:'KU-001',initialObjects,initialParagraphCharacters:original.length,
      elapsedMs,updates:updates.length,effectiveUpdateHz:updates.length/elapsedMs*1000,
      initialArticleHeight,minArticleHeight:minHeight,maxArticleHeight:maxHeight,
      mountingViolations,paragraphIdentityViolations,cameraFrames,maxCameraStepPx:maxCameraStep,
      before,metrics,deltas:{sizeReports:metrics.sizeReports-before.sizeReports,
        layoutCommits:metrics.layoutCommits-before.layoutCommits,paragraphUpdates:metrics.paragraphUpdates-before.paragraphUpdates,
        bodyMounts:metrics.bodyMounts-before.bodyMounts,bodyUnmounts:metrics.bodyUnmounts-before.bodyUnmounts},
      domRange:{min:Math.min(...timeline.map(x=>x.domElements)),max:Math.max(...timeline.map(x=>x.domElements))},
      heavyBodyRange:{min:Math.min(...timeline.map(x=>x.heavyBodies)),max:Math.max(...timeline.map(x=>x.heavyBodies))},
      updateGapMs:{p95:percentile(updateGaps,.95),max:Math.max(0,...updateGaps)},
      emitMs:{p95:percentile(updates.map(x=>x.emitMs),.95),max:Math.max(0,...updates.map(x=>x.emitMs))},
      cameraCallbackMs:{p95:percentile(cameraCosts,.95),max:Math.max(0,...cameraCosts)},
      rawLongTasks:longTasks.map(x=>({elapsedMs:x.startTime-start,duration:x.duration})),
      disclosureEvents:events,updateEvents:updates,timeline};
  },result.workload);
  const m=result.measurement;
  check('requested 500/managed/dynamic scenario',m.initialObjects===500 && m.metrics.mode==='managed' && m.metrics.dynamic);
  check('same actual body and paragraph remain mounted',m.mountingViolations===0 && m.paragraphIdentityViolations===0 && m.timeline.every(x=>x.intersectsViewport));
  check('patches reach actual DOM and increase measured height',m.updateEvents.length>0 && m.updateEvents.every(x=>x.appliedToActualParagraph) && m.maxArticleHeight>m.initialArticleHeight+1000);
  check('four real native disclosure activations',m.disclosureEvents.length===4 && m.disclosureEvents.every((e,i)=>e.open===(i%2===0) && Number.isFinite(e.afterHeight)));
  check('real size feedback and projection commits occurred',m.deltas.sizeReports>0 && m.deltas.layoutCommits>0);
  check('no page, console or request errors',!result.pageerrors.length && !result.consoleErrors.length && !result.failedRequests.length);
  await context.close();
} catch(error) {
  result.failure=error.stack;process.exitCode=1;
} finally {
  await browser?.close();
  if (server) { const closed=new Promise(r=>server.once('close',r));server.kill();await closed; }
  result.serverLog=serverLog;
  if (result.checks.some(x=>!x.pass)) process.exitCode=1;
  await writeFile('dynamic-performance.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({failure:result.failure,checks:result.checks,metrics:result.measurement?.metrics,deltas:result.measurement?.deltas,
    elapsedMs:result.measurement?.elapsedMs,updates:result.measurement?.updates,effectiveUpdateHz:result.measurement?.effectiveUpdateHz}));
}
