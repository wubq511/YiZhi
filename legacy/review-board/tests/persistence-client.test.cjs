/* Exercise save/retry behavior across the browser/HTTP boundary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const source = readFileSync(join(__dirname, '../web/persistence.js'), 'utf8');

function storage(map = new Map()) {
  return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value),
    removeItem: key => map.delete(key), map };
}
function snapshot(revision = 0, value = null) {
  return { courseId: 'course-test', generation: 1, sequence: revision,
    documents: revision ? { notes: { note: { value, revision } } } : {} };
}
function response(value, ok = true) { return { ok, status: ok ? 200 : 400, json: async () => value }; }
function commit(command, revision) {
  return { operationId: command.operationId, commitId: `commit-${revision}`,
    courseId: 'course-test', generation: 1, sequence: revision, saved: true,
    changes: command.changes.map(c => ({ ...c, revision, deleted: false })) };
}
function client(t, { initial = snapshot(), fetch, local = storage(), session = storage(), navigation = 'navigate' } = {}) {
  const timers = new Set();
  const window = new EventTarget();
  const context = vm.createContext({ window, document: { hidden: false }, EventTarget, CustomEvent,
    structuredClone, crypto: { randomUUID }, localStorage: local, sessionStorage: session,
    performance: { getEntriesByType: () => [{ type: navigation }] },
    setInterval: () => 0, queueMicrotask,
    setTimeout: (fn, delay) => { const id = setTimeout(fn, delay); timers.add(id); return id; },
    clearTimeout: id => { clearTimeout(id); timers.delete(id); }, fetch });
  vm.runInContext(source, context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  return new window.CoursePersistence(initial);
}
const plain = value => JSON.parse(JSON.stringify(value));

test('a lost acknowledgement retries the same operation without claiming an early save', async t => {
  const requests = [];
  const p = client(t, { fetch: async (_url, options) => {
    const command = JSON.parse(options.body); requests.push(command);
    if (requests.length === 1) throw new Error('connection lost after the server committed');
    return response(commit(requests[0], 1));
  } });
  p.put('notes', 'note', { text: 'keep this draft' });
  assert.equal(await p.flush(), false);
  assert.equal(p.hasPending(), true);
  assert.equal(p.problem.code, 'connection_failed');
  assert.equal(await p.retry(), true);
  assert.equal(p.hasPending(), false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(p.read('notes', 'note').revision, 1);
});

test('typing while a save is in flight preserves later input and rebases only on its own commit', async t => {
  const requests = []; let finishFirst;
  const p = client(t, { fetch: async (_url, options) => {
    const command = JSON.parse(options.body); requests.push(command);
    if (requests.length === 1) return new Promise(resolve => { finishFirst = () => resolve(response(commit(command, 1))); });
    return response(commit(command, 2));
  } });
  p.put('notes', 'note', { text: 'first' });
  const first = p.flush();
  p.put('notes', 'note', { text: 'later keystrokes' });
  finishFirst(); await first;
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].expectedRevisions['notes:note'], 1);
  assert.equal(requests[1].changes[0].value.text, 'later keystrokes');
  assert.equal(p.read('notes', 'note').revision, 2);
  assert.equal(p.hasPending(), false);
});

test('a reloaded rejected viewport outbox preserves old unsaved changes and latest drafts under a fresh identity', async t => {
  const local = storage(), session = storage(), requests = [];
  const bad = { selected: 'KU-035', camera: { x: 12, y: -34, scale: -0.004 } };
  const current = { ...bad, camera: { x: 12, y: -34, scale: 0.75 } };
  const fetch = async (_url, options) => {
    const command = JSON.parse(options.body); requests.push(command);
    if (command.changes.some(c => c.namespace === 'reading' && c.value.camera.scale < 0))
      return response({ error: { code: 'invalid_content', message: '阅读视口无效',
        details: { namespace: 'reading', key: 'default', field: 'camera',
          operationId: command.operationId, rejectedBeforeCommit: true } } }, false);
    return response(commit(command, 1));
  };
  const first = client(t, { local, session, fetch });
  first.put('reading', 'default', bad);
  first.put('notes', 'note', { text: 'older unsaved note in the rejected batch' });
  first.put('editingDrafts', 'composer', { text: 'earlier composer draft' });
  assert.equal(await first.flush(), false);
  const rejected = plain(requests[0]);
  first.put('reading', 'default', current);
  first.put('editingDrafts', 'composer', { text: 'latest composer input before reload' });
  first.put('review', 'KU-035', { status: 'weak' });
  const unrelated = 'review-board-drafts:course-test:another-tab';
  local.setItem(unrelated, 'independent draft must stay');
  const reopened = client(t, { local, session, fetch, navigation: 'reload' });
  assert.equal(await reopened.retry(), true, 'normal retry must recover the old rejected viewport after reload');
  assert.deepEqual(requests[1], rejected, 'reload first obtains a real rejection for the unchanged original operation');
  const replacement = requests[2];
  assert.notEqual(replacement.operationId, rejected.operationId);
  assert.deepEqual(requests[0], rejected, 'the old identity and payload are never rewritten');
  assert.deepEqual(replacement.expectedRevisions, { 'reading:default': 0, 'editingDrafts:composer': 0, 'review:KU-035': 0, 'notes:note': 0 });
  assert.deepEqual(plain(reopened.value('reading', 'default')), current);
  assert.equal(reopened.value('notes', 'note').text, 'older unsaved note in the rejected batch');
  assert.equal(reopened.value('editingDrafts', 'composer').text, 'latest composer input before reload');
  assert.equal(reopened.value('review', 'KU-035').status, 'weak');
  assert.equal(reopened.hasPending(), false);
  assert.equal(local.getItem(reopened.cacheKey), null);
  assert.equal(local.getItem(unrelated), 'independent draft must stay');
});

test('unknown acknowledgements and unproved viewport errors keep the exact original outbox operation', async t => {
  for (const mode of ['lost-ack', 'unproved-rejection', 'another-operation-proof']) {
    const requests = [];
    const p = client(t, { fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (mode === 'lost-ack') throw Error('the original outcome is unknown');
      return response({ error: { code: 'invalid_content', message: '阅读视口无效',
        details: { namespace: 'reading', key: 'default', field: 'camera',
          ...(mode === 'another-operation-proof' ? { operationId: 'another-operation', rejectedBeforeCommit: true } : {}) } } }, false);
    } });
    p.put('reading', 'default', { camera: { x: 0, y: 0, scale: -0.004 } });
    p.put('editingDrafts', 'composer', { text: 'original draft' });
    assert.equal(await p.flush(), false);
    p.put('reading', 'default', { camera: { x: 0, y: 0, scale: 0.75 } });
    p.put('editingDrafts', 'composer', { text: 'latest input must survive' });
    assert.equal(await p.retry(), false);
    assert.deepEqual(requests[1], requests[0], mode);
    assert.equal(p.hasPending(), true);
    assert.equal(p.value('editingDrafts', 'composer').text, 'latest input must survive');
  }
});

test('reload cannot rebase a rejected viewport batch into a newer course generation without conflict review', async t => {
  const local = storage(), session = storage(), requests = [];
  const fetch = async (_url, options) => {
    const command = JSON.parse(options.body); requests.push(command);
    return response({ error: { code: 'invalid_content', message: '阅读视口无效',
      details: { namespace: 'reading', key: 'default', field: 'camera', operationId: command.operationId, rejectedBeforeCommit: true } } }, false);
  };
  const original = client(t, { local, session, fetch });
  original.put('reading', 'default', { camera: { x: 0, y: 0, scale: -0.004 } });
  original.put('editingDrafts', 'composer', { text: 'original generation draft' });
  assert.equal(await original.flush(), false);
  original.put('reading', 'default', { camera: { x: 0, y: 0, scale: 0.75 } });
  original.put('editingDrafts', 'composer', { text: 'latest retained draft' });
  const reopened = client(t, { initial: { ...snapshot(), generation: 2 }, local, session, fetch, navigation: 'reload' });
  assert.equal(await reopened.retry(), false);
  assert.equal(reopened.problem.code, 'revision_conflict');
  assert.equal(await reopened.retry(), false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(reopened.value('editingDrafts', 'composer').text, 'latest retained draft');
  assert.equal(reopened.hasPending(), true);
});

test('viewport replacement keeps original CAS bases and stops at a real revision conflict', async t => {
  const requests = [];
  const p = client(t, { fetch: async (_url, options) => {
    assert.ok(options, 'recovery must not fetch new bases and silently overwrite another writer');
    const command = JSON.parse(options.body); requests.push(command);
    if (requests.length === 1) return response({ error: { code: 'invalid_content', message: '阅读视口无效',
      details: { namespace: 'reading', key: 'default', field: 'camera', operationId: command.operationId, rejectedBeforeCommit: true } } }, false);
    return response({ error: { code: 'revision_conflict', message: 'another writer changed the note' } }, false);
  } });
  p.put('reading', 'default', { camera: { x: 0, y: 0, scale: -0.004 } });
  p.put('notes', 'note', { text: 'unsaved note' });
  assert.equal(await p.flush(), false);
  p.put('reading', 'default', { camera: { x: 0, y: 0, scale: 0.75 } });
  p.put('editingDrafts', 'composer', { text: 'newest draft' });
  assert.equal(await p.retry(), false);
  assert.notEqual(requests[1].operationId, requests[0].operationId);
  assert.equal(requests[1].expectedRevisions['notes:note'], 0);
  assert.equal(p.problem.code, 'revision_conflict');
  assert.equal(await p.retry(), false);
  assert.equal(requests.length, 2);
  assert.equal(p.value('notes', 'note').text, 'unsaved note');
  assert.equal(p.value('editingDrafts', 'composer').text, 'newest draft');
});

test('a real HTTP-rejected viewport survives reload, recovers all input and reaches a durable stop barrier', async t => {
  // Reuse the hermetic HTTP fixture: real CourseService/SQLite, no browser or course material.
  const host = spawn('python3', ['-B', '-c', `import sys
from test_http import CourseHTTPTests
case=CourseHTTPTests()
try:
 case.setUp()
 print(case.origin,flush=True)
 sys.stdin.readline()
finally:
 case.doCleanups()
`], { cwd: join(__dirname, '..'), env: { ...process.env, PYTHONPATH: __dirname }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; host.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
  t.after(async () => {
    if (host.exitCode !== null || host.signalCode !== null) return;
    const exited = once(host, 'exit'), timer = setTimeout(() => host.kill('SIGKILL'), 3000);
    host.stdin.end('\n'); await exited; clearTimeout(timer);
    assert.equal(host.exitCode, 0, errors);
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(errors || 'HTTP fixture startup timed out')), 3000);
    host.stdout.once('data', data => { clearTimeout(timer); resolve(String(data).trim()); });
    host.once('exit', () => { clearTimeout(timer); reject(Error(errors || 'HTTP fixture exited')); });
  });
  const get = async () => (await globalThis.fetch(origin + '/api/v1/state')).json();
  const initial = await get(), requests = [], local = storage(), session = storage(); let lostReplacementAck = false;
  const transport = async (path, options) => {
    if (options?.body) requests.push(JSON.parse(options.body));
    const result = await globalThis.fetch(origin + path, options);
    if (options?.body && result.ok && !lostReplacementAck) {
      lostReplacementAck = true;
      await result.arrayBuffer();
      throw Error('lost acknowledgement after the actual replacement committed');
    }
    return result;
  };
  const old = client(t, { initial, local, session, fetch: transport });
  old.put('reading', 'default', { selected: 'KU-035', camera: { x: 0, y: 0, scale: -0.004 } });
  old.put('notes', 'NOTE-outbox', { noteId: 'NOTE-outbox', objectId: 'KU-035', text: 'unrelated unsaved note', anchor: { objectId: 'KU-035' } });
  old.put('editingDrafts', 'composer', { text: 'earlier composer' });
  assert.equal(await old.flush(), false);
  assert.equal(old.problem.httpStatus, 400);
  assert.equal(old.problem.details.rejectedBeforeCommit, true);
  assert.deepEqual(await get(), initial, 'the actual rejected batch made no SQLite change');
  old.put('reading', 'default', { selected: 'KU-035', camera: { x: 12, y: -34, scale: 0.75 } });
  old.put('editingDrafts', 'composer', { text: 'latest composer before reload' });
  const fixed = client(t, { initial: await get(), local, session, fetch: transport, navigation: 'reload' });
  assert.equal(await fixed.retry(), false, 'a lost replacement acknowledgement is still not a confirmed save');
  assert.equal(fixed.problem.code, 'connection_failed');
  assert.equal(await fixed.retry(), true);
  assert.deepEqual(requests[1], requests[0]);
  assert.notEqual(requests[2].operationId, requests[0].operationId);
  assert.deepEqual(requests[3], requests[2], 'an unknown replacement outcome retries the exact new identity and payload');
  const saved = await get();
  assert.equal(saved.sequence, initial.sequence + 1);
  assert.equal(saved.documents.reading.default.value.camera.scale, 0.75);
  assert.equal(saved.documents.notes['NOTE-outbox'].value.text, 'unrelated unsaved note');
  assert.equal(saved.documents.editingDrafts.composer.value.text, 'latest composer before reload');
  assert.equal(fixed.hasPending(), false);
  // A confirmed operation is not submitted again by another normal retry.
  assert.equal(await fixed.retry(), true); assert.equal(requests.length, 4);
  const stop = await globalThis.fetch(origin + '/api/v1/migration/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId: 'OUTBOX-RECOVERED-STOP', confirmedSequence: saved.sequence }) });
  assert.equal(stop.ok, true);
  const barrier = await stop.json();
  assert.equal(barrier.saved, true); assert.equal(barrier.phase, 'quiesced');
  assert.equal(barrier.sequence, saved.sequence);
});

test('replaying a recovered old acknowledgement does not roll back a newer snapshot', async t => {
  const local = storage(), session = storage();
  session.setItem('review-board-client:course-test', 'previous-tab');
  const command = { operationId: 'old-save', actor: 'student', kind: 'personal.update', generation: 1,
    changes: [{ namespace: 'notes', key: 'note', value: { text: 'older saved text' } }],
    expectedRevisions: { 'notes:note': 0 } };
  local.setItem('review-board-drafts:course-test:previous-tab', JSON.stringify({
    courseId: 'course-test', inflight: command, pending: [] }));
  const p = client(t, { initial: snapshot(2, { text: 'newer text from another window' }),
    local, session, navigation: 'reload', fetch: async () => response(commit(command, 1)) });
  await p.flush();
  assert.deepEqual(plain(p.read('notes', 'note')), {
    value: { text: 'newer text from another window' }, revision: 2 });
  assert.equal(p.hasPending(), false);
});

test('windows keep separate drafts; a conflict preserves input until the reader chooses', async t => {
  const local = storage();
  const saved = snapshot(1, { text: 'saved in the other window' });
  const p = client(t, { local, fetch: async (url) => url.endsWith('/state') ? response(saved)
    : response({ error: { code: 'revision_conflict', message: 'another writer committed' } }, false) });
  p.put('notes', 'note', { text: 'my unsaved text' });
  const other = client(t, { local, fetch: async () => { throw new Error('not used'); } });
  assert.equal(other.hasPending(), false); // Finding a draft never silently adopts another tab's input.
  other.put('notes', 'note', { text: 'another independent draft' });
  assert.notEqual(p.cacheKey, other.cacheKey);
  const otherDraft = local.getItem(other.cacheKey);
  await p.flush();
  assert.equal(p.problem.code, 'revision_conflict');
  assert.equal(p.value('notes', 'note').text, 'my unsaved text');
  await p.resolveConflict(false);
  assert.equal(p.value('notes', 'note').text, 'saved in the other window');
  assert.equal(local.getItem(other.cacheKey), otherDraft);
});

test('unchanged data with a different JSON key order does not create an autosave loop', t => {
  const p = client(t, { initial: snapshot(1, { b: 2, a: 1 }),
    fetch: async () => { throw new Error('unchanged data must not be written'); } });
  p.put('notes', 'note', { a: 1, b: 2 });
  assert.equal(p.hasPending(), false);
});

test('a clean window adopts a restored generation before its next edit', async t => {
  let submitted;
  const event={generation:2,sequence:5,operationId:'restore',changes:[
    {namespace:'notes',key:'note',value:{text:'restored'},revision:4}]};
  const p=client(t,{fetch:async(url,options)=>{
    if(url.includes('/events'))return response({events:[event],sequence:5});
    submitted=JSON.parse(options.body);return response({...commit(submitted,5),generation:2});
  }});
  await p.poll();
  p.put('notes','note',{text:'new edit after restore'});await p.flush();
  assert.equal(submitted.generation,2);
  assert.equal(submitted.expectedRevisions['notes:note'],4);
  assert.equal(p.problem,null);
});

test('a restore cannot silently rebase an older unsaved draft into a new generation', async t => {
  const requests=[];
  const restored={...snapshot(4,{text:'restored'}),generation:2,sequence:5};
  const p=client(t,{fetch:async(url,options)=>{
    if(url.includes('/events'))return response({events:[{generation:2,sequence:5,operationId:'restore',
      changes:[{namespace:'notes',key:'note',value:{text:'restored'},revision:4}]}],sequence:5});
    if(url.endsWith('/state'))return response(restored);
    const command=JSON.parse(options.body);requests.push(command);return response({...commit(command,5),generation:2});
  }});
  p.put('notes','note',{text:'older draft'});await p.poll();
  assert.equal(p.generation,1);
  assert.equal(p.problem.code,'revision_conflict');
  assert.equal(p.value('notes','note').text,'older draft');
  assert.equal(await p.flush(),false);
  assert.equal(requests.length,0);
  await p.resolveConflict(true);
  assert.equal(requests.length,1);
  assert.equal(requests[0].generation,2);
  assert.equal(requests[0].expectedRevisions['notes:note'],4);
});
