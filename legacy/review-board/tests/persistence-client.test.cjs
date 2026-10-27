/* Exercise save/retry behavior across the browser/HTTP boundary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
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
function response(value, ok = true) { return { ok, json: async () => value }; }
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
