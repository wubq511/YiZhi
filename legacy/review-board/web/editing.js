/* Editing owns drafts and operation cursors only; the host owns all persistence/history. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ReviewEditing = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  'use strict';
  const clone = value => structuredClone(value);
  const id = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const TOOLS = ['line', 'wave', 'highlight', 'rectangle', 'ellipse', 'arrow'];
  const flatten = blocks => (blocks || []).flatMap(block => [block, ...flatten(block.children)]);
  const findBlock = (entity, blockId) => flatten(entity?.reading?.blocks).find(block => block.id === blockId);
  const unitId = host => { const unit = host.selectedUnit(); return typeof unit === 'string' ? unit : unit?.id; };
  const retired = entity => !entity || entity.retired === true || ['retired', 'deleted'].includes(entity.status);
  const textOf = block => {
    const p = block?.payload || {};
    return p.text ?? p.latex ?? p.problem ?? p.caption ?? (p.items || []).join('\n');
  };
  function fieldsFor(block) {
    const p = block.payload || {};
    const fields = {
      paragraph: ['text'], callout: ['text'], formula: ['latex', 'caption'],
      steps: ['items'], table: ['columns', 'rows'], figure: ['alt', 'caption'],
      'knowledge-reference': ['targetUnitId', 'intent'],
      example: p.questionId ? ['title'] : ['title', 'problem'],
      exercise: p.questionId ? ['title', 'hint'] : ['title', 'problem', 'hint'],
    };
    return fields[block.kind] || [];
  }
  function editBlock(block, patch) {
    const allowed = fieldsFor(block), result = clone(block);
    if (!allowed.length) throw fail('unsupported_block', '此块暂不支持手动修改，请编辑其文字或公式子块。');
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) throw fail('invalid_content', `不能修改字段 ${key}`);
      result.payload[key] = clone(value);
    }
    const p = result.payload;
    for (const key of allowed) {
      if (!['items', 'columns', 'rows'].includes(key) && p[key] !== undefined && typeof p[key] !== 'string')
        throw fail('invalid_content', `${key} 必须是文本`);
    }
    const required = { paragraph: 'text', callout: 'text', formula: 'latex', figure: 'alt',
      'knowledge-reference': 'intent', example: 'title', exercise: 'title' }[block.kind];
    if (required && !p[required]?.trim()) throw fail('invalid_content', '必填内容不能为空。');
    if (block.kind === 'steps' && (!Array.isArray(p.items) || !p.items.length || p.items.some(x => typeof x !== 'string' || !x.trim())))
      throw fail('invalid_content', '每一步都需要文字。');
    if (block.kind === 'table') {
      const cell = x => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)) ||
        (x && typeof x === 'object' && typeof x.latex === 'string' && x.latex.trim());
      if (!Array.isArray(p.columns) || !p.columns.length || !p.columns.every(cell) || !Array.isArray(p.rows) || !p.rows.length ||
        p.rows.some(row => !Array.isArray(row) || row.length !== p.columns.length || !row.every(cell)))
        throw fail('invalid_content', '表格行列不一致或单元格无效。');
    }
    return result;
  }
  function semanticImpact(entity, block) {
    if (!['formula', 'figure', 'table'].includes(block.kind)) return null;
    const components = flatten(entity.reading?.blocks).filter(b => b.kind === 'interactive');
    // Existing bindings mix block IDs and config field names. Unprovable links stay visibly uncertain.
    if (!components.length) return null;
    return { status: 'needs-review', blockIds: components.map(b => b.id),
      reason: '相关公式或图示已修改，尚未同步到探索组件的计算配置。' };
  }
  function replaceInEntity(record, blockId, patch) {
    if (retired(record.entity)) throw fail('not_found', '原单元已删除或退休。');
    const entity = clone(record.entity), original = findBlock(entity, blockId);
    if (!original) throw fail('not_found', '原正文块已失效，请保留草稿并重新定位。');
    const block = editBlock(original, patch);
    const replace = blocks => blocks.map(item => item.id === blockId ? block :
      item.children ? { ...item, children: replace(item.children) } : item);
    entity.reading.blocks = replace(entity.reading.blocks);
    const impact = semanticImpact(entity, block);
    if (impact) for (const component of flatten(entity.reading.blocks)) {
      if (impact.blockIds.includes(component.id)) component.payload.semanticStatus = clone(impact);
    }
    return { entity, block, impact };
  }
  function makeAnchor(record, blockId = null, selection = null) {
    if (retired(record.entity)) throw fail('not_found', '不能关联到已删除或退休的单元。');
    const block = blockId ? findBlock(record.entity, blockId) : null;
    if (blockId && !block) throw fail('not_found', '找不到目标正文块。');
    const anchor = { objectId: record.entity.id, blockId,
      revision: record.entity.reading?.revision ?? record.revision,
      originalText: selection?.exact ?? (block ? textOf(block) : record.entity.summary || record.entity.name || ''),
      sourceRefs: clone(block?.sourceRefs ?? record.entity.sourceRefs ?? []) };
    if (selection) anchor.selector = clone(selection);
    return anchor;
  }
  function anchorState(anchor, record) {
    if (!record || retired(record.entity)) return { status: 'orphan', reason: '原单元已删除或退休' };
    const block = anchor.blockId ? findBlock(record.entity, anchor.blockId) : null;
    if (anchor.blockId && !block) return { status: 'orphan', reason: '原正文块已删除或拆合，需重新关联' };
    if (anchor.selector?.exact) {
      const text = textOf(block), exact = anchor.selector.exact;
      const matches = []; let at = text.indexOf(exact);
      while (at !== -1) { matches.push(at); at = text.indexOf(exact, at + 1); }
      const qualified = matches.filter(start => (!anchor.selector.prefix || text.slice(0, start).endsWith(anchor.selector.prefix)) &&
        (!anchor.selector.suffix || text.slice(start + exact.length).startsWith(anchor.selector.suffix)));
      if (qualified.length !== 1) return { status: 'orphan', reason: '原选段无法唯一定位；保留原文待重新关联' };
    }
    const changed = (record.entity.reading?.revision ?? record.revision) !== anchor.revision;
    return { status: changed ? 'changed' : 'attached', reason: changed ? '正文已改写，原语境仍保留' : '' };
  }
  function relocate(anchor, target) {
    return { ...clone(target), originalAnchor: clone(anchor.originalAnchor || anchor),
      relocations: [...clone(anchor.relocations || []), { objectId: anchor.objectId, blockId: anchor.blockId,
        revision: anchor.revision, originalText: anchor.originalText, sourceRefs: clone(anchor.sourceRefs), at: new Date().toISOString() }] };
  }
  function localPoint(panel, clientX, clientY) {
    const box = panel.getBoundingClientRect();
    if (!box.width || !box.height) throw fail('invalid_parameter', '目标暂不可见。');
    return { x: (clientX - box.left) * panel.offsetWidth / box.width,
      y: (clientY - box.top) * panel.offsetHeight / box.height };
  }
  function boxBetween(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(2, Math.abs(b.x - a.x)),
      height: Math.max(2, Math.abs(b.y - a.y)), flipX: b.x < a.x, flipY: b.y < a.y };
  }
  function validBox(box) {
    if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) || box.width < 2 || box.height < 2)
      throw fail('invalid_parameter', '标注位置和尺寸无效。');
    return clone(box);
  }
  const receipt = (result, operationId) => {
    if (!result?.saved || !result.operationId || (operationId && result.operationId !== operationId))
      throw fail('save_unconfirmed', '服务尚未确认落盘；草稿已保留，请重试。');
    return result;
  };
  class Controller {
    constructor(host) {
      this.host = host;
      this.pending = new Map(); // Unacknowledged requests only, never undo snapshots.
      this.undoId = null; this.redoId = null;
    }
    entries(namespace) { return this.host.personalEntries(namespace).filter(row => row.value != null); }
    entry(namespace, key) { return this.host.personalEntries(namespace).find(row => row.key === key) || { key, value: null, revision: 0 }; }
    draft(key, value) { this.host.stageDraft?.(key, value == null ? null : clone(value)); }
    async openBlock(entityId, blockId) {
      const record = clone(await this.host.getEntity(entityId));
      const block = findBlock(record.entity, blockId);
      if (!block || retired(record.entity)) throw fail('not_found', '找不到可编辑的原始正文。');
      return { key: `block:${entityId}:${blockId}`, entityId, blockId, record,
        block: clone(block), groupId: id('EDIT') };
    }
    contentCommand(record, entity, kind, groupId) {
      return { operationId: id('OP'), groupId, actor: 'student', kind,
        generation: record.generation,
        changes: [{ namespace: 'knowledge', key: entity.id, value: entity }],
        expectedRevisions: { [`knowledge:${entity.id}`]: record.revision },
        expectedEntityHashes: { [entity.id]: record.hash } };
    }
    async submit(key, payload, send) {
      const pending = this.pending.get(key) || { payload: clone(payload), send };
      if (pending.running) return pending.running;
      this.pending.set(key, pending);
      this.draft(`pending:${key}`, pending.payload);
      pending.running = (async () => {
        const result = receipt(await pending.send(pending.payload), pending.payload.operationId);
        this.pending.delete(key); this.draft(`pending:${key}`, null);
        this.undoId = result.operationId; this.redoId = null;
        return result;
      })();
      try { return await pending.running; } finally { pending.running = null; }
    }
    async retry(key) {
      const pending = this.pending.get(key);
      if (!pending) throw fail('not_found', '没有待重试的操作。');
      return this.submit(key, pending.payload, pending.send);
    }
    restorePending(key, payload) {
      if (this.pending.has(key)) return;
      if (!payload?.operationId || !payload.kind) throw fail('invalid_content', '保存草稿缺少原始操作身份。');
      const content = payload.kind.startsWith('knowledge.') || payload.kind === 'relation.create';
      const send = content ? value => this.host.applyContent(value) : value => this.host.applyPersonal(value.changes, value.kind, {
        operationId: value.operationId, groupId: value.groupId, expectedRevisions: value.expectedRevisions });
      this.pending.set(key, { payload: clone(payload), send });
    }
    async saveBlock(session, patch) {
      if (session.saved) throw fail('invalid_parameter', '该编辑组已提交，请重新打开正文。');
      const replacement = replaceInEntity(session.record, session.blockId, patch);
      const command = this.contentCommand(session.record, replacement.entity, 'knowledge.update', session.groupId);
      if (replacement.impact) command.semanticImpact = replacement.impact;
      if (session.materialChange) {command.materialChange=true;command.materialReason='手动编辑改变了重要结论或方法';}
      this.draft(session.key, { version: 1, type: 'block', session: clone(session),
        target: { objectId: session.entityId, blockId: session.blockId }, value: clone(patch) });
      const actual = this.pending.get(session.key)?.payload || command;
      const committed = findBlock(actual.changes[0].value, session.blockId);
      const committedValue = Object.fromEntries(fieldsFor(committed).filter(key => key in committed.payload)
        .map(key => [key, clone(committed.payload[key])]));
      const result = await this.submit(session.key, command, payload => this.host.applyContent(payload));
      session.saved = true; this.draft(session.key, null);
      return { ...result, committedValue };
    }
    async personal(changes, kind, baseRevisions, key = id('EDIT')) {
      const metadata = { operationId: id('OP'), groupId: id('EDIT'),
        expectedRevisions: baseRevisions || Object.fromEntries(changes.map(c =>
          [`${c.namespace}:${c.key}`, this.entry(c.namespace, c.key).revision])) };
      return this.submit(key, { ...metadata, changes, kind }, payload =>
        this.host.applyPersonal(payload.changes, payload.kind, {
          operationId: payload.operationId, groupId: payload.groupId, expectedRevisions: payload.expectedRevisions }));
    }
    async createNote(record, blockId, text, selection, noteId = id('NOTE')) {
      if (!text.trim()) throw fail('invalid_content', '笔记不能为空。');
      const at = new Date().toISOString(), anchor = makeAnchor(record, blockId, selection);
      const value = { noteId, objectId: anchor.objectId, text, anchor, createdAt: at, updatedAt: at };
      const committedValue = clone(this.pending.get(noteId)?.payload.changes[0].value || value);
      await this.personal([{ namespace: 'notes', key: noteId, value }], 'note.create', { [`notes:${noteId}`]: 0 }, noteId);
      return committedValue;
    }
    async saveNote(base, text) {
      if (!text.trim()) throw fail('invalid_content', '笔记不能为空。');
      const committedValue = this.pending.get(base.key)?.payload.changes[0].value.text ?? text;
      const result = await this.personal([{ namespace: 'notes', key: base.key,
        value: { ...clone(base.value), text, updatedAt: new Date().toISOString() } }], 'note.update',
      { [`notes:${base.key}`]: base.revision }, base.key);
      return { ...result, committedValue };
    }
    async createDrawing(record, blockId, tool, box, color = '#345d88', drawingId = id('DRAW')) {
      if (!TOOLS.includes(tool)) throw fail('invalid_parameter', '不支持此标注工具。');
      const at = new Date().toISOString(), anchor = makeAnchor(record, blockId);
      const value = { drawingId, objectId: anchor.objectId, tool, color, anchor, createdAt: at, updatedAt: at };
      await this.personal([{ namespace: 'annotations', key: drawingId, value },
        { namespace: 'layout', key: drawingId, value: { ...validBox(box), objectId: anchor.objectId, blockId } }],
      'annotation.create', { [`annotations:${drawingId}`]: 0, [`layout:${drawingId}`]: 0 }, drawingId);
      return value;
    }
    async transformDrawing(base, box) {
      if (this.pending.has(`transform:${base.key}`)) throw fail('unsaved_draft', '此图形仍有未确认的移动，请先在待重新关联面板重试。');
      return this.personal([{ namespace: 'layout', key: base.key, value: { ...clone(base.value), ...validBox(box) } }],
        'annotation.transform', { [`layout:${base.key}`]: base.revision }, `transform:${base.key}`);
    }
    async transformObject(base, entityId, box) {
      const pendingKey = `object:${entityId}`;
      if (this.pending.has(pendingKey)) return this.retry(pendingKey);
      const key = `VE-${entityId}`;
      if (base.key !== key) throw fail('invalid_parameter', '单元布局身份不匹配。');
      return this.personal([{ namespace: 'layout', key, value: { ...clone(base.value || {}), objectId: entityId, ...validBox(box) } }],
        'object.transform', { [`layout:${key}`]: base.revision }, `object:${entityId}`);
    }
    async reanchor(namespace, base, record, blockId) {
      if (this.pending.has(`anchor:${base.key}`)) throw fail('unsaved_draft', '此对象仍有未确认的重关联，请先重试原操作。');
      const anchor = relocate(base.value.anchor, makeAnchor(record, blockId));
      const value = { ...clone(base.value), objectId: anchor.objectId, anchor, updatedAt: new Date().toISOString() };
      const changes = [{ namespace, key: base.key, value }];
      const revisions = { [`${namespace}:${base.key}`]: base.revision };
      if (namespace === 'annotations') {
        const layout = this.entry('layout', base.key);
        changes.push({ namespace: 'layout', key: base.key, value: { ...(layout.value || { x: 8, y: 8, width: 100, height: 30 }),
          objectId: anchor.objectId, blockId } });
        revisions[`layout:${base.key}`] = layout.revision;
      }
      return this.personal(changes, 'anchor.reassociate', revisions, `anchor:${base.key}`);
    }
    async createRelation(input, bases) {
      const relation = clone(input);
      if (!['requires', 'constructs', 'improves', 'inverse'].includes(relation.type) || typeof relation.directed !== 'boolean' ||
        !relation.value?.trim() || !relation.sourceRefs?.length || relation.fromUnitId === relation.toUnitId)
        throw fail('invalid_content', '请明确填写关系类型、方向、价值和真实来源，并使用不同端点。');
      if (relation.type === 'inverse' && relation.directed || relation.type === 'requires' && !relation.directed)
        throw fail('invalid_content', '互逆关系为双向；学习前置必须从前置指向后继。');
      const records = bases || await Promise.all([relation.fromUnitId, relation.toUnitId].map(uid => this.host.getEntity(uid)));
      for (const [i, record] of records.entries()) {
        if (retired(record.entity) || record.entity.id !== [relation.fromUnitId, relation.toUnitId][i])
          throw fail('not_found', '关系端点已删除或退休。');
      }
      const available = records.flatMap(r => r.entity.sourceRefs || []);
      if (relation.sourceRefs.some(ref => !available.some(x => JSON.stringify(x) === JSON.stringify(ref))))
        throw fail('invalid_content', '关系来源必须从实际端点引用中选择。');
      const command = { operationId: id('OP'), groupId: id('EDIT'), actor: 'student', kind: 'relation.create',
        generation: records[0].generation, relation,
        expectedEntities: Object.fromEntries(records.map(record => [record.entity.id,
          { hash: record.hash, revision: record.revision }])),
        expectedRevisions: Object.fromEntries(records.map(record => [`knowledge:${record.entity.id}`, record.revision])) };
      return this.submit('relation', command, payload => this.host.applyContent(payload));
    }
    async undo() {
      const cursor = this.host.history ? this.host.history().undoOperationId : this.undoId;
      if (!cursor) throw fail('not_found', '没有可撤回的已保存操作。');
      const result = receipt(await this.host.undo(cursor));
      this.redoId = result.operationId; this.undoId = null;
      return result;
    }
    async redo() {
      const cursor = this.host.history ? this.host.history().redoOperationId : this.redoId;
      if (!cursor) throw fail('not_found', '没有可重做的操作。');
      const result = receipt(await (this.host.redo ? this.host.redo(cursor) : this.host.undo(cursor)));
      this.undoId = result.operationId; this.redoId = null;
      return result;
    }
  }

  function mount(host) {
    for (const method of ['selectedUnit', 'getEntity', 'applyContent', 'applyPersonal', 'personalEntries', 'onRefresh', 'undo'])
      if (typeof host[method] !== 'function') throw fail('invalid_host', `ReviewEditing host 缺少 ${method}()`);
    const doc = host.document || globalThis.document, win = doc.defaultView;
    if (doc.querySelector('[data-review-editing-root]')) throw fail('already_mounted', '编辑模块已挂载。');
    const controller = new Controller(host), abort = new win.AbortController();
    const signal = abort.signal, NS = 'http://www.w3.org/2000/svg';
    const create = (tag, attrs = {}, text) => {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const button = (text, fn, parent) => {
      const el = create('button', { type: 'button' }, text);
      el.addEventListener('click', fn, { signal }); parent?.append(el); return el;
    };
    const ui = create('aside', { 'data-editing-ui': '', 'data-review-editing-root': '', class: 'review-editing', 'aria-label': '编辑与标注' });
    const toolbar = create('div', { class: 'editing-toolbar', role: 'toolbar', 'aria-label': '编辑与标注工具' });
    const status = create('p', { class: 'editing-status', role: 'status', 'aria-live': 'polite' }, '阅读模式');
    const panel = create('section', { class: 'editing-panel', hidden: '', 'aria-label': '编辑器' });
    const library = create('section', { class: 'editing-library', hidden: '', 'aria-label': '笔记与待重新关联的标注' });
    ui.append(toolbar, status, panel, library); doc.body.append(ui);
    let active = false, tool = 'select', editor = null, gesture = null, selection = null;
    let space = false, destroyed = false, refreshVersion = 0, noteTimer = null, libraryOpen = false;
    let recoveredDrafts = [];
    const overlays = new Map(), records = new Map(), inflight = new Set();
    const on = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal });
    const say = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
    const track = promise => {
      inflight.add(promise);
      promise.finally(() => inflight.delete(promise)).catch(() => {});
      return promise;
    };
    const perform = async fn => {
      try {
        say('正在处理…'); const result = await track(Promise.resolve().then(fn));
        if (result?.saved) say('已保存到课程');
        else if (status.textContent === '正在处理…') say('操作完成');
        await refresh();
      }
      catch (error) { say(`${error.code === 'revision_conflict' ? '版本冲突，未覆盖新内容。' : ''}${error.message || error} 草稿保留，可重试。`, true); }
    };
    const panels = () => [...doc.querySelectorAll('.unit[data-unit], .unit-panel[data-unit]')];
    const panelFor = uid => panels().find(el => el.dataset.unit === uid);
    const blockElement = (unit, bid) => !bid ? unit : [...unit.querySelectorAll('[data-block-id],details[id],.reading-exercise[id]')]
      .find(el => (el.dataset.blockId || el.id) === bid);
    const visible = el => el && !el.closest('[hidden]') && el.getClientRects().length > 0 &&
      !el.parentElement?.closest('details:not([open])');
    function syncPanelVisibility() {
      panel.hidden = !active || !editor || libraryOpen;
      library.hidden = !active || !libraryOpen;
    }
    function mode(next) {
      active = next; doc.body.dataset.editing = String(next);
      ui.dataset.active = String(next);
      syncPanelVisibility();
      toggle.setAttribute('aria-pressed', String(next));
      for (const unit of panels()) unit.classList.toggle('review-editing-active', next);
      if (!next) { tool = 'select'; cancelGesture(); }
      for (const [key, el] of toolButtons) el.setAttribute('aria-pressed', String(next && tool === key));
      say(next ? '编辑模式：可选中文字；空格或中键拖动画板' : '阅读模式'); paintOverlays();
    }
    const toggle = button('编辑与标注', () => mode(!active), toolbar);
    toggle.setAttribute('aria-pressed', 'false');
    button('编辑当前文字 / 公式', () => perform(async () => {
      mode(true); const uid = unitId(host), record = await host.getEntity(uid);
      const first = flatten(record.entity.reading?.blocks).find(b => fieldsFor(b).length);
      if (!first) throw fail('unsupported_block', '此单元尚无可编辑的正文块。');
      await openBlock(uid, first.id);
    }), toolbar);
    button('片段 / 对象笔记', () => perform(() => openNote()), toolbar);
    const toolButtons = new Map();
    for (const [key, label] of [['select', '选取文字'], ['move', '移动 / 尺寸'], ['line', '直线'], ['wave', '波浪线'], ['highlight', '荧光笔'],
      ['rectangle', '矩形'], ['ellipse', '椭圆'], ['arrow', '手画箭头']]) {
      const el = button(label, () => { mode(true); tool = key; mode(true); }, toolbar);
      el.setAttribute('aria-pressed', 'false'); toolButtons.set(key, el);
    }
    button('建立知识关系', () => perform(openRelation), toolbar);
    button('撤回修改', () => perform(() => controller.undo()), toolbar);
    button('重做修改', () => perform(() => controller.redo()), toolbar);
    function showLibrary(open) {
      libraryOpen = open; syncPanelVisibility();
      refresh().catch(error => say(error.message, true)).finally(syncPanelVisibility);
    }
    button('笔记 / 待重新关联', () => showLibrary(!libraryOpen), toolbar);
    button('恢复未保存编辑', () => showLibrary(true), toolbar);
    const color = create('input', { type: 'color', value: '#345d88', 'aria-label': '标注颜色' }); toolbar.append(color);
    function draftSnapshot(current) {
      return { version: 1, type: current.type, target: clone(current.target), value: clone(current.read()),
        ...(current.session ? { session: clone(current.session) } : {}),
        ...(current.type === 'note' ? { base: clone(current.base), record: clone(current.record), noteId: current.key } : {}),
        ...(current.type === 'object' ? { base: clone(current.base) } : {}) };
    }
    function dirtyDraft() {
      if (!editor) return;
      editor.dirty = true; controller.draft(editor.key, draftSnapshot(editor));
      say('未保存的编辑');
      if (editor.type === 'note' && !editor.saving) {
        clearTimeout(noteTimer); noteTimer = setTimeout(() => perform(saveEditor), 900);
      }
    }
    async function prepareEditor(next) {
      clearTimeout(noteTimer);
      if (editor?.dirty || editor?.saving) throw fail('unsaved_draft', '请先保存当前草稿；冲突时可复制内容后重新打开目标。');
      libraryOpen = false; panel.replaceChildren(); editor = next; mode(true);
      editor.dirty = false; editor.saving = false;
      const head = create('h2', {}, next.title); panel.append(head);
    }
    function addField(label, value, parent = panel, multiline = true) {
      const wrap = create('label', { class: 'editing-field' }), name = create('span', {}, label);
      const input = create(multiline ? 'textarea' : 'input', { 'aria-label': label }); input.value = value ?? '';
      on(input, 'input', () => { if (panel.contains(input)) dirtyDraft(); });
      wrap.append(name, input); parent.append(wrap); return input;
    }
    function mathField(value, parent) {
      const Mathfield = win.MathfieldElement;
      if (!Mathfield) throw fail('capability_unavailable', '本地 MathLive 未加载，公式编辑暂不可用。');
      Mathfield.locale = 'zh-cn';
      Mathfield.fontsDirectory = new URL('/assets/style/vendor/mathlive/fonts', win.location.href).href;
      Mathfield.soundsDirectory = null;
      const field = new Mathfield(); field.setAttribute('aria-label', '可视化公式输入');
      field.setAttribute('data-editing-ui', ''); field.mathVirtualKeyboardPolicy = 'manual';
      parent.append(field); field.setValue(value || '', { silenceNotifications: true }); on(field, 'input', dirtyDraft);
      const keys = create('div', { class: 'editing-symbols', role: 'group', 'aria-label': '符号与结构点选' });
      const insertions = [['x', 'x'], ['y', 'y'], ['z', 'z'], ['F', 'F'], ['A', 'A'], ['B', 'B'], ['0', '0'], ['1', '1'],
        ['等号', '='], ['与', '\\land'], ['或', '\\lor'], ['非', '\\neg'], ['异或', '\\oplus'], ['加号', '+'], ['乘号', '\\cdot'],
        ['上划线', '\\overline{#?}'], ['分数', '\\frac{#?}{#?}'], ['括号', '\\left(#?\\right)'], ['上标', '#?^{#?}'], ['下标', '#?_{#?}'], ['根号', '\\sqrt{#?}']];
      for (const [label, latex] of insertions) {
        const el = button(label, () => { field.focus(); field.insert(latex, { selectionMode: 'placeholder' }); dirtyDraft(); }, keys);
        on(el, 'pointerdown', e => e.preventDefault());
      }
      button('公式草稿撤销', () => { field.executeCommand('undo'); dirtyDraft(); }, keys);
      button('公式草稿重做', () => { field.executeCommand('redo'); dirtyDraft(); }, keys);
      button('更多符号键盘', () => { field.focus(); win.mathVirtualKeyboard?.show(); }, keys);
      parent.append(keys); return field;
    }
    function editorActions() {
      const actions = create('div', { class: 'editing-actions' }); panel.append(actions);
      button('保存修改', () => perform(saveEditor), actions);
      button('关闭编辑', () => {
        if (editor?.dirty || editor?.saving) { say('仍有未保存内容，请先保存；可复制保留草稿。', true); return; }
        editor = null; panel.hidden = true; win.mathVirtualKeyboard?.hide();
      }, actions);
      button('复制草稿', () => perform(async () => {
        await win.navigator.clipboard.writeText(JSON.stringify(editor.read(), null, 2)); say('草稿已复制');
      }), actions);
      button('放弃本次草稿', () => {
        if (editor?.saving) return;
        clearTimeout(noteTimer); controller.draft(editor?.key, null);
        if (editor) { controller.pending.delete(editor.key); controller.draft(`pending:${editor.key}`, null); }
        editor = null; panel.hidden = true; say('草稿已关闭；课程状态以已确认的提交为准');
      }, actions);
    }
    async function openBlock(uid, bid, restored) {
      if (editor?.dirty || editor?.saving) throw fail('unsaved_draft', '请先保存当前草稿。');
      const session = restored?.session ? clone(restored.session) : await controller.openBlock(uid, bid);
      if (session.entityId !== uid || session.blockId !== bid || session.saved) throw fail('invalid_content', '草稿正文目标或基线不完整。');
      const block = restored ? editBlock(session.block, restored.value) : session.block;
      if (!fieldsFor(block).length) throw fail('unsupported_block', '请编辑本组件旁的文字或公式；组件配置由统一语义入口更新。');
      const names={formula:'公式',paragraph:'讲解',callout:'提醒',steps:'步骤',table:'表格',figure:'图示说明',example:'例题',exercise:'练习','knowledge-reference':'知识引用'};
      await prepareEditor({ type: 'block', key: session.key, title: `编辑${names[session.block.kind]||'内容'}`, session, target: { objectId: uid, blockId: bid } });
      const readers = {};
      const labels = { text: '文字', latex: '公式', caption: '说明', alt: '图示说明', items: '步骤（每行一步）', title: '标题',
        problem: '题干', hint: '提示', targetUnitId: '引用单元 ID', intent: '引用意图' };
      for (const field of fieldsFor(block)) {
        if (field === 'latex') {
          const math = mathField(block.payload.latex, panel); readers.latex = () => math.getValue('latex');
        } else if (field === 'columns' || field === 'rows') {
          // A cell grid preserves formula objects; no JSON or LaTeX source entry is required.
          const rows = field === 'columns' ? [block.payload.columns] : block.payload.rows;
          const grid = create('div', { class: 'editing-table-grid', 'aria-label': field === 'columns' ? '表头' : '表格内容' });
          panel.append(grid);
          const cells = rows.map(row => {
            const line = create('div', { class: 'editing-table-row' }); grid.append(line);
            return row.map((value, i) => {
              if (value && typeof value === 'object' && 'latex' in value) {
                const field = mathField(value.latex, line); return () => ({ ...clone(value), latex: field.getValue('latex') });
              }
              const input = addField(`第 ${i + 1} 列`, value, line, false); return () => input.value;
            });
          });
          readers[field] = () => { const result = cells.map(row => row.map(read => read())); return field === 'columns' ? result[0] : result; };
        } else {
          const input = addField(labels[field] || field, field === 'items' ? block.payload.items.join('\n') : block.payload[field]);
          readers[field] = () => field === 'items' ? input.value.split('\n') : input.value;
        }
      }
      if (semanticImpact(session.record.entity, block)) panel.append(create('p', { class: 'editing-warning' }, '修改将保留；关联探索结果标记为“需核对”，直到语义配置重新同步。'));
      if(controller.entry('review',uid).value?.status==='mastered') {
        const label=create('label',{class:'editing-material-change'}),check=create('input',{type:'checkbox','aria-label':'这次编辑改变了重要结论或方法'});
        check.checked=Boolean(session.materialChange);label.append(check,create('span',{},'这次编辑改变了重要结论或方法'));
        on(check,'change',()=>{session.materialChange=check.checked;dirtyDraft();});panel.append(label);
      }
      editor.read = () => Object.fromEntries(Object.entries(readers).map(([key, read]) => [key, read()]));
      editorActions(); panel.querySelector('math-field,textarea,input')?.focus();
      if (restored) { editor.dirty = true; say('已恢复草稿，沿用原 CAS 基线；保存时若目标已变化会明确报冲突'); }
      else say('编辑草稿，保存后形成一次可撤回修改');
    }
    async function openNote(base, restored) {
      if (restored) base = restored.base;
      const target = restored?.target || selection || { objectId: unitId(host), blockId: null };
      const record = restored ? clone(restored.record) : base ? null : clone(await host.getEntity(target.objectId));
      const noteId = restored?.noteId || base?.key || id('NOTE');
      if (!base && !record) throw fail('invalid_content', '笔记草稿缺少原始锚点基线。');
      await prepareEditor({ type: 'note', key: noteId, title: base ? '编辑笔记' : target.blockId ? '片段笔记' : '单元笔记',
        target: clone(target), record, base: base ? clone(base) : null });
      const input = addField('个人笔记', restored?.value ?? base?.value.text ?? '');
      const quote = base?.value.anchor?.originalText || target.selector?.exact;
      if (quote) panel.append(create('blockquote', {}, quote));
      editor.read = () => input.value; editorActions(); input.focus();
      panel.append(create('p', { class: 'editing-target' }, `关联位置：${base?.value.anchor?.objectId || target.objectId} / ${base?.value.anchor?.blockId || target.blockId || '单元整体'}`));
      if (restored) { editor.dirty = true; say('已恢复笔记草稿，原引用与修订保留，请保存'); }
      else say('笔记输入后自动保存，连续输入合并为一组');
    }
    async function saveEditor() {
      clearTimeout(noteTimer);
      const current = editor;
      if (!current || current.saving || (!current.dirty && !controller.pending.has(current.key))) return;
      const value = clone(current.read()); current.saving = true;
      // Leave fields editable while saving. Later keystrokes remain a new draft after acknowledgement.
      try {
        let committedValue = value;
        if (current.type === 'block') committedValue = (await controller.saveBlock(current.session, value)).committedValue;
        else if (current.type === 'note') {
          if (current.base) committedValue = (await controller.saveNote(current.base, value)).committedValue;
          else committedValue = (await controller.createNote(current.record, current.target.blockId, value, current.target.selector, current.key)).text;
        } else await current.save(clone(value));
        if (editor !== current) return;
        const later = JSON.stringify(current.read()) !== JSON.stringify(committedValue);
        current.dirty = later;
        if (current.type === 'note') {
          const nextBase = clone(controller.entry('notes', current.key));
          if (nextBase.value?.text !== committedValue) {
            current.dirty = true;
            throw fail('revision_conflict', '笔记保存后又被修改，保留当前输入，请核对最新笔记。');
          }
          current.base = nextBase;
        }
        if (current.type === 'block') {
          const nextSession = await controller.openBlock(current.session.entityId, current.session.blockId);
          if (Object.entries(committedValue).some(([key, value]) => JSON.stringify(nextSession.block.payload[key]) !== JSON.stringify(value))) {
            current.dirty = true;
            throw fail('revision_conflict', '保存后同一块又被修改，保留当前输入，请核对最新正文。');
          }
          current.session = nextSession;
        }
        if (current.type === 'object') {
          const base = clone(controller.entry('layout', `VE-${current.target.objectId}`));
          if (Object.entries(value).some(([key, item]) => base.value?.[key] !== item)) {
            current.dirty = true; throw fail('revision_conflict', '单元布局保存后又被修改，请核对最新位置。');
          }
          current.base = base;
        }
        controller.draft(current.key, later ? draftSnapshot(current) : null);
        if (later && current.type === 'note') noteTimer = setTimeout(() => perform(saveEditor), 900);
        say(later ? '前一组已保存，后来输入仍待保存' : '已保存到课程');
      } finally { current.saving = false; }
    }
    async function openRelation() {
      await prepareEditor({ type: 'relation', key: 'relation', title: '建立正式知识关系', target: {} });
      panel.append(create('p', {}, '手画箭头仅为个人标注。这里提交会改变知识关系与前置查询。'));
      const from = addField('起点单元 ID', unitId(host), panel, false), to = addField('终点单元 ID', '', panel, false);
      const type = create('select', { 'aria-label': '关系类型' });
      for (const [key, label] of [['', '选择关系类型'], ['requires', '学习前置'], ['constructs', '构造'], ['improves', '优化'], ['inverse', '互逆']])
        type.append(create('option', { value: key }, label));
      const direction = create('select', { 'aria-label': '关系方向' });
      for (const [key, label] of [['', '选择方向'], ['forward', '起点 → 终点'], ['reverse', '终点 → 起点'], ['both', '双向']])
        direction.append(create('option', { value: key }, label));
      panel.append(type, direction); on(type, 'change', dirtyDraft); on(direction, 'change', dirtyDraft);
      const value = addField('这条关系增加的复习价值', ''), group = addField('已有 AND/OR 路线组 ID（可留空）', '', panel, false);
      const route = addField('路线说明（可留空）', '', panel, false), refs = create('div', { class: 'editing-source-options' }); panel.append(refs);
      let bases = null, sourceChoices = [], loadedIds = null;
      button('读取端点与可选来源', () => perform(async () => {
        const ids = [from.value.trim(), to.value.trim()];
        bases = await Promise.all(ids.map(uid => host.getEntity(uid))); loadedIds = ids;
        sourceChoices = []; refs.replaceChildren();
        const all = bases.flatMap(r => r.entity.sourceRefs || []), unique = new Map(all.map(ref => [JSON.stringify(ref), ref]));
        for (const ref of unique.values()) {
          const label = create('label'), check = create('input', { type: 'checkbox', 'aria-label': `选择来源 ${ref.sourceId}` });
          const location=ref.pdfPages?.length?'PDF '+ref.pdfPages.join('、')+' 页':ref.page??ref.section??ref.locator??'原引用';
          label.append(check, create('span', {}, `${ref.sourceId} · ${location}${ref.note?' · '+ref.note:''}`)); refs.append(label);
          on(check, 'change', dirtyDraft); sourceChoices.push({ ref, check });
        }
        if (!sourceChoices.length) refs.append(create('p', {}, '端点没有可选来源，不能建立正式关系。'));
      }), panel);
      editor.read = () => ({ fromUnitId: from.value.trim(), toUnitId: to.value.trim(), type: type.value,
        direction: direction.value, value: value.value, requirementGroupId: group.value.trim(), route: route.value,
        sourceRefs: sourceChoices.filter(x => x.check.checked).map(x => clone(x.ref)), view: 'auxiliary' });
      editor.save = async data => {
        if (!data.direction || !bases || JSON.stringify(loadedIds) !== JSON.stringify([data.fromUnitId, data.toUnitId]))
          throw fail('invalid_content', '请先读取当前端点与来源，并明确选择方向。');
        if (!data.requirementGroupId) delete data.requirementGroupId;
        if (!data.route) delete data.route;
        const reverse = data.direction === 'reverse'; data.directed = data.direction !== 'both'; delete data.direction;
        if (reverse) [data.fromUnitId, data.toUnitId] = [data.toUnitId, data.fromUnitId];
        return controller.createRelation(data, reverse ? [...bases].reverse() : bases);
      };
      editorActions(); say('正式关系需明确类型、方向、价值与来源；保存时服务再次校验');
    }
    const svg = (tag, attrs = {}) => {
      const el = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      return el;
    };
    function renderShape(drawing, box, chosen = false) {
      const group = svg('g', { 'data-drawing-id': drawing.drawingId,
        transform: `translate(${box.x} ${box.y})`, class: 'editing-drawing' });
      const w = box.width, h = box.height;
      const attrs = { fill: 'none', stroke: drawing.color || '#345d88', 'stroke-width': 2.5,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
      let shape;
      const startX = box.flipX ? w : 0, endX = box.flipX ? 0 : w;
      const startY = box.flipY ? h : 0, endY = box.flipY ? 0 : h;
      if (drawing.tool === 'rectangle') shape = svg('rect', { x: 0, y: 0, width: w, height: h, rx: 3, ...attrs });
      else if (drawing.tool === 'ellipse') shape = svg('ellipse', { cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2, ...attrs });
      else if (drawing.tool === 'highlight') shape = svg('rect', { x: 0, y: 0, width: w, height: h,
        fill: '#f5d85b', opacity: .26, stroke: 'none', class: 'editing-highlight' });
      else {
        let path = `M${startX} ${startY}L${endX} ${endY}`;
        if (drawing.tool === 'wave') {
          const count = Math.max(2, Math.ceil(w / 18)); path = `M0 ${h / 2}`;
          for (let i = 0; i < count; i++) path += `Q${(i + .5) * w / count} ${i % 2 ? h : 0} ${(i + 1) * w / count} ${h / 2}`;
        }
        shape = svg('path', { d: path, ...attrs });
        if (drawing.tool === 'arrow') {
          const angle = Math.atan2(endY - startY, endX - startX), size = Math.min(15, Math.max(7, w / 5));
          const x1 = endX - Math.cos(angle - .5) * size, y1 = endY - Math.sin(angle - .5) * size;
          const x2 = endX - Math.cos(angle + .5) * size, y2 = endY - Math.sin(angle + .5) * size;
          group.append(svg('path', { d: `M${x1} ${y1}L${endX} ${endY}L${x2} ${y2}`, ...attrs }));
        }
      }
      group.append(shape);
      // Dedicated object mode keeps highlighted text selectable in the ordinary editing mode.
      if (active && tool === 'move') {
        group.append(svg('rect', { x: -5, y: -5, width: w + 10, height: h + 10, fill: 'transparent',
          stroke: chosen ? '#6965db' : 'transparent', 'stroke-dasharray': '4 4', 'data-drawing-hit': '', 'pointer-events': 'all' }));
        group.append(svg('rect', { x: w - 7, y: h - 7, width: 14, height: 14, fill: '#fff', stroke: '#6965db',
          'data-drawing-resize': '', 'pointer-events': 'all' }));
      }
      return group;
    }
    function anchorOffset(unit, anchor) {
      const target = blockElement(unit, anchor.blockId);
      if (!visible(target)) return null;
      return localPoint(unit, target.getBoundingClientRect().left, target.getBoundingClientRect().top);
    }
    function paintOverlays() {
      for (const unit of panels()) {
        let overlay = overlays.get(unit);
        if (!overlay?.isConnected) {
          overlay = svg('svg', { 'data-annotation-overlay': '', class: 'editing-overlay', 'aria-label': '个人图形标注', preserveAspectRatio: 'none' });
          // Structural safety must hold even before editing.css loads or under broad host SVG rules.
          Object.assign(overlay.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
            margin: '0', padding: '0', display: 'block', pointerEvents: 'none', overflow: 'hidden', contain: 'strict' });
          unit.append(overlay); overlays.set(unit, overlay);
        }
        overlay.setAttribute('viewBox', `0 0 ${unit.offsetWidth} ${unit.offsetHeight}`); overlay.replaceChildren();
        for (const row of controller.entries('annotations')) {
          const value = row.value, anchor = value.anchor;
          if (!anchor || anchor.objectId !== unit.dataset.unit || !records.has(anchor.objectId) ||
            anchorState(anchor, records.get(anchor.objectId)).status === 'orphan') continue;
          const layout = controller.entry('layout', row.key).value;
          if (!layout) continue;
          const offset = anchorOffset(unit, anchor); if (!offset) continue;
          const box = gesture?.key === row.key ? gesture.box : layout;
          const g = renderShape(value, { ...box, x: box.x + offset.x, y: box.y + offset.y });
          overlay.append(g);
        }
        if (gesture?.unit === unit && gesture.type === 'draw') {
          const offset = anchorOffset(unit, gesture.anchor); if (offset)
            overlay.append(renderShape({ drawingId: gesture.key, tool: gesture.tool, color: color.value },
              { ...gesture.box, x: gesture.box.x + offset.x, y: gesture.box.y + offset.y }));
        }
      }
    }
    function hitBlock(target, unit) {
      const record = records.get(unit.dataset.unit), ids = new Set(flatten(record?.entity.reading?.blocks).map(b => b.id));
      let el = target;
      while (el && el !== unit) {
        const bid = el.dataset?.blockId || el.id;
        if (ids.has(bid)) return { id: bid, element: el };
        el = el.parentElement;
      }
      return { id: null, element: unit };
    }
    function ownsGesture(event) {
      if (event.target?.closest?.('[data-editing-ui],math-field,[contenteditable="true"]')) return true;
      if (!active || space || event.button === 1 || event.ctrlKey || event.metaKey) return false;
      return !!event.target?.closest?.('.unit[data-unit],.unit-panel[data-unit]');
    }
    function cancelGesture() {
      if (!gesture) return;
      const current = gesture; gesture = null;
      if (current.type.startsWith('object-')) restoreObjectStyle(current);
      if (current.unit.hasPointerCapture?.(current.pointerId)) current.unit.releasePointerCapture(current.pointerId);
      paintOverlays();
    }
    const objectBox = unit => ({ x: unit.offsetLeft, y: unit.offsetTop, width: unit.offsetWidth, height: unit.offsetHeight });
    function restoreObjectStyle(current) {
      for (const [key, value] of Object.entries(current.originalStyle)) current.unit.style[key] = value;
    }
    on(doc, 'pointerdown', event => {
      const handle = event.target.closest('[data-unit-transform]');
      if (!active || !handle || event.button !== 0 || space || gesture) return;
      const unit = handle.closest('.unit[data-unit],.unit-panel[data-unit]');
      if (!unit) return;
      event.preventDefault(); event.stopPropagation();
      const bounds = unit.getBoundingClientRect();
      gesture = { type: `object-${handle.dataset.unitTransform}`, unit, pointerId: event.pointerId,
        key: `VE-${unit.dataset.unit}`, base: clone(controller.entry('layout', `VE-${unit.dataset.unit}`)),
        start: { x: event.clientX, y: event.clientY }, scaleX: bounds.width / unit.offsetWidth, scaleY: bounds.height / unit.offsetHeight,
        box: objectBox(unit), initialBox: objectBox(unit), moved: false,
        originalStyle: Object.fromEntries(['left', 'top', 'width', 'height', 'minHeight', 'overflow'].map(key => [key, unit.style[key]])) };
      unit.setPointerCapture(event.pointerId);
    }, { capture: true });
    on(doc, 'pointerdown', event => {
      if (!active || event.button !== 0 || event.ctrlKey || event.metaKey || space || event.target.closest('[data-editing-ui],math-field')) return;
      if (gesture) {
        if (event.pointerId !== gesture.pointerId) cancelGesture();
        return;
      }
      const unit = event.target.closest('.unit[data-unit],.unit-panel[data-unit]');
      if (!unit || event.target.closest('button,input,select,textarea,summary,a,[contenteditable="true"]')) return;
      if (tool === 'select') { event.stopPropagation(); return; } // Do not prevent the native text selection.
      const drawing = event.target.closest('[data-drawing-id]');
      if (tool === 'move' && !drawing) { event.stopPropagation(); return; }
      const record = records.get(unit.dataset.unit);
      if (!record) { say('正在读取此单元，请稍后绘制'); return; }
      const block = drawing ? { id: controller.entry('annotations', drawing.dataset.drawingId).value.anchor.blockId } : hitBlock(event.target, unit);
      const anchor = drawing ? controller.entry('annotations', drawing.dataset.drawingId).value.anchor : makeAnchor(record, block.id);
      const target = blockElement(unit, anchor.blockId); if (!visible(target)) return;
      event.preventDefault(); event.stopPropagation();
      const start = localPoint(target, event.clientX, event.clientY);
      const base = drawing ? clone(controller.entry('layout', drawing.dataset.drawingId)) : null;
      if (drawing && !base.value) return;
      gesture = { type: drawing ? event.target.hasAttribute('data-drawing-resize') ? 'resize' : 'move' : 'draw',
        unit, target, anchor, record: clone(record), blockId: block.id, tool, start, base,
        key: drawing?.dataset.drawingId || id('DRAW'), pointerId: event.pointerId,
        box: base ? clone(base.value) : boxBetween(start, start), moved: false };
      unit.setPointerCapture(event.pointerId);
    }, { capture: true });
    on(doc, 'pointermove', event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (gesture.type.startsWith('object-')) {
        const dx = (event.clientX - gesture.start.x) / gesture.scaleX, dy = (event.clientY - gesture.start.y) / gesture.scaleY;
        gesture.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
        gesture.box = { ...gesture.initialBox, ...(gesture.type === 'object-resize' ?
          { width: Math.max(280, gesture.initialBox.width + dx), height: Math.max(160, gesture.initialBox.height + dy) } :
          { x: gesture.initialBox.x + dx, y: gesture.initialBox.y + dy }) };
        const box = gesture.box;
        if (gesture.type === 'object-resize') {
          Object.assign(gesture.unit.style, { width: `${box.width}px`, height: `${box.height}px`, minHeight: '0', overflow: 'auto' });
        } else Object.assign(gesture.unit.style, { left: `${box.x}px`, top: `${box.y}px` });
        paintOverlays(); return;
      }
      const point = localPoint(gesture.target, event.clientX, event.clientY), dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
      gesture.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
      if (gesture.type === 'draw') gesture.box = boxBetween(gesture.start, point);
      else {
        const base = gesture.base.value;
        gesture.box = { ...clone(base), ...(gesture.type === 'resize' ?
          { width: Math.max(2, base.width + dx), height: Math.max(2, base.height + dy) } : { x: base.x + dx, y: base.y + dy }) };
      }
      paintOverlays();
    }, { capture: true });
    on(doc, 'pointerup', event => {
      if (gesture?.pointerId === event.pointerId) {
        const current = gesture; gesture = null;
        if (current.unit.hasPointerCapture?.(current.pointerId)) current.unit.releasePointerCapture(current.pointerId);
        event.preventDefault(); event.stopPropagation();
        if (current.type.startsWith('object-')) {
          restoreObjectStyle(current);
          if (current.moved) perform(() => controller.transformObject(current.base, current.unit.dataset.unit, current.box));
          return;
        }
        if (current.moved) perform(() => current.type === 'draw' ? controller.createDrawing(current.record, current.blockId,
          current.tool, current.box, color.value, current.key) : controller.transformDrawing(current.base, current.box));
        else paintOverlays();
        return;
      }
      if (!active || tool !== 'select' || event.target.closest('[data-editing-ui]')) return;
      const unit = event.target.closest('.unit[data-unit],.unit-panel[data-unit]'); if (!unit) return;
      const block = hitBlock(event.target, unit);
      const native = win.getSelection(), exact = native?.toString();
      selection = { objectId: unit.dataset.unit, blockId: block.id };
      if (!exact || !block.id || !native.rangeCount) return;
      const range = native.getRangeAt(0);
      if (!block.element.contains(range.startContainer) || !block.element.contains(range.endContainer)) {
        say('跨块选段请分开添加笔记。', true); selection = null; return;
      }
      const raw = textOf(findBlock(records.get(unit.dataset.unit)?.entity, block.id)), start = raw.indexOf(exact);
      if (start < 0) { say('选段无法可靠定位，请改为对象笔记。', true); selection.blockId = null; return; }
      if (raw.indexOf(exact, start + 1) !== -1) { say('选中文字重复，无法唯一定位，请扩大选段。', true); selection = null; return; }
      selection.selector = { exact, start, end: start + exact.length, prefix: raw.slice(Math.max(0, start - 24), start),
        suffix: raw.slice(start + exact.length, start + exact.length + 24) };
      say(`已选择片段：${exact.slice(0, 45)}`);
    }, { capture: true });
    on(doc, 'pointercancel', cancelGesture, { capture: true });
    on(doc, 'lostpointercapture', event => { if (gesture?.pointerId === event.pointerId) cancelGesture(); }, { capture: true });
    on(win, 'blur', () => { space = false; cancelGesture(); });
    on(doc, 'keydown', event => {
      if (event.code === 'Space' && !event.target.closest('[data-editing-ui],input,textarea,math-field,[contenteditable="true"]')) space = true;
      if (event.key === 'Escape') cancelGesture();
      if (!active || !(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase()) ||
        event.target.closest('input,textarea,math-field,[contenteditable="true"]')) return;
      event.preventDefault(); event.stopPropagation();
      perform(() => (event.shiftKey || event.key.toLowerCase() === 'y') ? controller.redo() : controller.undo());
    }, { capture: true });
    on(doc, 'keyup', event => { if (event.code === 'Space') space = false; }, { capture: true });
    on(panel, 'focusout', () => { if (editor?.type === 'note' && editor.dirty) { clearTimeout(noteTimer); noteTimer = setTimeout(() => perform(saveEditor), 200); } });
    on(doc, 'toggle', () => paintOverlays(), { capture: true });
    function addEntrances() {
      for (const unit of panels()) {
        unit.classList.toggle('review-editing-active', active);
        const record = records.get(unit.dataset.unit); if (!record) continue;
        if (![...unit.children].some(el => el.classList?.contains('editing-unit-controls'))) {
          const controls = create('div', { class: 'editing-unit-controls', 'data-editing-ui': '' });
          const move = button('拖动单元', () => {}, controls), resize = button('调整单元尺寸', () => {}, controls);
          move.dataset.unitTransform = 'move'; resize.dataset.unitTransform = 'resize';
          button('单元位置 / 尺寸', () => perform(() => openObject(unit)), controls); unit.prepend(controls);
        }
        for (const block of flatten(record.entity.reading?.blocks)) {
          const element = blockElement(unit, block.id); if (!element) continue;
          if (fieldsFor(block).length && ![...element.children].some(el => el.dataset?.editBlock === block.id)) {
            const entry = button(block.kind === 'formula' ? '编辑公式' : '编辑文字 / 内容', () => perform(() => openBlock(unit.dataset.unit, block.id)));
            entry.className = 'editing-block-entry'; entry.dataset.editBlock = block.id; entry.dataset.editingUi = '';
            if (element.tagName === 'DETAILS') element.append(entry); else element.prepend(entry);
          }
          if (block.payload?.semanticStatus?.status === 'needs-review' || block.semanticStatus?.status === 'needs-review') {
            if (!element.querySelector(':scope > .editing-semantic-warning'))
              element.prepend(create('p', { class: 'editing-semantic-warning', role: 'status' }, '探索结果需核对：正文与组件配置尚未同步'));
            element.classList.add('editing-semantic-stale');
          } else {
            element.classList.remove('editing-semantic-stale'); element.querySelector(':scope > .editing-semantic-warning')?.remove();
          }
        }
      }
    }
    async function openObject(unit, restored) {
      const uid = unit.dataset.unit, base = restored?.base ? clone(restored.base) : clone(controller.entry('layout', `VE-${uid}`));
      await prepareEditor({ type: 'object', key: `object:${uid}`, title: `单元位置与尺寸 · ${uid}`, target: { objectId: uid } });
      editor.base = base;
      const box = restored?.value || objectBox(unit), inputs = {};
      for (const [key, label] of [['x', '横向位置'], ['y', '纵向位置'], ['width', '宽度'], ['height', '高度']]) {
        const input = addField(label, Math.round(box[key]), panel, false); input.type = 'number'; inputs[key] = input;
      }
      panel.append(create('p', {}, '位置是所属主题内的坐标。尺寸变化与正文语义分开保存，整次操作可撤回。'));
      editor.read = () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, Number(input.value)]));
      const current = editor;
      editor.save = data => controller.transformObject(current.base, uid, data);
      editorActions();
      if (restored) { editor.dirty = true; say('已恢复单元布局草稿，保留原修订基线'); }
    }
    function renderLibrary() {
      if (!libraryOpen) return;
      // Preserve typed reassociation targets across refresh notifications.
      if (library.contains(doc.activeElement)) return;
      library.replaceChildren(create('h2', {}, '个人笔记与标注'));
      for (const draft of recoveredDrafts.filter(row => !row.key.startsWith('pending:') && row.key !== editor?.key)) {
        const item = create('article', { class: 'editing-library-item editing-anchor-orphan' });
        item.append(create('h3', {}, '可恢复的编辑草稿'), create('p', {}, `${draft.value.type || '编辑'} · ${draft.key}`));
        item.append(create('pre', { class: 'editing-pending-payload' }, typeof draft.value.value === 'string' ? draft.value.value : JSON.stringify(draft.value.value || draft.value.patch, null, 2)));
        button('恢复这份草稿', () => perform(async () => {
          const value = draft.value;
          if (value.type === 'block' && value.session) return openBlock(value.target.objectId, value.target.blockId, value);
          if (value.type === 'note') return openNote(null, value);
          if (value.type === 'object' && value.base) {
            const unit = panelFor(value.target.objectId);
            if (!unit) throw fail('not_found', '原单元当前不可见，草稿继续保留。');
            return openObject(unit, value);
          }
          throw fail('invalid_content', '此草稿缺少可安全恢复的原始基线，请复制内容后重新编辑。');
        }), item);
        button('复制已保存草稿', () => perform(() => win.navigator.clipboard.writeText(JSON.stringify(draft.value, null, 2))), item);
        button('清除此草稿', () => { controller.draft(draft.key, null); refresh(); }, item);
        library.append(item);
      }
      for (const [key, pending] of controller.pending) {
        const item = create('article', { class: 'editing-library-item editing-anchor-orphan' });
        item.append(create('h3', {}, '未确认保存的操作'), create('p', {}, `${pending.payload.kind} · ${key}`));
        item.append(create('pre', { class: 'editing-pending-payload' }, JSON.stringify(pending.payload, null, 2)));
        button('重试原操作', () => perform(async () => {
          if (editor?.key === key) return saveEditor();
          return controller.retry(key);
        }), item);
        library.append(item);
      }
      const rows = [...controller.entries('notes').map(row => ({ ...row, namespace: 'notes' })),
        ...controller.entries('annotations').map(row => ({ ...row, namespace: 'annotations' }))];
      if (!rows.length) library.append(create('p', {}, '尚无笔记或图形标注。'));
      rows.sort((a, b) => {
        const state = x => anchorState(x.value.anchor || {}, records.get(x.value.anchor?.objectId)).status === 'orphan';
        return Number(state(b)) - Number(state(a));
      });
      for (const row of rows) {
        const anchor = row.value.anchor || {}, state = records.has(anchor.objectId) ? anchorState(anchor, records.get(anchor.objectId)) :
          { status: 'unknown', reason: '原对象暂无法读取，个人内容与原引用保留' };
        const item = create('article', { class: `editing-library-item editing-anchor-${state.status}` });
        item.append(create('h3', {}, `${row.namespace === 'notes' ? '笔记' : row.value.tool} · ${anchor.objectId || '无目标'}`));
        if (row.value.text) item.append(create('p', {}, row.value.text));
        item.append(create('p', { class: 'editing-anchor-state' }, state.status === 'orphan' ? `待重新关联：${state.reason}` : state.reason || '已关联'));
        item.append(create('blockquote', {}, anchor.originalAnchor?.originalText || anchor.originalText || '对象笔记'));
        item.append(create('small', {}, `原修订 ${anchor.originalAnchor?.revision ?? anchor.revision ?? '未知'} · ${(anchor.originalAnchor?.sourceRefs || anchor.sourceRefs || []).map(ref => ref.sourceId).join('、')}`));
        if (row.namespace === 'notes') button('编辑笔记', () => perform(() => openNote(row)), item);
        const uid = addField('重新关联到单元 ID', unitId(host) || '', item, false);
        const bid = addField('目标块 ID（空为对象笔记）', '', item, false);
        button('重新关联并保留原语境', () => perform(async () => {
          const record = await host.getEntity(uid.value.trim());
          return controller.reanchor(row.namespace, row, record, bid.value.trim() || null);
        }), item);
        library.append(item);
      }
    }
    let refreshing = null, needsRefresh = false;
    async function refresh() {
      if (destroyed) return;
      if (refreshing) { needsRefresh = true; return refreshing; }
      refreshing = (async () => {
        const version = ++refreshVersion;
        if (host.recoverDrafts) {
          recoveredDrafts = clone(await host.recoverDrafts());
          for (const row of recoveredDrafts) if (row.key.startsWith('pending:')) {
            try { controller.restorePending(row.key.slice('pending:'.length), row.value); }
            catch (error) { say(`草稿恢复失败：${error.message}`, true); }
          }
        }
        const ids = new Set(panels().map(el => el.dataset.unit));
        for (const ns of ['notes', 'annotations']) for (const row of controller.entries(ns))
          if (row.value.anchor?.objectId) ids.add(row.value.anchor.objectId);
        const fetched = await Promise.allSettled([...ids].map(async uid => {
          try { return [uid, clone(await host.getEntity(uid))]; }
          catch (error) { if (error.code === 'not_found') return [uid, null]; throw error; }
        }));
        if (destroyed || version !== refreshVersion) return;
        for (const result of fetched) {
          if (result.status === 'fulfilled') records.set(...result.value);
          else say(`部分锚点状态暂无法核对：${result.reason.message || result.reason}`, true);
        }
        addEntrances(); observePanels(); paintOverlays(); syncPanelVisibility(); renderLibrary();
      })();
      try { await refreshing; } finally {
        refreshing = null;
        if (needsRefresh) { needsRefresh = false; if (!destroyed) return refresh(); }
      }
    }
    const stopRefresh = host.onRefresh(() => { refresh().catch(error => say(error.message, true)); });
    const resize = new win.ResizeObserver(() => paintOverlays());
    const observePanels = () => { resize.disconnect(); for (const unit of panels()) resize.observe(unit); };
    observePanels();
    on(win, 'resize', () => paintOverlays());
    on(win, 'beforeunload', event => {
      if (editor?.dirty || editor?.saving || controller.pending.size || inflight.size) { event.preventDefault(); event.returnValue = ''; }
    });
    refresh().catch(error => say(error.message, true));
    return {
      controller, refresh, ownsGesture,
      async flush() {
        if (editor?.dirty) await saveEditor();
        await Promise.all([...inflight]);
        if (editor?.dirty || controller.pending.size) throw fail('unsaved_draft', '仍有未保存的编辑或冲突。');
        return true;
      },
      destroy() {
        if (editor?.dirty || editor?.saving || controller.pending.size || inflight.size)
          throw fail('unsaved_draft', '请先保存或保留未确认的编辑。');
        destroyed = true; ++refreshVersion; clearTimeout(noteTimer); cancelGesture(); abort.abort(); resize.disconnect(); stopRefresh?.();
        for (const overlay of overlays.values()) overlay.remove();
        for (const el of doc.querySelectorAll('.editing-block-entry,.editing-semantic-warning,.editing-unit-controls')) el.remove();
        for (const unit of panels()) unit.classList.remove('review-editing-active', 'editing-semantic-stale');
        delete doc.body.dataset.editing; win.mathVirtualKeyboard?.hide(); ui.remove();
      },
    };
  }
  return { mount, Controller, logic: { fieldsFor, editBlock, replaceInEntity, makeAnchor, anchorState,
    relocate, localPoint, boxBetween, validBox, findBlock, flatten, semanticImpact } };
});
