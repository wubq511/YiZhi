/* Module boundary tests; the optional Chrome test exercises real DOM + local MathLive.
   This deliberately does not claim to verify the host's real disk persistence. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller, logic } = require('../web/editing.js');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const copy = value => structuredClone(value);
const ref = { sourceId: 'SRC-course', page: 2, versionId: 'VERSION-1' };
function entity(id = 'KU-055') {
  return { id, name: '选择器', summary: '原摘要', sourceRefs: [ref], extra: { keep: true },
    reading: { schemaVersion: 'review-reading-1', revision: 3, status: 'complete',
      coverage: [{ goal: '保留' }], blocks: [
        { id: 'P1', kind: 'paragraph', role: 'core', payload: { text: '选择器输出来自选中的输入。', extra: 8 }, sourceRefs: [ref] },
        { id: 'F1', kind: 'formula', role: 'core', payload: { latex: 'F=x', caption: '原说明' }, sourceRefs: [ref] },
        { id: 'C1', kind: 'callout', role: 'material', payload: { text: '注意使能', tone: 'amber' }, sourceRefs: [ref] },
        { id: 'E1', kind: 'example', role: 'material', payload: { title: '例题', problem: '求输出', answerNature: 'authored-example' }, sourceRefs: [ref],
          children: [{ id: 'CHILD', kind: 'paragraph', role: 'material', payload: { text: '完整解答' }, sourceRefs: [ref] }] },
        { id: 'I1', kind: 'interactive', role: 'core', payload: { component: 'mux', config: { selectBits: ['s'], dataSignals: ['0', '1'] },
          inputs: { s: 0 }, bindings: { formula: 'F1', output: 'Y' } }, sourceRefs: [ref] },
      ] } };
}
function hostFixture() {
  const entities = new Map(['KU-055', 'KU-056'].map(uid => [uid, { entity: entity(uid), hash: 'hash-3', revision: 7, generation: 1 }]));
  const docs = { notes: new Map(), annotations: new Map(), layout: new Map() };
  const calls = [], drafts = new Map(); let sequence = 0;
  const error = (code, message = code) => Object.assign(new Error(message), { code });
  const host = {
    selectedUnit: () => ({ id: 'KU-055' }),
    getEntity: async uid => { if (!entities.has(uid)) throw error('not_found'); return copy(entities.get(uid)); },
    personalEntries: ns => [...docs[ns]].map(([key, record]) => ({ key, ...copy(record) })),
    stageDraft: (key, value) => value === null ? drafts.delete(key) : drafts.set(key, copy(value)),
    onRefresh: () => () => {},
    async applyContent(command) {
      calls.push(copy(command));
      if (command.kind === 'relation.create') return { operationId: command.operationId, saved: true };
      const change = command.changes[0], base = entities.get(change.key);
      if (command.expectedRevisions[`knowledge:${change.key}`] !== base.revision || command.generation !== base.generation)
        throw error('revision_conflict');
      entities.set(change.key, { entity: copy(change.value), hash: `hash-${++sequence}`, revision: base.revision + 1, generation: 1 });
      return { operationId: command.operationId, saved: true };
    },
    async applyPersonal(changes, kind, metadata) {
      calls.push(copy({ changes, kind, ...metadata }));
      for (const change of changes) {
        if ((docs[change.namespace].get(change.key)?.revision || 0) !== metadata.expectedRevisions[`${change.namespace}:${change.key}`])
          throw error('revision_conflict');
      }
      for (const change of changes) docs[change.namespace].set(change.key, { value: change.delete ? null : copy(change.value),
        revision: (docs[change.namespace].get(change.key)?.revision || 0) + 1 });
      return { operationId: metadata.operationId, saved: true };
    },
    async undo(operationId) { calls.push({ undo: operationId }); return { operationId: `inverse-${operationId}`, saved: true }; },
  };
  return { host, entities, docs, calls, drafts };
}

test('text and nested block edits preserve identity, references, coverage and unrelated raw fields', async () => {
  const f = hostFixture(), c = new Controller(f.host), original = copy(f.entities.get('KU-055'));
  const session = await c.openBlock('KU-055', 'CHILD');
  await c.saveBlock(session, { text: '新解答' });
  const command = f.calls[0], changed = command.changes[0].value;
  assert.deepEqual(f.entities.get('KU-056').entity, entity('KU-056'));
  assert.equal(command.generation, 1); assert.equal(command.expectedRevisions['knowledge:KU-055'], 7);
  assert.equal(command.expectedEntityHashes['KU-055'], 'hash-3');
  assert.deepEqual(changed.reading.coverage, original.entity.reading.coverage);
  assert.deepEqual(changed.extra, original.entity.extra);
  const block = logic.findBlock(changed, 'CHILD');
  assert.equal(block.payload.text, '新解答'); assert.equal(block.role, 'material'); assert.deepEqual(block.sourceRefs, [ref]);
  assert.deepEqual(session.record, original);
  assert.equal(c.pending.size, 0); assert.equal(f.drafts.size, 0);
});

test('formula edits retain the edit and mark bound exploration as uncertain in the same knowledge command', async () => {
  const f = hostFixture(), c = new Controller(f.host), session = await c.openBlock('KU-055', 'F1');
  await c.saveBlock(session, { latex: 'F=\\overline{x}', caption: '修改' });
  const command = f.calls[0];
  assert.equal(command.changes.length, 1);
  assert.equal(logic.findBlock(command.changes[0].value, 'F1').payload.latex, 'F=\\overline{x}');
  assert.equal(logic.findBlock(command.changes[0].value, 'I1').payload.semanticStatus.status, 'needs-review');
  assert.deepEqual(command.semanticImpact.blockIds, ['I1']);
  assert.deepEqual(logic.findBlock(command.changes[0].value, 'I1').payload.config,
    logic.findBlock(session.record.entity, 'I1').payload.config);
});

test('all supported payload editors preserve metadata and reject editing arbitrary fields or shared question stems', () => {
  const base = { id: 'B', role: 'core', sourceRefs: [ref], extra: true };
  for (const [kind, payload, patch] of [
    ['paragraph', { text: 'a' }, { text: 'b' }], ['callout', { text: 'a', tone: 'blue' }, { text: 'b' }],
    ['formula', { latex: 'a' }, { latex: 'b' }], ['figure', { alt: '图', config: { nodes: [] } }, { caption: '说明' }],
    ['steps', { items: ['a'] }, { items: ['b', 'c'] }],
    ['table', { columns: ['A'], rows: [[{ latex: 'x', preserve: 7 }]] }, { rows: [[{ latex: 'y', preserve: 7 }]] }],
    ['knowledge-reference', { targetUnitId: 'KU-055', intent: '回看' }, { targetUnitId: 'KU-056' }],
    ['exercise', { title: '练习', problem: '题干', hint: 'a', answerNature: 'self-test' }, { hint: 'b' }],
  ]) {
    const before = { ...copy(base), kind, payload }, result = logic.editBlock(before, patch);
    assert.equal(result.id, 'B'); assert.deepEqual(result.sourceRefs, [ref]); assert.equal(result.extra, true);
    assert.deepEqual(before.payload, payload);
  }
  assert.throws(() => logic.editBlock({ ...base, kind: 'exercise', payload: { title: '正式题', questionId: 'Q-1' } }, { problem: '副本' }), /不能修改/);
  assert.throws(() => logic.editBlock(entity().reading.blocks[0], { id: 'NEW' }), /不能修改/);
  assert.throws(() => logic.editBlock({ ...base, kind: 'table', payload: { columns: ['A'], rows: [[0]] } }, { rows: [[1, 2]] }), /行列/);
});

test('a stale content base is rejected without changing saved content or clearing its draft', async () => {
  const f = hostFixture(), c = new Controller(f.host), session = await c.openBlock('KU-055', 'P1');
  f.entities.get('KU-055').revision++;
  logic.findBlock(f.entities.get('KU-055').entity, 'P1').payload.text = '后来学生改动';
  await assert.rejects(c.saveBlock(session, { text: '陈旧改动' }), { code: 'revision_conflict' });
  assert.equal(logic.findBlock(f.entities.get('KU-055').entity, 'P1').payload.text, '后来学生改动');
  assert.equal(c.pending.size, 1); assert.ok(f.drafts.has(session.key));
  assert.equal(session.saved, undefined);
});

test('lost acknowledgement retries exactly the original operation, reporting what actually committed', async () => {
  const f = hostFixture(), c = new Controller(f.host), requests = [], session = await c.openBlock('KU-055', 'P1');
  f.host.applyContent = async command => {
    requests.push(copy(command));
    if (requests.length === 1) throw new Error('lost acknowledgement');
    return { saved: true, operationId: command.operationId };
  };
  await assert.rejects(c.saveBlock(session, { text: '第一次' }), /lost/);
  const result = await c.saveBlock(session, { text: '后来输入' });
  assert.deepEqual(requests[0], requests[1]); assert.equal(result.committedValue.text, '第一次');
  assert.equal(c.pending.size, 0);
});

test('neither optimistic success nor an unrelated operation receipt can clear an unacknowledged draft', async () => {
  for (const result of [{ saved: false }, { saved: true, operationId: 'unrelated' }]) {
    const f = hostFixture(), c = new Controller(f.host), session = await c.openBlock('KU-055', 'P1');
    f.host.applyContent = async () => result;
    await assert.rejects(c.saveBlock(session, { text: '保留' }), { code: 'save_unconfirmed' });
    assert.equal(c.pending.size, 1); assert.ok(f.drafts.has(session.key));
  }
});

test('independent fragment notes keep exact text, original revision and source refs, including after later content changes', async () => {
  const f = hostFixture(), c = new Controller(f.host), record = await f.host.getEntity('KU-055');
  const a = await c.createNote(record, 'P1', '疑问', { exact: '选中的输入', prefix: '来自', suffix: '。', start: 7, end: 12 });
  const b = await c.createNote(record, null, '整体笔记');
  assert.notEqual(a.noteId, b.noteId); assert.match(a.noteId, /^NOTE-/);
  assert.equal(a.anchor.revision, 3); assert.equal(a.anchor.originalText, '选中的输入'); assert.deepEqual(a.anchor.sourceRefs, [ref]);
  const base = c.entry('notes', a.noteId);
  f.docs.notes.get(a.noteId).revision++;
  await assert.rejects(c.saveNote(base, '旧编辑不能覆盖'), { code: 'revision_conflict' });
  assert.equal(f.docs.notes.get(a.noteId).value.text, '疑问');
});

test('orphan detection rejects ambiguous spans and retired/missing targets without dropping personal objects', () => {
  const record = { entity: entity(), revision: 7 }, anchor = logic.makeAnchor(record, 'P1');
  assert.equal(logic.anchorState(anchor, record).status, 'attached');
  record.entity.reading.revision++;
  assert.equal(logic.anchorState(anchor, record).status, 'changed');
  assert.equal(logic.anchorState(anchor, null).status, 'orphan');
  record.entity.status = 'retired'; assert.equal(logic.anchorState(anchor, record).status, 'orphan');
  delete record.entity.status;
  const fragment = logic.makeAnchor(record, 'P1', { exact: '输入' });
  logic.findBlock(record.entity, 'P1').payload.text = '输入与输入';
  assert.equal(logic.anchorState(fragment, record).status, 'orphan');
  fragment.selector.prefix = '与'; assert.equal(logic.anchorState(fragment, record).status, 'attached');
  record.entity.reading.blocks = [];
  assert.equal(logic.anchorState(fragment, record).status, 'orphan');
});

test('drawing plus local layout is one atomic personal command; arrows never become formal relations', async () => {
  const f = hostFixture(), c = new Controller(f.host), record = await f.host.getEntity('KU-055');
  for (const tool of ['line', 'wave', 'highlight', 'rectangle', 'ellipse', 'arrow']) {
    const drawing = await c.createDrawing(record, 'F1', tool, { x: 8, y: 9, width: 80, height: 30 });
    assert.match(drawing.drawingId, /^DRAW-/);
    const command = f.calls.at(-1);
    assert.equal(command.kind, 'annotation.create'); assert.deepEqual(command.changes.map(x => x.namespace), ['annotations', 'layout']);
    assert.equal(command.changes[1].key, drawing.drawingId);
    assert.equal(command.expectedRevisions[`annotations:${drawing.drawingId}`], 0);
  }
  assert.equal(f.calls.some(c => c.kind === 'relation.create'), false);
  const key = [...f.docs.layout.keys()][0], base = c.entry('layout', key);
  await c.transformDrawing(base, { x: 20, y: 40, width: 120, height: 60 });
  assert.equal(f.calls.at(-1).changes.length, 1); assert.equal(f.calls.at(-1).kind, 'annotation.transform');
  await assert.rejects(c.transformDrawing(base, { x: 2, y: 3, width: 4, height: 5 }), { code: 'revision_conflict' });
});

test('coordinates remain local under zoom; opposite-direction arrows preserve their orientation', () => {
  const panel = { offsetWidth: 1000, offsetHeight: 2000,
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 500, height: 1000 }) };
  assert.deepEqual(logic.localPoint(panel, 150, 250), { x: 100, y: 100 });
  assert.deepEqual(logic.boxBetween({ x: 90, y: 70 }, { x: 10, y: 20 }),
    { x: 10, y: 20, width: 80, height: 50, flipX: true, flipY: true });
  assert.throws(() => logic.validBox({ x: NaN, y: 0, width: 30, height: 20 }), /无效/);
});

test('reassociation changes only current target, retains all original contexts, and moves drawing layout atomically', async () => {
  const f = hostFixture(), c = new Controller(f.host), record = await f.host.getEntity('KU-055');
  const drawing = await c.createDrawing(record, 'P1', 'wave', { x: 1, y: 2, width: 60, height: 12 });
  const original = copy(drawing.anchor), next = await f.host.getEntity('KU-056');
  await c.reanchor('annotations', c.entry('annotations', drawing.drawingId), next, 'F1');
  const saved = f.docs.annotations.get(drawing.drawingId).value;
  assert.deepEqual(saved.anchor.originalAnchor, original); assert.equal(saved.anchor.objectId, 'KU-056');
  assert.equal(f.docs.layout.get(drawing.drawingId).value.objectId, 'KU-056');
  assert.equal(f.calls.at(-1).changes.length, 2); assert.equal(saved.anchor.relocations.length, 1);
  await c.reanchor('annotations', c.entry('annotations', drawing.drawingId), record, null);
  assert.deepEqual(f.docs.annotations.get(drawing.drawingId).value.anchor.originalAnchor, original);
  assert.equal(f.docs.annotations.get(drawing.drawingId).value.anchor.relocations.length, 2);
});

test('formal relation requires explicit supported type, direction, value, real refs, valid endpoints and immutable base revisions', async () => {
  const f = hostFixture(), c = new Controller(f.host), relation = { fromUnitId: 'KU-055', toUnitId: 'KU-056', type: 'requires',
    directed: true, value: '据前置定位缺漏', sourceRefs: [ref], view: 'auxiliary', requirementGroupId: 'G1', route: '保留 OR 路线' };
  for (const patch of [{ type: 'related' }, { directed: undefined }, { value: '' }, { sourceRefs: [] },
    { toUnitId: 'KU-055' }, { sourceRefs: [{ sourceId: 'fake' }] }, { type: 'inverse' }])
    await assert.rejects(c.createRelation({ ...relation, ...patch }));
  await c.createRelation(relation);
  const command = f.calls.at(-1);
  assert.equal(command.kind, 'relation.create'); assert.equal(command.relation.requirementGroupId, 'G1');
  assert.equal(command.expectedEntities['KU-055'].revision, 7);
  assert.equal(command.expectedRevisions['knowledge:KU-056'], 7);
  f.host.applyContent = async () => { throw Object.assign(new Error('前置循环'), { code: 'invalid_content' }); };
  await assert.rejects(c.createRelation(relation), /前置循环/);
  assert.equal(c.pending.size, 1);
});

test('undo and redo use only host operation IDs and do not restore personal snapshots', async () => {
  const f = hostFixture(), c = new Controller(f.host), record = await f.host.getEntity('KU-055');
  await c.createNote(record, null, '后来笔记');
  const operationId = c.undoId;
  await c.undo(); await c.redo();
  assert.deepEqual(f.calls.slice(-2), [{ undo: operationId }, { undo: `inverse-${operationId}` }]);
  assert.equal(f.docs.notes.size, 1);
  f.host.history = () => ({ undoOperationId: null, redoOperationId: null });
  await assert.rejects(c.undo(), { code: 'not_found' });
});

test('whole-unit movement and size use a separate VE layout record and reject stale transforms', async () => {
  const f = hostFixture(), c = new Controller(f.host), base = c.entry('layout', 'VE-KU-055');
  await c.transformObject(base, 'KU-055', { x: 120, y: 340, width: 980, height: 1600 });
  assert.equal(f.calls[0].kind, 'object.transform');
  assert.deepEqual(f.calls[0].changes[0], { namespace: 'layout', key: 'VE-KU-055',
    value: { objectId: 'KU-055', x: 120, y: 340, width: 980, height: 1600 } });
  assert.deepEqual(f.entities.get('KU-055').entity, entity());
  await assert.rejects(c.transformObject(base, 'KU-055', { x: 1, y: 2, width: 500, height: 600 }), { code: 'revision_conflict' });
});

test('object layout save retries the original unacknowledged operation instead of blocking itself', async () => {
  const f = hostFixture(), c = new Controller(f.host), base = c.entry('layout', 'VE-KU-055'), calls = [];
  f.host.applyPersonal = async (changes, kind, metadata) => {
    calls.push({ changes: copy(changes), kind, metadata: copy(metadata) });
    if (calls.length === 1) throw Error('lost acknowledgement');
    return { saved: true, operationId: metadata.operationId };
  };
  const box = { x: 120, y: 340, width: 980, height: 1600 };
  await assert.rejects(c.transformObject(base, 'KU-055', box), /lost acknowledgement/);
  assert.equal(c.pending.size, 1);
  await c.transformObject(base, 'KU-055', box);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(c.pending.size, 0);
});

test('recovering an unacknowledged persisted request retains operation ID, generation and the original CAS payload', async () => {
  const f = hostFixture(), first = new Controller(f.host), session = await first.openBlock('KU-055', 'P1');
  const originalApply = f.host.applyContent;
  f.host.applyContent = async () => { throw Error('server unavailable'); };
  await assert.rejects(first.saveBlock(session, { text: '重开草稿' }));
  const draft = copy(f.drafts.get(`pending:${session.key}`));
  assert.equal(f.drafts.get(session.key).type, 'block');
  const reopened = new Controller(f.host);
  reopened.restorePending(session.key, draft);
  f.host.applyContent = originalApply;
  await reopened.retry(session.key);
  assert.equal(f.calls.at(-1).operationId, draft.operationId);
  assert.equal(f.calls.at(-1).generation, draft.generation);
  assert.equal(f.calls.at(-1).expectedRevisions['knowledge:KU-055'], 7);
  assert.equal(logic.findBlock(f.entities.get('KU-055').entity, 'P1').payload.text, '重开草稿');
});

// Optional real browser harness: no extra packages, temporary profile removed on exit.
test('Chrome: local MathLive, semantic content edits, notes, drawing/move/resize, cancel, reload and orphan reassociation',
  { skip: process.env.REVIEW_EDITING_BROWSER !== '1', timeout: 60000 }, async t => {
    const provider = require('../web/content/provider.js');
    const directory = mkdtempSync(join(tmpdir(), 'review-editing-runtime-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const { app, experiments } = require('./runtime-fixture.cjs').copyRuntime(directory);
    const base = entity();
    const script = `
      const saved = sessionStorage.getItem('editing-fixture');
      let state = saved ? JSON.parse(saved) : {record:{entity:${JSON.stringify(base)},hash:'hash-3',revision:7,generation:1}, docs:{notes:{},annotations:{},layout:{}},calls:[],drafts:{}};
      const listeners = new Set(); const cp=x=>structuredClone(x);
      const store=()=>sessionStorage.setItem('editing-fixture',JSON.stringify(state));
      function renderLayout(){const box=state.docs.layout['VE-KU-055']?.value;if(box)Object.assign(document.querySelector('.unit').style,{left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px',minHeight:'0',overflow:'auto'});}
      function render(){document.querySelector('.unit-content').innerHTML=ReviewContentProvider.render(state.record.entity);ReviewContentProvider.afterRender(document.querySelector('.unit-content'));renderLayout();}
      window.host={selectedUnit:()=>state.record.entity,
        getEntity:async uid=>{if(uid!==state.record.entity.id)throw Object.assign(Error('not_found'),{code:'not_found'});return cp(state.record);},
        personalEntries:ns=>Object.entries(state.docs[ns]||{}).map(([key,v])=>({key,...cp(v)})),
        onRefresh:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
        stageDraft:(key,value)=>{if(value==null)delete state.drafts[key];else state.drafts[key]=cp(value);store();},
        recoverDrafts:()=>Object.entries(state.drafts).map(([key,value])=>({key,value:cp(value)})),
        applyContent:async command=>{state.calls.push(cp(command));const change=command.changes[0];
          if(command.expectedRevisions['knowledge:KU-055']!==state.record.revision)throw Object.assign(Error('revision conflict'),{code:'revision_conflict'});
          state.record.entity=cp(change.value);state.record.revision++;store();render();listeners.forEach(fn=>fn());return {saved:true,operationId:command.operationId};},
        applyPersonal:async(changes,kind,meta)=>{state.calls.push(cp({changes,kind,...meta}));for(const c of changes){if((state.docs[c.namespace][c.key]?.revision||0)!==meta.expectedRevisions[c.namespace+':'+c.key])throw Object.assign(Error('conflict'),{code:'revision_conflict'});}
          for(const c of changes)state.docs[c.namespace][c.key]={value:cp(c.value),revision:(state.docs[c.namespace][c.key]?.revision||0)+1};store();renderLayout();listeners.forEach(fn=>fn());return {saved:true,operationId:meta.operationId};},
        undo:async operationId=>({saved:true,operationId:'inverse-'+operationId})};
      window.fixture=()=>state;window.repaint=()=>{render();listeners.forEach(fn=>fn());};
      render();window.editing=ReviewEditing.mount(host);
    `;
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/web/editing.css"><link rel="stylesheet" href="/web/content/content.css"><link rel="stylesheet" href="/assets/prototype/style.css">
      <style>body{margin:0}#viewport{position:relative;width:1600px;height:1300px}.unit{position:absolute;left:30px;top:30px;width:900px;margin:0;min-height:900px;border:1px solid #ccc;padding:30px;box-sizing:border-box}.reading-block{padding:20px}#world{position:relative;width:1200px;height:1800px;transform:scale(.8);transform-origin:0 0}.unit-content{font-size:22px;line-height:1.8}</style></head>
      <body><div id="viewport"><div id="world"><article class="unit frame" data-unit="KU-055"><div class="unit-content">${provider.render(base)}</div></article></div></div>
      <script src="/assets/style/vendor/mathlive/mathlive.min.js"></script><script src="/web/content/provider.js"></script><script src="/web/editing.js"></script><script>${script}</script></body></html>`;
    const server = createServer((req, res) => {
      try {
        if (req.url === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(html); return; }
        const path = req.url.startsWith('/assets/prototype/') ? join(experiments, 'content-depth-prototype', req.url.slice('/assets/prototype/'.length)) :
          req.url.startsWith('/assets/style/') ? join(experiments, 'style-math-prototype', req.url.slice('/assets/style/'.length)) :
          join(app, req.url.split('?')[0]);
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
        res.end(readFileSync(path));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const profile = mkdtempSync(join(tmpdir(), 'review-editing-chrome-'));
    const chrome = spawn(process.env.REVIEW_EDITING_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1600,1300', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(async () => { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)); rmSync(profile, { recursive: true, force: true }); });
    const endpoint = await new Promise((resolve, reject) => {
      let data = ''; chrome.once('error', reject);
      chrome.stderr.on('data', chunk => { data += chunk; const match = data.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
    });
    const tabs = await (await fetch(endpoint.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
    const tab = tabs.find(tab => tab.type === 'page');
    assert.ok(tab, 'Chrome must expose a page target');
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
    t.after(() => ws.close());
    let seq = 0; const waiting = new Map(), browserErrors = [];
    ws.addEventListener('message', event => { const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') browserErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.id) {
      const job = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? job.reject(Error(msg.error.message)) : job.resolve(msg.result); } });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description || ''));
      return result.result.value;
    };
    const until = async expression => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw Error(`browser wait failed: ${expression}; status=${await evaluate("document.querySelector('.editing-status')?.textContent")}; page=${await evaluate('location.href+" :: "+document.documentElement.outerHTML.slice(0,600)')}; errors=${browserErrors.join('\n')}`);
    };
    const click = async label => evaluate(`(()=>{const el=[...document.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)}&&!el.closest('[hidden]')&&el.getClientRects().length>0);if(!el)throw Error('Missing visible button '+${JSON.stringify(label)});el.click();return true;})()`);
    const input = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const url = `http://127.0.0.1:${server.address().port}/`;
    await cdp('Runtime.enable');
    if (process.env.REVIEW_EDITING_APP_URL) {
      await cdp('Page.navigate', { url: process.env.REVIEW_EDITING_APP_URL });
      await until('!!window.ReviewBoard?.editing && !!document.querySelector(".editing-overlay")');
      t.diagnostic(await evaluate('(()=>{const e=document.querySelector(".editing-overlay"),out=[];function scan(s){try{for(const r of s.cssRules||[]){if(r.styleSheet)scan(r.styleSheet);if(r.selectorText&&e.matches(r.selectorText)&&r.style.position)out.push(r.cssText);}}catch{}}for(const s of document.styleSheets)scan(s);return e.outerHTML.slice(0,180)+" :: "+out.join(" :: ");})()'));
      const measurements = await evaluate('(async()=>{const a=[];for(let i=0;i<20;i++){await new Promise(requestAnimationFrame);const u=document.querySelector(".unit[data-unit=KU-055]"),s=u.querySelector(".editing-overlay"),c=getComputedStyle(s);a.push({height:u.offsetHeight,scroll:u.scrollHeight,svg:s.getBoundingClientRect().height,position:c.position,cssHeight:c.height});}return a;})()');
      t.diagnostic(JSON.stringify(measurements));
      assert.equal(new Set(measurements.map(x=>x.height)).size, 1, 'real app unit height must stay stable');
      return;
    }
    await cdp('Page.navigate', { url }); await until('!!window.editing && !!document.querySelector("[data-edit-block=F1]")');
    const heights = await evaluate('(async()=>{const a=[];for(let i=0;i<15;i++){await new Promise(requestAnimationFrame);a.push(document.querySelector(".unit").offsetHeight);}return a;})()');
    assert.equal(new Set(heights).size, 1, `overlay must not grow the unit: ${heights.join(',')}`);
    assert.equal(await evaluate('[...document.querySelectorAll(".editing-toolbar button")].filter(el=>el.getClientRects().length>0).length'), 1);
    await click('编辑与标注');
    await evaluate('document.querySelector("[data-edit-block=F1]").click()');
    await until('!!document.querySelector(".editing-panel math-field")');
    await click('上划线');
    await evaluate('document.querySelector(".editing-panel math-field").insert("y");document.querySelector(".editing-panel math-field").dispatchEvent(new Event("input",{bubbles:true}))');
    await click('保存修改');
    await until('fixture().calls.some(c=>c.kind==="knowledge.update") && !document.querySelector(".editing-status").dataset.error.includes("true")');
    assert.match(await evaluate('fixture().record.entity.reading.blocks.find(b=>b.id==="F1").payload.latex'), /overline/);
    await until('!!document.querySelector(".editing-semantic-warning")');
    await click('关闭编辑');
    await click('片段 / 对象笔记'); await until('!!document.querySelector("textarea[aria-label=个人笔记]")');
    await input('textarea[aria-label=个人笔记]', '浏览器自动保存笔记');
    await until('Object.keys(fixture().docs.notes).length===1');
    await click('关闭编辑');
    async function drag(x, y, ex, ey, cancel = false) {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ex, y: ey, button: 'left', buttons: 1 });
      if (cancel) await evaluate('document.dispatchEvent(new PointerEvent("pointercancel",{pointerId:1,bubbles:true}))');
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex, y: ey, button: 'left', clickCount: 1 });
    }
    const rect = await evaluate('(()=>{const r=document.querySelector("[data-block-id=P1]").getBoundingClientRect();return{x:r.left+40,y:r.top+65}})()');
    for (const label of ['直线', '波浪线', '荧光笔', '矩形', '椭圆', '手画箭头']) {
      const before = await evaluate('Object.keys(fixture().docs.annotations).length');
      await click(label); await drag(rect.x, rect.y, rect.x + 100, rect.y + 26);
      await until(`Object.keys(fixture().docs.annotations).length===${before + 1}`);
    }
    const key = await evaluate('Object.keys(fixture().docs.annotations)[0]');
    assert.equal(await evaluate('fixture().calls.filter(c=>c.kind==="relation.create").length'), 0);
    await click('移动 / 尺寸');
    const hit = await evaluate('(()=>{const r=document.querySelector("[data-drawing-hit]").getBoundingClientRect();return{x:r.left+12,y:r.top+12}})()');
    await drag(hit.x, hit.y, hit.x + 30, hit.y + 30);
    await until('fixture().calls.some(c=>c.kind==="annotation.transform")');
    const handle = await evaluate('(()=>{const r=document.querySelector("[data-drawing-resize]").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()');
    const transforms = await evaluate('fixture().calls.filter(c=>c.kind==="annotation.transform").length');
    await drag(handle.x, handle.y, handle.x + 24, handle.y + 24);
    await until(`fixture().calls.filter(c=>c.kind==="annotation.transform").length===${transforms + 1}`);
    await click('矩形');
    const drawings = await evaluate('Object.keys(fixture().docs.annotations).length');
    await drag(rect.x, rect.y, rect.x + 80, rect.y + 22, true);
    assert.equal(await evaluate('Object.keys(fixture().docs.annotations).length'), drawings);
    await click('单元位置 / 尺寸'); await until('!!document.querySelector("input[aria-label=宽度]")');
    await input('input[aria-label=横向位置]', '80'); await input('input[aria-label=纵向位置]', '90');
    await input('input[aria-label=宽度]', '950'); await input('input[aria-label=高度]', '1800');
    await click('保存修改'); await until('fixture().docs.layout["VE-KU-055"]?.value.width===950');
    await click('关闭编辑');
    const objectHandle = await evaluate('(()=>{const r=document.querySelector("[data-unit-transform=move]").getBoundingClientRect();return{x:r.left+10,y:r.top+10}})()');
    await drag(objectHandle.x, objectHandle.y, objectHandle.x + 32, objectHandle.y + 24);
    await until('fixture().calls.filter(c=>c.kind==="object.transform").length===2');
    assert.equal(await evaluate('fixture().docs.layout["VE-KU-055"].value.x'), 120);
    // Reload uses only the harness host's persisted state, never storage inside editing.js.
    const previousContext = await evaluate('window.browserRunId=crypto.randomUUID()');
    await cdp('Page.reload');
    await until(`window.browserRunId!==${JSON.stringify(previousContext)} && !!window.fixture && !!window.editing && document.querySelectorAll('[data-drawing-id]').length===6`);
    assert.equal(await evaluate('Object.values(fixture().docs.notes)[0].value.text'), '浏览器自动保存笔记');
    await evaluate('fixture().record.entity.reading.blocks=fixture().record.entity.reading.blocks.filter(b=>b.id!=="P1");repaint()');
    await click('编辑与标注');
    await click('笔记 / 待重新关联'); await until('document.querySelectorAll(".editing-anchor-orphan").length===6');
    await evaluate(`(()=>{const item=[...document.querySelectorAll('.editing-library-item')].find(x=>x.querySelector('h3').textContent.startsWith('line'));
      item.querySelector('input[aria-label="目标块 ID（空为对象笔记）"]').value='F1';item.querySelector('button:last-child').click();})()`);
    await until(`fixture().docs.annotations[${JSON.stringify(key)}].value.anchor.blockId==='F1'`);
    assert.equal(await evaluate(`fixture().docs.annotations[${JSON.stringify(key)}].value.anchor.originalAnchor.blockId`), 'P1');
    // A dirty text draft is durable through the host and reopens with its original CAS baseline.
    await evaluate('document.getElementById("E1").open=true;document.querySelector("[data-edit-block=CHILD]").click()');
    await until('!!document.querySelector("textarea[aria-label=文字]")');
    await input('textarea[aria-label=文字]', '恢复后的完整解答');
    const draftContext = await evaluate('window.browserRunId=crypto.randomUUID()');
    await cdp('Page.reload');
    await until(`window.browserRunId!==${JSON.stringify(draftContext)} && !!window.editing && !!window.fixture`);
    await click('编辑与标注'); await click('恢复未保存编辑'); await until('!!document.querySelector(".editing-library-item")');
    await click('恢复这份草稿'); await until('document.querySelector("textarea[aria-label=文字]")?.value==="恢复后的完整解答"');
    await click('保存修改');
    await until('fixture().record.entity.reading.blocks.find(b=>b.id==="E1").children[0].payload.text==="恢复后的完整解答"');
    assert.equal(await evaluate('Object.keys(fixture().drafts).length'), 0);
    assert.equal(await evaluate('document.querySelectorAll("script[src*=https]").length'), 0);
  });
