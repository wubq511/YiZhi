/* Run the actual browser client against a controlled HTTP peer. No model calls or packages. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const copy = value => structuredClone(value);

function peer() {
  const chats = new Map(['A', 'B', 'C'].map((id, i) => [id, {
    conversationId: id, title: `对话 ${id}`, draft: `${id} 原草稿`, messages: [], updatedAt: `2026-10-25T00:00:0${3 - i}Z`,
  }]));
  const requests = [], patches = [], pending = [], creations = [], committed = new Map();
  let mode = 'hold', serial = 0, holdCreation = false;
  const send = (res, value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  return {
    chats, requests, patches, pending, creations,
    setMode(value) { mode = value; },
    holdNewConversation() { holdCreation = true; },
    releaseNewConversation() { const next = creations.shift(); if (!next) throw Error('No held conversation'); send(next.response, next.chat); },
    release() { const res = pending.shift(); if (!res) throw Error('No held acknowledgement'); send(res.response, res.task); },
    async handle(req, res) {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/api/v1/agent/state') {
        send(res, { conversations: [...chats.values()], tasks: [], prompts: [], sourceUpdates: [], sequence: 1, generation: 1 }); return;
      }
      if (path === '/api/v1/agent/models') { send(res, { models: [], cliVersion: 'fixture' }); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (path === '/api/v1/agent/conversations') {
        if (body.conversationId) {
          patches.push(copy(body)); const chat = chats.get(body.conversationId);
          if (!chat) throw Error('Unknown conversation'); Object.assign(chat, body.patch); send(res, chat);
        } else {
          const chat = { conversationId: `NEW-${++serial}`, title: '新对话', draft: '', messages: [], updatedAt: '2026-10-25T01:00:00Z' };
          chats.set(chat.conversationId, chat);
          if (holdCreation) creations.push({ response: res, chat }); else send(res, chat);
        }
        return;
      }
      if (path === '/api/v1/agent/requests') {
        requests.push(copy(body));
        let task = committed.get(body.requestId);
        if (!task) {
          task = { taskId: `TASK-${committed.size + 1}`, conversationId: body.conversationId, requestKind: body.requestKind };
          committed.set(body.requestId, task); chats.get(body.conversationId).draft = '';
        }
        if (mode === 'lose-once') {
          mode = 'hold';res.writeHead(200, { 'Content-Type': 'application/json' });res.flushHeaders();res.write('{');
          setImmediate(() => res.destroy());return;
        }
        pending.push({ response: res, task }); return;
      }
      res.statusCode = 404; send(res, { error: { message: 'Unknown fixture route' } });
    },
    close() { for (const item of [...pending, ...creations]) item.response.destroy(); },
  };
}

async function browser(t) {
  const profile = mkdtempSync(join(tmpdir(), 'review-agent-client-'));
  const chrome = spawn(process.env.REVIEW_AGENT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
      '--window-size=1400,1000', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => {
    if (chrome.exitCode === null) { const closed = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill(); await closed; }
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''; chrome.once('error', reject);
    chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
    chrome.once('exit', () => reject(Error('Chrome exited before debugger was ready')));
  });
  const pages = await (await fetch(endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
  const page = pages.find(page => page.type === 'page'); assert.ok(page);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true })); t.after(() => ws.close());
  let serial = 0; const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data); if (!message.id) return;
    const job = pending.get(message.id); pending.delete(message.id);
    message.error ? job.reject(Error(message.error.message)) : job.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw Error(`Timed out: ${expression}; UI=${await evaluate('document.querySelector("#agent-feedback")?.textContent')}`);
  };
  return { call, evaluate, until };
}

test('conversation draft ownership across real client navigation, send acknowledgements and retries', { timeout: 60000 }, async t => {
  const clients = new Map(); let sequence = 0;
  const clientSource = readFileSync(join(__dirname, '../web/agent.js'));
  const server = createServer((req, res) => {
    const run = new URL(req.url, 'http://localhost').searchParams.get('run') || req.headers.referer?.match(/[?&]run=(\d+)/)?.[1];
    if (req.url === '/agent.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(clientSource); return; }
    if (req.url.startsWith('/?run=')) {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>.agent-messages{height:180px;overflow:auto}.agent-message{min-height:100px}</style></head><body><div class="header-actions"></div><main class="workspace"></main>
        <script>window.fixture={run:${JSON.stringify(run)},values:{},writes:[],camera:{selected:'KU-055',x:35,y:17}};
        const board={getState:()=>structuredClone(fixture.camera),data:{units:[{id:'KU-055',name:'MUX'}]},
          persistence:{value:(ns,key)=>fixture.values[ns+':'+key]??null,
            put:(ns,key,value)=>{fixture.values[ns+':'+key]=structuredClone(value);fixture.writes.push({ns,key,value:structuredClone(value)});},poll:async()=>{}},
          panelChanged:()=>{},focusUnit:()=>{throw Error('Conversation navigation must not move the board');}};
        </script><script src="/agent.js"></script><script>window.agent=ReviewAgent.mount(board);agent.ready.then(()=>window.ready=true);</script></body></html>`;
      res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return;
    }
    const client = clients.get(run);
    if (!client) { res.statusCode = 404; res.end(); return; }
    client.handle(req, res).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: { message: error.message } })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const client of clients.values()) client.close(); server.closeAllConnections(); server.close(); });
  const b = await browser(t);
  async function start() {
    const client = peer(), run = String(++sequence); clients.set(run, client);
    await b.call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?run=${run}` });
    await b.until(`window.fixture?.run===${JSON.stringify(run)} && window.ready===true`); await b.evaluate('agent.show()');
    return client;
  }
  const type = text => b.evaluate(`document.querySelector('#agent-draft').value=${JSON.stringify(text)};document.querySelector('#agent-draft').dispatchEvent(new Event('input',{bubbles:true}))`);
  const picker = id => b.evaluate(`document.querySelector('#agent-conversation').value=${JSON.stringify(id)};document.querySelector('#agent-conversation').dispatchEvent(new Event('change',{bubbles:true}))`);
  const opened = id => b.until(`document.querySelector('#agent-conversation').value===${JSON.stringify(id)}`);
  const draft = () => b.evaluate('document.querySelector("#agent-draft").value');
  const click = selector => b.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const searchOpen = id => b.evaluate(`window.dispatchEvent(new CustomEvent('review-open-conversation',{detail:{conversationId:${JSON.stringify(id)}}}))`);
  const sent = async (client, count = 1) => {
    const deadline = Date.now() + 5000;
    while (client.requests.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(client.requests.length, count, 'HTTP peer must receive the actual client request');
  };
  const created = async client => {
    const deadline = Date.now() + 5000;
    while (!client.creations.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(client.creations.length, 1);
  };

  await t.test('dropdown, new conversation and search navigation save and load the owning draft', async () => {
    const client = await start();
    await type('A 未发送'); await picker('B'); await opened('B'); assert.equal(await draft(), 'B 原草稿');
    await type('B 未发送'); await searchOpen('A'); await opened('A'); assert.equal(await draft(), 'A 未发送');
    await type('A 最新草稿'); await click('#agent-new');
    await b.until('document.querySelector("#agent-conversation").value.startsWith("NEW-")'); assert.equal(await draft(), '');
    await type('新对话草稿'); await searchOpen('B'); await opened('B'); assert.equal(await draft(), 'B 未发送');
    await picker('NEW-1'); await opened('NEW-1'); assert.equal(await draft(), '新对话草稿');
    await b.evaluate('agent.flush()');
    assert.equal(client.chats.get('A').draft, 'A 最新草稿'); assert.equal(client.chats.get('B').draft, 'B 未发送');
    assert.equal(client.chats.get('NEW-1').draft, '新对话草稿');
    assert.deepEqual(await b.evaluate('fixture.camera'), { selected: 'KU-055', x: 35, y: 17 });
  });

  await t.test('search opens the identified saved message without losing drafts or moving the board', async () => {
    const client = await start();
    client.chats.get('B').messages = Array.from({ length: 12 }, (_, i) => ({
      messageId: `B-MESSAGE-${i}`, role: 'user', text: `已保存的消息 ${i}`,
    }));
    await type('A 搜索前未发送');
    await b.evaluate('agent.poll()');
    await b.evaluate("window.dispatchEvent(new CustomEvent('review-open-conversation',{detail:{conversationId:'B',messageId:'B-MESSAGE-4'}}))");
    await b.until("document.querySelector('[data-message-id=\"B-MESSAGE-4\"]')?.classList.contains('search-target')");
    const position = await b.evaluate("(()=>{const root=document.querySelector('#agent-messages'),message=document.querySelector('[data-message-id=\"B-MESSAGE-4\"]');return{scroll:root.scrollTop,top:message.getBoundingClientRect().top-root.getBoundingClientRect().top,height:root.clientHeight}})()");
    assert.ok(position.scroll > 0);
    assert.ok(position.top >= 0 && position.top < position.height, 'identified message must be visible');
    assert.equal(await draft(), 'B 原草稿');
    await b.evaluate('agent.flush()');
    assert.equal(client.chats.get('A').draft, 'A 搜索前未发送');
    assert.deepEqual(await b.evaluate('fixture.camera'), { selected: 'KU-055', x: 35, y: 17 });
  });

  await t.test('A acknowledgement after switching to B neither navigates nor writes B text into A', async () => {
    const client = await start(); await type('发给 A 的问题'); await click('#agent-send'); await sent(client);
    await picker('B'); await opened('B'); await type('B 等待发送的新问题'); client.release();
    await b.until('document.querySelector("#agent-feedback").textContent.includes("已提交")');
    await b.evaluate('agent.flush()');
    assert.equal(await b.evaluate('document.querySelector("#agent-conversation").value'), 'B');
    assert.equal(await draft(), 'B 等待发送的新问题');
    assert.equal(client.chats.get('A').draft, ''); assert.equal(client.chats.get('B').draft, 'B 等待发送的新问题');
    await picker('A'); await opened('A'); assert.equal(await draft(), '');
  });

  await t.test('later typing in A survives its first request acknowledgement', async () => {
    const client = await start(); await type('A 第一问'); await click('#agent-send'); await sent(client);
    await type('A 第二问草稿'); client.release();
    await b.until('document.querySelector("#agent-feedback").textContent.includes("已提交")'); await b.evaluate('agent.flush()');
    assert.equal(await draft(), 'A 第二问草稿'); assert.equal(client.chats.get('A').draft, 'A 第二问草稿');
  });

  await t.test('retyping the same question is a newer draft and must not be consumed by an older acknowledgement', async () => {
    const client = await start(); await type('再问同一句'); await click('#agent-send'); await sent(client);
    await type(''); await type('再问同一句'); client.release();
    await b.until('document.querySelector("#agent-feedback").textContent.includes("已提交")'); await b.evaluate('agent.flush()');
    assert.equal(await draft(), '再问同一句'); assert.equal(client.chats.get('A').draft, '再问同一句');
  });

  await t.test('a late new-conversation response cannot override a more recent search navigation', async () => {
    const client = await start(); client.holdNewConversation();
    await type('A 创建前草稿'); await click('#agent-new'); await created(client);
    await type('A 创建期间的新草稿'); await searchOpen('B'); await opened('B'); await type('B 保留');
    client.releaseNewConversation();
    // Wait for completion of the actual onclick promise, then flush only the active owner.
    await b.until('[...document.querySelector("#agent-conversation").options].some(o=>o.value==="NEW-1")');
    await b.evaluate('agent.flush()');
    assert.equal(await b.evaluate('document.querySelector("#agent-conversation").value'), 'B');
    assert.equal(await draft(), 'B 保留'); assert.equal(client.chats.get('A').draft, 'A 创建期间的新草稿');
  });

  await t.test('lost acknowledgement retries the same request while preserving B and the newer A draft', async () => {
    const client = await start(); client.setMode('lose-once');
    await type('A 已经提交的原问题'); await click('#agent-send'); await sent(client);
    await b.until('!!document.querySelector("#agent-retry")');
    await type('A 后来输入的草稿'); await picker('B'); await opened('B'); await type('B 自己的草稿');
    await click('#agent-retry'); await sent(client, 2); client.release();
    await b.until('!document.querySelector("#agent-retry")'); await b.evaluate('agent.flush()');
    assert.deepEqual(client.requests[0], client.requests[1], 'retry identity and payload must remain exact');
    assert.equal(await b.evaluate('document.querySelector("#agent-conversation").value'), 'B'); assert.equal(await draft(), 'B 自己的草稿');
    assert.equal(client.chats.get('A').draft, 'A 后来输入的草稿'); assert.equal(client.chats.get('B').draft, 'B 自己的草稿');
    await searchOpen('A'); await opened('A'); assert.equal(await draft(), 'A 后来输入的草稿');
  });

  await t.test('lost acknowledgement with no later A input clears only A on successful retry', async () => {
    const client = await start(); client.setMode('lose-once');
    await type('A 待确认的问题'); await click('#agent-send'); await sent(client); await b.until('!!document.querySelector("#agent-retry")');
    await picker('B'); await opened('B'); await type('B 应保留'); await click('#agent-retry'); await sent(client, 2); client.release();
    await b.until('!document.querySelector("#agent-retry")'); await b.evaluate('agent.flush()');
    assert.equal(await draft(), 'B 应保留'); assert.equal(client.chats.get('A').draft, '');
    await searchOpen('A'); await opened('A'); assert.equal(await draft(), '');
  });
});
