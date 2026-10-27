'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const plan = require('./plan.cjs');
function canonical(x) {
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  if (x !== null && typeof x === 'object') return '{' + Object.keys(x).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
const hash = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : canonical(x)).digest('hex');
const walk = xs => xs.flatMap(b => [b, ...walk(b.children || [])]);
function remap(x, mapping) {
  if (Array.isArray(x)) return x.map(v => remap(v, mapping));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k,v]) => [k, remap(v,mapping)]));
  return typeof x === 'string' ? mapping.get(x) || x : x;
}
function buildFixture(fixture) {
  assert.equal(fixture.units.length, 84);
  const units = [];
  for (let batch = 0; units.length < plan.units; batch++) {
    const present = fixture.units.slice(0, Math.min(84, plan.units - units.length));
    const ids = present.flatMap(u => [u.id, ...walk(u.reading.blocks).map(b => b.id), ...(u.relations || []).map(r => r.id)]);
    const mapping = new Map(batch ? ids.map(id => [id, `${id}~copy${batch}`]) : []);
    units.push(...present.map(u => remap(u, mapping)));
  }
  const unitIds = new Set(units.map(u => u.id));
  assert.equal(unitIds.size, 500);
  for (const u of units) for (const r of u.relations || []) {
    assert(unitIds.has(r.fromUnitId) && unitIds.has(r.toUnitId), 'dangling replicated relation');
  }
  const objects = new Map(), targets = [];
  for (const u of units) {
    const unit = structuredClone(u);
    unit.reading.blocks = u.reading.blocks.map(b => b.id);
    objects.set(`${u.id}/unit`, canonical(unit));
    for (const b of walk(u.reading.blocks)) {
      const block = structuredClone(b);
      if (block.children) block.children = block.children.map(v => v.id);
      const key = `${u.id}/block/${b.id}`;
      assert(!objects.has(key));
      objects.set(key, canonical(block));
    }
    const target = walk(u.reading.blocks).find(b => b.kind === 'paragraph' && typeof b.payload?.text === 'string');
    if (target) targets.push(`${u.id}/block/${target.id}`);
  }
  assert(targets.length >= 32);
  // Round trip all original 84 trees, including ordered nested children and metadata.
  for (const u of units.slice(0, 84)) {
    const rebuilt = JSON.parse(objects.get(`${u.id}/unit`));
    const block = id => {
      const b = JSON.parse(objects.get(`${u.id}/block/${id}`));
      if (b.children) b.children = b.children.map(block);
      return b;
    };
    rebuilt.reading.blocks = rebuilt.reading.blocks.map(block);
    assert.deepEqual(rebuilt, u);
  }
  return { objects, targets, unitCount: units.length, objectCount: objects.size };
}
function makeWorkload(seed) {
  const state = new Map([...seed.objects].map(([k,v]) => [k,{value:v,revision:0}]));
  const commands = [];
  let offset = 0;
  for (let i = 0; i < plan.steps; i++) {
    const edits = [0,1].map(j => {
      const key = seed.targets[(i * 2 + j) % 32], old = state.get(key);
      const after = JSON.parse(old.value);
      after.payload.text += `\n[core-placement synthetic edit ${i}:${j}]`;
      const edit = {key, expectedRevision: old.revision, after};
      state.set(key, {value:canonical(after),revision:old.revision + 1});
      return edit;
    });
    commands.push({id:`group-${i}`,kind:'group',edits});
    commands.push({id:`draft-${i}`,kind:'draft',key:seed.targets[i % 8],
      inputSeq:Math.floor(i / 8) + 1, text:`synthetic latest draft ${i}: \\frac{x}{`});
    const text = (`合成消息 ${i}，不含个人对话。\n`).repeat(32);
    commands.push({id:`message-${i}`,kind:'message',conversation:'synthetic',offset,text});
    offset += Buffer.byteLength(text);
  }
  assert.equal(commands.length, plan.operations);
  return commands;
}
function receipt(command, seq) {
  return {operation:command.id,seq,kind:command.kind,saved:true,
    changedKeys:command.kind === 'group' ? command.edits.map(e => e.key) : []};
}
// Independent in-memory oracle, never calls the SQLite adapter.
function expectedSnapshot(seed, commands) {
  const current = new Map([...seed.objects].map(([key,value]) => [key,{key,value,revision:0}]));
  const changes = [], operations = [], drafts = new Map(), messages = [];
  commands.forEach((c,i) => {
    const seq = i + 1;
    operations.push({seq,id:c.id,request_hash:hash(c),request:canonical(c),receipt:canonical(receipt(c,seq))});
    if (c.kind === 'group') for (const edit of c.edits) {
      const before = current.get(edit.key);
      assert.equal(before.revision, edit.expectedRevision);
      changes.push({operation:c.id,key:edit.key,before:before.value,after:canonical(edit.after),prior_revision:before.revision});
      current.set(edit.key,{key:edit.key,value:canonical(edit.after),revision:before.revision+1});
    }
    if (c.kind === 'draft') drafts.set(c.key,{key:c.key,input_seq:c.inputSeq,text:c.text});
    if (c.kind === 'message') messages.push({conversation:c.conversation,offset:c.offset,bytes:Buffer.byteLength(c.text),text:c.text});
  });
  const sortKey = xs => xs.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return {
    baseline:sortKey([...seed.objects].map(([key,value]) => ({key,value}))),
    current:sortKey([...current.values()]),
    operations,
    changes:changes.sort((a,b) => a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    drafts:sortKey([...drafts.values()]), messages,
  };
}
module.exports = {canonical, hash, buildFixture, makeWorkload, receipt, expectedSnapshot};
