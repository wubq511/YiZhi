#!/usr/bin/env node
/** Controlled protocol peer. Real CLI inference has separate opt-in Electron acceptance. */
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), mode = process.env.YIZHI_DESCRIPTION_FIXTURE;
if (args.includes('--version')) { console.log('codex-cli 0.163.0-fixture'); process.exit(0); }
if (args.includes('generate-json-schema')) {
  const root = args[args.indexOf('--out') + 1]; mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'codex_app_server_protocol.schemas.json'), JSON.stringify({ methods: ['thread/start', 'turn/start', 'model/list', 'config/read', 'item/tool/call', 'item/agentMessage/delta', 'turn/completed'], definitions: { v2: { DynamicToolSpec: { oneOf: [{ properties: { type: { enum: ['function'] } }, required: ['name', 'description', 'inputSchema', 'type'] }] } } } })); process.exit(0);
}
const send = (value: any) => process.stdout.write(JSON.stringify(value) + '\n');
let next = 100, active: any;
const pending = new Map<number, (value: any) => void>();
const call = (tool: string, arguments_: any, extra = {}) => new Promise<any>(resolve => {
  const id = ++next; pending.set(id, resolve); send({ id, method: 'item/tool/call', params: { ...active, callId: `call-${id}`, tool, arguments: arguments_, ...extra } });
});
createInterface({ input: process.stdin }).on('line', line => { void receive(JSON.parse(line)); });
async function receive(m: any) {
  if (!m.method) { pending.get(m.id)?.(m.result ?? { error: m.error }); pending.delete(m.id); return; }
  const respond = (result: any) => send({ id: m.id, result });
  if (m.method === 'initialize') respond({ userAgent: 'description-fixture' });
  if (m.method === 'config/read') respond({ config: { mcp_servers: { fixture: {} } } });
  if(m.method==='model/list'&&mode==='catalog-linger'){writeFileSync(process.env.YIZHI_CATALOG_MARKER!,'actual catalog child reached model/list');await new Promise(r=>setTimeout(r,300));}
  if (m.method === 'model/list') respond({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Description fixture', isDefault: true }] });
  if (m.method === 'thread/start') {
    const p = m.params;
    if (p.ephemeral !== true || p.sandbox !== 'read-only' || p.approvalPolicy !== 'never' || p.config['mcp_servers.fixture.enabled'] !== false ||
        !p.dynamicTools.every((t: any) => t.type === 'function' && ['yizhi_search', 'yizhi_select_search_hits'].includes(t.name)) || readdirSync(process.cwd()).length)
      return send({ id: m.id, error: { code: -32602, message: 'description isolation missing' } });
    respond({ thread: { id: 'description-thread' } });
  }
  if (m.method === 'turn/interrupt') { respond({}); return; }
  if (m.method === 'turn/start') {
    active = { threadId: m.params.threadId, turnId: 'description-turn' }; respond({ turn: { id: active.turnId } });
    send({ method: 'turn/started', params: { threadId: active.threadId, turn: { id: active.turnId } } });
    const result = await call('yizhi_search', { query: mode === 'no-hit' ? '不存在的索引词' : mode === 'paragraph' ? '位置记数法' : '位权' });
    const data = JSON.parse(result.contentItems[0].text);
    if (mode === 'disconnect') process.exit(17);
    if (mode === 'malformed') { process.stdout.write('invalid-json\n'); return; }
    if (mode === 'linger' || mode === 'stale') { setTimeout(() => void complete(data), mode === 'stale' ? 400 : 4000); return; }
    await complete(data);
  }
}
async function complete(data: any) {
  const ids = data.hits.map((h: any) => h.hitId);
  if (mode === 'invented') {
    await call('yizhi_select_search_hits', { hitIds: ['invented-hit-id'] });
    await call('yizhi_select_search_hits', { hitIds: ids.slice(0, 1), quote: '伪造摘录' });
    await call('yizhi_read_target', {});
    await call('shell', { command: 'forbidden' });
  } else await call('yizhi_select_search_hits', { hitIds: ids.slice(0, 2).reverse() });
  send({ method: 'item/completed', params: { ...active, item: { type: 'agentMessage', id: 'ignored-prose', text: '模型新解释，不是课程原文；伪造 quote。' } } });
  send({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: mode === 'failed' ? 'failed' : 'completed', error: mode === 'failed' ? { message: 'description provider unavailable' } : null } } });
}
