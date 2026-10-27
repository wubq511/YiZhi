/* Run with node --test tests/board-client.test.cjs; Chrome and Python use an isolated course. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');

const { copyRuntime } = require('./runtime-fixture.cjs');

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function outputUntil(child, stream, pattern, label) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(Error(`${label} startup timed out: ${output}`)), 30000);
    const data = chunk => {
      output = (output + chunk).slice(-30000);
      const match = output.match(pattern);
      if (match) finish(null, match[1]);
    };
    const error = value => finish(value);
    const exit = code => finish(Error(`${label} exited (${code}) before readiness: ${output}`));
    function finish(error, value) {
      clearTimeout(timer); stream.off('data', data); child.off('error', errorListener); child.off('exit', exit);
      error ? reject(error) : resolve(value);
    }
    const errorListener = error;
    stream.on('data', data); child.once('error', errorListener); child.once('exit', exit);
  });
}

async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'review-board-client-'));
  const profile = join(directory, 'chrome');
  let server, chrome, ws;
  t.after(async () => {
    ws?.close();
    try { await stop(chrome); } finally {
      try { await stop(server); } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        assert.equal(existsSync(directory), false, 'temporary course and Chrome profile must be removed');
      }
    }
    assert.ok(!chrome || chrome.exitCode !== null || chrome.signalCode !== null, 'Chrome must exit');
    assert.ok(!server || server.exitCode !== null || server.signalCode !== null, 'course service must exit');
  });
  const { app, course } = copyRuntime(directory, true);
  server = spawn('python3', [join(app, 'start.py'), '--course', course, '--port', '0', '--no-browser'],
    { cwd: course, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErrors = '';
  server.stderr.on('data', chunk => { serverErrors = (serverErrors + chunk).slice(-20000); });
  const url = await outputUntil(server, server.stdout, /本地复习画板：(http:\/\/127\.0\.0\.1:\d+\/)/, 'course service');
  assert.notEqual(new URL(url).port, '8769', 'never use the running production service');
  const health = await (await fetch(`${url}api/v1/health`)).json();
  assert.equal(health.status, 'running');
  assert.ok(existsSync(join(course, '.review-board/状态.sqlite3')), 'service creates independent state');
  chrome = spawn(process.env.REVIEW_BOARD_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--window-size=1720,1200', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await outputUntil(chrome, chrome.stderr, /DevTools listening on (ws:\/\/\S+)/, 'Chrome');
  const pages = await (await fetch(endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
  const page = pages.find(value => value.type === 'page');
  assert.ok(page, 'Chrome must expose a page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true });
  });
  let serial = 0;
  const pending = new Map(), errors = [], responses = [], requests = new Map(), sourceRequests = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), { method, params } = message;
    if (message.id) {
      const job = pending.get(message.id); if (!job) return;
      pending.delete(message.id); clearTimeout(job.timer);
      message.error ? job.reject(Error(message.error.message)) : job.resolve(message.result);
    } else if (method === 'Runtime.exceptionThrown') {
      errors.push({ kind: method, details: params.exceptionDetails });
    } else if (method === 'Runtime.consoleAPICalled') {
      const text = params.args.map(value => value.value ?? value.description).join(' ');
      if (params.type === 'error') errors.push({ kind: method, text });
    } else if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level)) {
      if (params.entry.level === 'error' || /ResizeObserver|unhandled|uncaught/i.test(params.entry.text)) errors.push(params.entry);
    } else if (method === 'Network.requestWillBeSent') {
      requests.set(params.requestId, params.request.url);
      if (params.request.url.includes('/api/v1/sources/resolve?')) sourceRequests.push(params.request.url);
    } else if (method === 'Network.responseReceived' && params.response.status >= 400) {
      responses.push({ status: params.response.status, url: params.response.url });
    } else if (method === 'Network.loadingFailed' && !params.canceled) {
      errors.push({ kind: method, url: requests.get(params.requestId), error: params.errorText });
    }
  });
  ws.addEventListener('close', () => {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('CDP connection closed')); }
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timed out: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    let result;
    try { result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); }
    catch (error) { throw Error(`${error.message}; expression=${expression}`); }
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label = expression, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(30);
    }
    throw Error(`Timed out: ${label}; state=${JSON.stringify(await evaluate('window.ReviewBoard?.getState()'))}; server=${serverErrors}`);
  };
  const settle = async () => {
    await call('Page.bringToFront');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const click = async selector => {
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.closest('[hidden]'))throw Error('Not visible: '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();for(const fraction of [.5,.08,.92]){const x=r.x+r.width*fraction,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(hit&&(hit===el||el.contains(hit)))return{x,y}}throw Error('Element is covered: '+${JSON.stringify(selector)})})()`);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await settle();
  };
  const textButton = async text => {
    const selector = await evaluate(`(()=>{const el=[...document.querySelectorAll('.editing-toolbar button,.editing-panel button')].find(el=>el.textContent===${JSON.stringify(text)});if(!el)throw Error('Missing button');el.dataset.testButton='target';return '[data-test-button="target"]'})()`);
    await click(selector); await evaluate("document.querySelector('[data-test-button]')?.removeAttribute('data-test-button')");
  };
  const key = async (key, code, virtualKey) => {
    await call('Page.bringToFront');
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, ...(key === ' ' ? { text: ' ' } : key === 'Enter' ? { text: '\r' } : {}) });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
    await settle();
  };
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable'); await call('Network.enable');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const resize = async (width, height, mobile = false) => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await settle();
  };
  await resize(1720, 1200);
  await call('Page.navigate', { url });
  await until('!!window.ReviewBoard?.editing && !!window.ReviewBoard?.agent', 'board integrations mounted');
  await evaluate('document.fonts.ready'); await settle();
  return { call, evaluate, until, settle, click, textButton, key, resize, url, errors, responses, sourceRequests };
}

test('board layout, real input, mobile panels, editor ownership and asynchronous source restoration', { timeout: 180000 }, async t => {
  const b = await harness(t);
  const state = () => b.evaluate('ReviewBoard.getState()');
  const mode = value => b.until(`ReviewBoard.getState().mode===${JSON.stringify(value)}`);
  const focus = async id => { await b.evaluate(`ReviewBoard.focusUnit(${JSON.stringify(id)})`); await mode('detail'); await b.settle(); };
  const flush = async () => { await b.evaluate('ReviewBoard.flush()'); await b.until('!ReviewBoard.persistence.busy&&!ReviewBoard.persistence.hasPending()', 'pending saves committed'); };
  const visible = selector => b.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el&&!el.closest('[hidden]')&&el.getClientRects().length>0})()`);

  await t.test('wide fit shows 20 complete nonoverlapping theme cards, separated from unit bodies, with three-level navigation', async () => {
    await b.click('#fit'); await mode('overview');
    const geometry = await b.evaluate(`(()=>{const v=document.querySelector('#viewport').getBoundingClientRect();return{viewport:{left:v.left,top:v.top,right:v.right,bottom:v.bottom},cards:[...document.querySelectorAll('.theme-overview')].map(el=>{const r=el.getBoundingClientRect();return{id:el.parentElement.dataset.theme,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,overflowX:el.scrollWidth-el.clientWidth,overflowY:el.scrollHeight-el.clientHeight,children:[...el.children].filter(c=>!c.matches('svg')).map(c=>{const r=c.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom}})}}),bodies:[...document.querySelectorAll('.theme-units')].map(el=>({width:el.offsetWidth,height:el.offsetHeight,overflow:getComputedStyle(el).overflow}))}})()`);
    assert.equal(geometry.cards.length, 20);
    for (const [i, card] of geometry.cards.entries()) {
      assert.ok(card.width > 20 && card.height > 20, `${card.id} is visible`);
      assert.ok(card.left >= geometry.viewport.left - 1 && card.right <= geometry.viewport.right + 1 && card.top >= geometry.viewport.top - 1 && card.bottom <= geometry.viewport.bottom + 1, `${card.id} fits viewport: ${JSON.stringify(card)}`);
      assert.ok(card.overflowX <= 2 && card.overflowY <= 2, `${card.id} content must not overflow`);
      for (const child of card.children.filter(child => child.right > child.left && child.bottom > child.top)) assert.ok(child.left >= card.left - 1 && child.right <= card.right + 1 && child.top >= card.top - 1 && child.bottom <= card.bottom + 1, `${card.id} child stays inside card: ${JSON.stringify({ card, child })}`);
      for (const other of geometry.cards.slice(i + 1)) assert.ok(Math.min(card.right, other.right) - Math.max(card.left, other.left) <= 1 || Math.min(card.bottom, other.bottom) - Math.max(card.top, other.top) <= 1, `${card.id} overlaps ${other.id}`);
    }
    assert.ok(geometry.bodies.every(value => !value.width && !value.height && value.overflow === 'hidden'), 'overview must not reserve body layout');
    await b.click('.theme-overview'); await mode('detail');
    assert.equal(await visible('.theme-overview'), false);
    await b.click('#theme-fit'); await mode('units');
    await b.click('#back'); await mode('detail');
    await b.click('#back'); await mode('overview');
    assert.equal((await state()).layoutVersion, 3);
  });

  await t.test('Space activates a focused button; viewport arrows pan, plus/minus zoom and zero fits', async () => {
    await focus('KU-055');
    await b.evaluate("document.querySelector('#fit').focus()");
    await b.key(' ', 'Space', 32); await mode('overview');
    assert.equal(await b.evaluate("document.querySelector('#viewport').classList.contains('space-pan')"), false);
    await focus('KU-055'); await b.evaluate("document.querySelector('#viewport').focus()");
    const before = (await state()).camera;
    await b.key('ArrowRight', 'ArrowRight', 39); assert.equal((await state()).camera.x, before.x - 70);
    await b.key('ArrowDown', 'ArrowDown', 40); assert.equal((await state()).camera.y, before.y - 70);
    await b.key('ArrowLeft', 'ArrowLeft', 37); await b.key('ArrowUp', 'ArrowUp', 38);
    assert.equal((await state()).camera.x, before.x); assert.equal((await state()).camera.y, before.y);
    await b.key('+', 'Equal', 187); assert.ok((await state()).camera.scale > before.scale);
    await b.key('-', 'Minus', 189); assert.ok(Math.abs((await state()).camera.scale - before.scale) < 1e-8);
    await b.key('0', 'Digit0', 48); await mode('overview');
    await flush();
    const saved = await (await fetch(`${b.url}api/v1/state`)).json();
    assert.equal(saved.documents.reading.default.value.layoutVersion, 3, 'layout version is actually persisted');
  });

  await t.test('real wheel scrolls nested reading content first, then hands the boundary to the board', async () => {
    await focus('KU-055');
    await b.evaluate(`(()=>{const parent=document.querySelector('#KU-055 .unit-content'),fixture=document.createElement('div');fixture.id='board-wheel-fixture';fixture.style.cssText='height:180px;overflow:auto;background:white';const child=document.createElement('div');child.style.cssText='height:1200px;padding:12px';child.textContent='Temporary nested scrolling fixture';fixture.append(child);parent.prepend(fixture);document.querySelector('#input-mode').value='trackpad';ReviewBoard.relayout()})()`);
    try {
      await b.settle();
      await focus('KU-055');
      await b.until("(()=>{const el=document.querySelector('#board-wheel-fixture'),r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+35)?.closest('#board-wheel-fixture')===el})()", 'scroll fixture is hit-testable after body relayout');
      const point = await b.evaluate(`(()=>{const r=document.querySelector('#board-wheel-fixture').getBoundingClientRect();const x=r.left+r.width/2,y=r.top+35;return{x,y,hit:document.elementFromPoint(x,y)?.closest('#board-wheel-fixture')?.id}})()`);
      assert.equal(point.hit, 'board-wheel-fixture', 'wheel must hit a real unit child');
      const before = (await state()).camera;
      await b.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 110 });
      await b.until("document.querySelector('#board-wheel-fixture').scrollTop>0", 'native internal scroll');
      assert.deepEqual((await state()).camera, before, 'internal scrolling must leave camera unchanged');
      const boundary = await b.evaluate("(()=>{const el=document.querySelector('#board-wheel-fixture');el.scrollTop=el.scrollHeight;return el.scrollTop})()");
      assert.ok(boundary > 500);
      await b.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 110 });
      await b.until(`ReviewBoard.getState().camera.y<${before.y - 50}`, 'boundary wheel pans board');
      assert.equal((await state()).camera.scale, before.scale);
    } finally {
      await b.evaluate("document.querySelector('#board-wheel-fixture')?.remove();document.querySelector('#input-mode').value='mouse';ReviewBoard.relayout()");
    }
  });

  await t.test('editor and note library alternate without losing the active editor', async () => {
    await focus('KU-055');
    await b.textButton('编辑与标注'); await b.textButton('编辑当前文字 / 公式');
    await b.until("!document.querySelector('.editing-panel').hidden", 'asynchronous block editor');
    assert.equal(await visible('.editing-library'), false);
    await b.textButton('笔记 / 待重新关联');
    await b.until("!document.querySelector('.editing-library').hidden&&document.querySelector('.editing-panel').hidden");
    assert.equal(await visible('.editing-panel'), false);
    await b.textButton('笔记 / 待重新关联');
    await b.until("!document.querySelector('.editing-panel').hidden&&document.querySelector('.editing-library').hidden");
    assert.equal(await visible('.editing-panel'), true); assert.equal(await visible('.editing-library'), false);
    await b.textButton('关闭编辑'); await b.textButton('编辑与标注');
  });

  await t.test('393×852 overview has two columns and reading keeps 650px width with mobile panel exclusion', async () => {
    await b.resize(393, 852, true); await b.click('#nav-close'); await b.click('#fit'); await mode('overview');
    const columns = await b.evaluate("[...new Set([...document.querySelectorAll('.theme')].map(el=>el.offsetLeft))].sort((a,b)=>a-b)");
    assert.equal(columns.length, 2);
    assert.equal(await b.evaluate('innerWidth'), 393); assert.equal(await b.evaluate('innerHeight'), 852);
    await focus('KU-001');
    assert.equal(await b.evaluate("document.querySelector('#KU-001').offsetWidth"), 650);
    assert.ok((await state()).camera.scale >= .52 && (await state()).camera.scale <= .6);
    const panels = ['#navigation', '#agent-panel', '#relationship-panel', '#source-panel'];
    async function only(expected) {
      await b.settle();
      const actual = await b.evaluate(`${JSON.stringify(panels)}.filter(selector=>{const el=document.querySelector(selector);return !el.hidden&&el.getClientRects().length>0})`);
      assert.deepEqual(actual, expected ? [expected] : []);
    }
    await b.click('#nav-open'); await only('#navigation');
    assert.equal(await visible('#nav-scrim'), true);
    const scrim = await b.evaluate("(()=>{const r=document.querySelector('#viewport').getBoundingClientRect();return{x:r.right-10,y:r.top+r.height/2}})()");
    await b.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...scrim });
    await b.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...scrim });
    await only(null); assert.equal(await visible('#nav-scrim'), false);
    await b.click('#nav-open'); await b.click('#agent-toggle'); await only('#agent-panel');
    await b.click('#relations-toggle'); await only('#relationship-panel');
    await b.click('#nav-open'); await only('#navigation');
    await b.click('#nav-close');
    await b.evaluate("document.querySelector('#KU-001 [data-source]').click()"); await only('#source-panel');
    await b.click('#agent-toggle'); await only('#agent-panel');
    await b.click('#nav-open'); await only('#navigation');
    await b.click('#nav-close');
    await b.resize(1720, 1200);
    await b.click('#nav-open'); await b.click('#agent-toggle'); await b.click('#relations-toggle');
    assert.equal(await visible('#navigation'), true); assert.equal(await visible('#agent-panel'), true); assert.equal(await visible('#relationship-panel'), true);
    await b.click('#agent-toggle'); await b.click('#relations-close');
  });

  await t.test('tools stay separate in a narrowed canvas and assistant controls remain reachable', async () => {
    await b.resize(930, 745);
    if (await visible('#navigation')) await b.click('#nav-close');
    await focus('KU-055');
    const separated = () => b.evaluate(`(()=>{const a=document.querySelector('.canvas-tools').getBoundingClientRect(),b=document.querySelector('.review-editing').getBoundingClientRect();return a.bottom<=b.top-8||a.right<=b.left||a.left>=b.right})()`);
    assert.equal(await separated(), true, 'collapsed editor must not cover zoom or overview');
    await b.textButton('编辑与标注');
    assert.equal(await separated(), true, 'wrapped editor must not cover zoom or overview');
    await b.click('#agent-toggle');
    // Populate only the isolated page DOM: no model requests or course mutations.
    const saved = await b.evaluate(`(()=>{const tasks=document.querySelector('#agent-tasks'),target=document.querySelector('#agent-target');const saved={tasks:tasks.innerHTML,target:target.textContent};tasks.innerHTML='<div style="height:500px">任务记录</div>';target.textContent='目标：KU-055 · MUX 的功能与表达式';return saved})()`);
    try {
      await b.settle();
      assert.equal(await b.evaluate(`(()=>{const e=document.querySelector('#agent-send'),r=e.getBoundingClientRect();return r.bottom<=innerHeight&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e})()`), true, 'send remains in view with a long task list');
      for (const [width,height] of [[393,852],[930,520]]) {
        await b.resize(width,height);
        await b.evaluate("document.querySelector('#agent-target').textContent='长选区上下文'.repeat(100);document.querySelector('#agent-send').scrollIntoView({block:'nearest'})");
        await b.settle();
        const send = await b.evaluate(`(()=>{const e=document.querySelector('#agent-send'),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {top:r.top,bottom:r.bottom,height:innerHeight,hit:hit?.id,reachable:r.top>=0&&r.bottom<=innerHeight+1&&hit===e}})()`);
        assert.equal(send.reachable, true, `send is reachable at ${width}x${height}: ${JSON.stringify(send)}`);
        if(width===393)assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.review-editing')).visibility"),'hidden','mobile sidebar owns the screen above editing tools');
      }
    } finally {
      await b.evaluate(`document.querySelector('#agent-tasks').innerHTML=${JSON.stringify(saved.tasks)};document.querySelector('#agent-target').textContent=${JSON.stringify(saved.target)}`);
      await b.click('#agent-toggle');
      await b.resize(930,745);
      assert.equal(await b.evaluate("getComputedStyle(document.querySelector('.review-editing')).visibility"),'visible');
      await b.textButton('编辑与标注');
      await b.resize(1720,1200);
    }
  });

  await t.test('keyboard follows the selected unit, reveals lower controls, and enters the next unit', async () => {
    await b.resize(1440,1000);
    if(await visible('#navigation'))await b.click('#nav-close');
    await focus('KU-055');
    await b.evaluate("document.querySelector('#viewport').focus()");
    await b.key('Tab','Tab',9);
    assert.equal(await b.evaluate('document.activeElement.id'),'nav-open');
    await b.key('Tab','Tab',9);
    assert.equal(await b.evaluate("document.activeElement.closest('.unit')?.id"),'KU-055');
    let reachedNext=false;
    for(let i=0;i<25;i++){
      const active=await b.evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),v=document.querySelector('#viewport').getBoundingClientRect(),tools=document.querySelector('.canvas-tools').getBoundingClientRect();return{unit:e.closest('.unit')?.id,text:e.textContent.slice(0,60),top:r.top,bottom:r.bottom,inView:r.top>=v.top+59&&r.bottom<=tools.top-8,next:e.matches('.next-unit'),focusVisible:e.matches(':focus-visible')}})()`);
      assert.equal(active.unit,'KU-055',JSON.stringify(active));
      assert.equal(active.inView,true,JSON.stringify(active));
      assert.equal(active.focusVisible,true);
      if(active.next){reachedNext=true;break;}
      await b.key('Tab','Tab',9);
    }
    assert.equal(reachedNext,true,'reach next-unit control without traversing unrelated units');
    await b.key('Enter','Enter',13);
    assert.equal((await state()).selected,'KU-056');
    assert.equal(await b.evaluate("document.activeElement.matches('#KU-056 .unit-heading h3')"),true);
    await b.key('Tab','Tab',9);
    assert.equal(await b.evaluate("document.activeElement.closest('.unit')?.id"),'KU-056');
    await b.resize(393,852);
    await b.evaluate("document.querySelector('#agent-toggle').focus()");
    await b.key('Enter','Enter',13);
    assert.equal(await b.evaluate('document.activeElement.id'),'agent-draft');
    assert.equal(await b.evaluate("document.querySelector('#world').inert"),true,'covered canvas is not a keyboard detour');
    await b.click('[data-agent-close]');
    assert.equal(await b.evaluate("document.querySelector('#world').inert"),false);
    await b.resize(1720,1200);
  });

  await t.test('200 percent text reflows header and keeps core operations visible', async () => {
    await b.resize(393,852);
    await b.evaluate("document.documentElement.style.fontSize='200%'");
    try{
      await b.settle();
      const geometry=await b.evaluate(`(()=>{const h=document.querySelector('.app-header').getBoundingClientRect(),v=document.querySelector('#viewport').getBoundingClientRect();return{headerBottom:h.bottom,viewportTop:v.top,viewportBottom:v.bottom,windowHeight:innerHeight,buttons:[...document.querySelectorAll('.header-actions button')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return{name:e.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=h.bottom}})}})()`);
      assert.ok(geometry.buttons.every(b=>b.inside),JSON.stringify(geometry));
      assert.equal(geometry.viewportTop,geometry.headerBottom);
      assert.ok(Math.abs(geometry.viewportBottom-geometry.windowHeight)<=1);
      await b.click('#relations-toggle');
      assert.equal(await visible('#relationship-panel'),true);
      await b.click('#relations-close');
    }finally{
      await b.evaluate("document.documentElement.style.removeProperty('font-size')");
      await b.resize(1720,1200);
    }
  });

  await t.test('KU-001 restores both real source text and outer panel scroll after asynchronous reload', async () => {
    await b.resize(1400, 800);
    await focus('KU-001');
    await b.evaluate("document.querySelector('#KU-001 [data-source]').click()");
    await b.until("!document.querySelector('#source-panel').hidden&&!!document.querySelector('#source-text')", 'real source text renders', 30000);
    await b.until("[...document.querySelectorAll('#source-pages img')].every(img=>img.complete&&img.naturalWidth>0)", 'real source images load', 30000);
    await b.settle();
    const expected = await b.evaluate(`(()=>{const text=document.querySelector('#source-text'),panel=document.querySelector('#source-panel');text.scrollTop=100;panel.scrollTop=40;return{text:text.scrollTop,outer:panel.scrollTop,source:ReviewSourceTools.captureSource().current}})()`);
    assert.ok(expected.text >= 90, `real source text supports scroll: ${JSON.stringify(expected)}`);
    assert.ok(expected.outer >= 35, 'real outer source panel supports scroll');
    await flush();
    const saved = await (await fetch(`${b.url}api/v1/state`)).json();
    assert.equal(saved.documents.reading.default.value.sourceView.textScroll, expected.text);
    assert.equal(saved.documents.reading.default.value.sourceScroll, expected.outer);
    const previousRequests = b.sourceRequests.length;
    const documentToken = `before-reload-${Date.now()}`;
    await b.evaluate(`window.__boardTestDocument=${JSON.stringify(documentToken)}`);
    await b.call('Page.reload', { ignoreCache: true });
    await b.until(`window.__boardTestDocument!==${JSON.stringify(documentToken)}&&!!window.ReviewBoard?.editing&&document.querySelector('#source-text')?.textContent.length>0`, 'new document asynchronously renders real source', 30000);
    await b.until("[...document.querySelectorAll('#source-pages img')].every(img=>img.complete&&img.naturalWidth>0)", 'restored source image ready', 30000);
    await b.until(`Math.abs(document.querySelector('#source-text').scrollTop-${expected.text})<=2&&Math.abs(document.querySelector('#source-panel').scrollTop-${expected.outer})<=2`, 'both source scroll positions restored');
    await b.evaluate('document.fonts.ready'); await b.settle();
    const restored = await b.evaluate("({text:document.querySelector('#source-text').scrollTop,outer:document.querySelector('#source-panel').scrollTop,source:ReviewSourceTools.captureSource().current})");
    assert.deepEqual(restored.source, expected.source); assert.ok(Math.abs(restored.text - expected.text) <= 2); assert.ok(Math.abs(restored.outer - expected.outer) <= 2);
    assert.ok(b.sourceRequests.length > previousRequests, 'reload must resolve the actual source through HTTP');
    assert.equal((await state()).selected, 'KU-001');
  });

  await t.test('approved relations open their real versioned sources and navigate pages', async () => {
    await b.resize(1400, 800);
    if (await visible('#source-panel')) await b.click('#source-close');
    if (await b.evaluate("document.querySelector('#relationship-panel').hidden")) await b.click('#relations-toggle');
    await b.click('[data-edge-source="REL-001"]');
    await b.until("!document.querySelector('#source-panel').hidden&&document.querySelector('#source-text')?.textContent.length>0", 'approved relation source renders', 30000);
    assert.match(await b.evaluate("document.querySelector('#source-caption').textContent"), /PDF 第 25 页/);
    assert.equal(await b.evaluate("document.querySelectorAll('.source-ref-list button').length"), 7);
    await b.click('[data-source-page="26"]');
    await b.until("document.querySelector('#source-caption').textContent.includes('PDF 第 26 页')&&ReviewSourceTools.captureSource().current.pdfPage===26");
    await b.click('#source-close');
  });

  await t.test('compact overview uses readable width and search targets preserve visible context', async () => {
    await b.resize(930, 745); await b.click('#fit'); await mode('overview');
    const density = await b.evaluate(`(()=>{const viewport=document.querySelector('#viewport').getBoundingClientRect(),cards=[...document.querySelectorAll('.theme-overview')].map(el=>el.getBoundingClientRect()),title=document.querySelector('.theme-overview h2');return{available:viewport.width,used:Math.max(...cards.map(r=>r.right))-Math.min(...cards.map(r=>r.left)),font:parseFloat(getComputedStyle(title).fontSize)*ReviewBoard.getState().camera.scale}})()`);
    assert.ok(density.used / density.available > .72, `compact overview must use available width: ${JSON.stringify(density)}`);
    assert.ok(density.font > 9, `compact overview titles must remain readable: ${JSON.stringify(density)}`);
    await b.evaluate("ReviewBoard.focusLocation({unitId:'KU-055',blockId:'RB-KU-055-core'})"); await b.settle();
    const first = await b.evaluate(`(()=>{const viewport=document.querySelector('#viewport').getBoundingClientRect(),heading=document.querySelector('#KU-055 .unit-heading').getBoundingClientRect(),target=document.querySelector('[data-block-id="RB-KU-055-core"]').getBoundingClientRect();return{viewportTop:viewport.top,viewportBottom:viewport.bottom,headingTop:heading.top,targetTop:target.top}})()`);
    assert.ok(first.headingTop >= first.viewportTop + 60, `visible first target must preserve unit heading: ${JSON.stringify(first)}`);
    assert.ok(first.targetTop < first.viewportBottom - 80, `visible first target must stay in reading range: ${JSON.stringify(first)}`);
    const deepId = await b.evaluate("[...document.querySelectorAll('#KU-055 [data-block-id]')].at(-1).dataset.blockId");
    await b.evaluate(`ReviewBoard.focusLocation({unitId:'KU-055',blockId:${JSON.stringify(deepId)}})`); await b.settle();
    const deep = await b.evaluate(`(()=>{const target=document.querySelector('[data-block-id="${deepId}"]').getBoundingClientRect(),viewport=document.querySelector('#viewport').getBoundingClientRect();return{top:target.top,bottom:target.bottom,viewportBottom:viewport.bottom}})()`);
    assert.ok(deep.top >= 90 && deep.top < deep.viewportBottom - 80, `deep target must enter reading range: ${JSON.stringify(deep)}`);
  });

  await t.test('no runtime exceptions, ResizeObserver loops, severe console errors or failed resources', async () => {
    await flush(); await b.settle();
    assert.deepEqual(b.responses, [], 'HTTP resources must succeed');
    assert.deepEqual(b.errors, [], 'browser error events must remain empty');
  });
});
