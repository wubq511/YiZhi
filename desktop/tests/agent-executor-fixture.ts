#!/usr/bin/env node
/** Isolated protocol fixture for regression tests only; never an acceptance executor. */
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), mode = process.env.YIZHI_FIXTURE_MODE;
if (args.includes('--version')) { console.log('codex-cli 0.163.0-fixture'); process.exit(0); }
if (args.includes('generate-json-schema')) {
  const dir = args[args.indexOf('--out') + 1]; mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'codex_app_server_protocol.schemas.json'), JSON.stringify({ methods: ['thread/start', 'thread/resume', 'turn/start', 'model/list', 'config/read', 'item/tool/call', 'item/agentMessage/delta', 'turn/completed'], definitions: { v2: { DynamicToolSpec: { oneOf: mode === 'incapable' ? [] : [{ properties: { type: { enum: ['function'] } }, required: ['name', 'description', 'inputSchema', 'type'] }] } } } })); process.exit(0);
}
const lines = createInterface({ input: process.stdin });
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method: string, params: any) => send({ method, params });
let threadSeq = 0, turnSeq = 0, toolSeq = 100, snapshot: any, active: any;
const toolResults = new Map<number, (value: any) => void>();
function tool(tool: string, arguments_: unknown) {
  const id = ++toolSeq;
  return new Promise<any>(resolve => { toolResults.set(id, resolve); send({ id, method: 'item/tool/call', params: { ...active, callId: `call-${id}`, tool, arguments: arguments_ } }); });
}
lines.on('line', line => { void receive(JSON.parse(line)); });
async function receive(m: any) {
  if (!m.method) { toolResults.get(m.id)?.(m.result); toolResults.delete(m.id); return; }
  const respond = (result: any) => send({ id: m.id, result });
  if (m.method === 'initialize') respond({ userAgent: 'protocol-fixture', platformFamily: 'unix', platformOs: 'macos' });
  if (m.method === 'config/read') respond({ config: { mcp_servers: { fixture: {} } } });
  if (m.method === 'model/list') respond({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Protocol fixture', isDefault: true }], nextCursor: null });
  if (m.method === 'thread/resume') respond({ thread: { id: m.params.threadId } });
  if (m.method === 'thread/start') {
    if (m.params.ephemeral !== true || m.params.sandbox !== 'read-only' || m.params.approvalPolicy !== 'never' || !m.params.dynamicTools.every((t: any) => t.type === 'function') || m.params.config['mcp_servers.fixture.enabled'] !== false)
      return send({ id: m.id, error: { code: -32602, message: 'Readonly isolation was not configured' } });
    respond({ thread: { id: `fixture-thread-${++threadSeq}` } });
  }
  if (m.method === 'turn/start') {
    const identity = { threadId: m.params.threadId, turnId: `fixture-turn-${++turnSeq}` }; active = identity;
    snapshot = JSON.parse(m.params.input[0].text).submittedRequest;
    respond({ turn: { id: identity.turnId, status: 'inProgress' } });
    notify('turn/started', { threadId: identity.threadId, turn: { id: identity.turnId } });
    const read = await tool('yizhi_read_target', {});
    if (!read?.success) return send({ id: 999, method: 'unsupported/request', params: {} });
    if (snapshot.citations.length) await tool('yizhi_read_citation', { citationId: snapshot.citations[0].citation.id });
    if (mode === 'tool-error') {
      const bad = await tool('yizhi_read_source_page', { versionId: '../../course.sqlite', pdfPageIndex: 0 });
      if (bad?.success) throw new Error('arbitrary file read was allowed');
    }
    const partial = '课程依据：位置的权决定数值。';
    const full = partial + '\n补充解释：例如 22 的两个 2 分别表示 20 和 2。';
    notify('item/agentMessage/delta', { ...identity, itemId: 'answer', delta: partial });
    if (mode === 'disconnect') { setTimeout(() => process.exit(17), 80); return; }
    if (mode === 'malformed') { process.stdout.write('not-json\n'); return; }
    setTimeout(() => {
      notify('item/completed', { ...identity, item: { type: 'agentMessage', id: 'answer', text: full } });
      notify('item/agentMessage/delta', { ...identity, itemId: 'answer', delta: 'LATE DUPLICATE' });
      notify('item/completed', { ...identity, item: { type: 'agentMessage', id: 'answer', text: full } });
      notify('turn/completed', { threadId: identity.threadId, turn: { id: identity.turnId, status: mode === 'failed' ? 'failed' : 'completed', error: mode === 'failed' ? { message: 'provider failed precisely', codexErrorInfo: 'other' } : null } });
      notify('item/agentMessage/delta', { ...identity, itemId: 'answer', delta: 'AFTER FINISH' });
    }, mode === 'linger' ? 3000 : 800);
  }
}
