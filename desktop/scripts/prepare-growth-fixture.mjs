import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, statSync, mkdirSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const authorityNames = ['directory-authority.json', 'directory-transition.json', 'backup-complete.json', 'content-candidate.json'];
const authorityHashes = directory => Object.fromEntries(authorityNames.filter(name => existsSync(join(directory, name)))
  .map(name => [name, hash(readFileSync(join(directory, name)))]));
function originalRows(directory) {
  const db = new DatabaseSync(join(directory, 'course.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT id,payload,revision FROM units ORDER BY id').all(); } finally { db.close(); }
}
function assertPreserved(rows, directory) {
  const actual = new Map(originalRows(directory).map(row => [row.id, row]));
  for (const row of rows) if (actual.get(row.id)?.payload !== row.payload || actual.get(row.id)?.revision !== row.revision)
    throw new Error('Original payload/revision changed: ' + row.id);
}

/** Only stopped disposable inputs. Normal Core admission runs BEFORE any synthetic SQL.
 * Never manufacture/reseal a publication marker; final authority owns admission. */
export async function prepareGrowthFixture({ source: suppliedSource, target: suppliedTarget, total, workerPath }) {
  const source = realpathSync(suppliedSource), target = resolve(suppliedTarget);
  if (existsSync(target) || target.startsWith(source + '/') || source.startsWith(target + '/')) throw new Error('Use a new directory outside the source.');
  if (!Number.isSafeInteger(total) || total < 1 || total > 1000) throw new Error('Invalid fixture unit count.');
  const wal = join(source, 'course.sqlite-wal');
  if (existsSync(wal) && statSync(wal).size) throw new Error('Close/checkpoint the input course first.');
  const originals = originalRows(source), sourceHash = hash(readFileSync(join(source, 'course.sqlite'))), authority = authorityHashes(source);
  if (total < originals.length) throw new Error('Cannot remove source units.');
  const input = new DatabaseSync(join(source, 'course.sqlite'), { readOnly: true });
  let graph;
  try { graph = JSON.parse(input.prepare("SELECT value FROM metadata WHERE key='course-graph'").get()?.value ?? 'null'); }
  finally { input.close(); }
  if (!graph || graph.nodes.length !== originals.length || graph.nodes.some(node => !originals.some(row => row.id === node.id)))
    throw new Error('Supply a complete materialized course, not the partial demo fallback.');
  mkdirSync(target);
  cpSync(source, target, { recursive: true, filter: path => !['course.sqlite-wal', 'course.sqlite-shm', 'ownership.sqlite'].includes(basename(path)) });
  const { CourseService } = await import(pathToFileURL(join(dirname(workerPath), 'course-service.cjs')).href);
  let core = new CourseService(workerPath);
  try { await core.open(target); } finally { await core.close(); }
  assertPreserved(originals, target);
  const db = new DatabaseSync(join(target, 'course.sqlite'));
  const blocks = (items, ids, prefix) => { for (const block of items) {
    if (!block.id || ids.has(block.id)) throw new Error('Missing/duplicate reading identity');
    ids.set(block.id, prefix + '-' + String(ids.size).padStart(4, '0')); blocks(block.children ?? [], ids, prefix);
  } };
  const remap = (value, ids) => typeof value === 'string' ? (ids.get(value) ?? value) : Array.isArray(value) ? value.map(v => remap(v, ids)) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [ids.get(key) ?? key, remap(v, ids)])) : value;
  const bounds = graph.layout.nodes.reduce((b, n) => ({ right: Math.max(b.right, n.x + n.width), bottom: Math.max(b.bottom, n.y + n.height) }), { right: 0, bottom: 0 });
  const seedNodes = new Map(graph.nodes.map(n => [n.id, n])), seedLayouts = new Map(graph.layout.nodes.map(n => [n.unitId, n]));
  const appended = [], groups = new Set();
  try {
    db.exec('BEGIN IMMEDIATE');
    const put = db.prepare('INSERT INTO units(id,payload,revision) VALUES(?,?,1)');
    for (let i = 0; i < total - originals.length; i++) {
      const ordinal = i + 1, cycle = Math.floor(i / originals.length) + 1, seed = originals[i % originals.length], unit = JSON.parse(seed.payload);
      const id = 'KU-LOAD-' + String(ordinal).padStart(4, '0'), themeId = 'TH-LOAD-' + String(cycle).padStart(2, '0'), name = '合成增长样本 ' + cycle;
      if (seedNodes.has(id) || !groups.has(themeId) && graph.groups.some(g => g.id === themeId)) throw new Error('Synthetic namespace already exists');
      const dx = cycle * (bounds.right + 800), ids = new Map([[unit.id, id]]);
      blocks(unit.reading.blocks, ids, 'RB-LOAD-' + String(ordinal).padStart(4, '0'));
      const clone = remap(unit, ids); clone.name = '[合成负载 ' + ordinal + '] ' + unit.name;
      clone.themeId = themeId; clone.theme = { id: themeId, name }; clone.reading.revision = 1;
      put.run(id, JSON.stringify(clone));
      graph.nodes.push({ ...seedNodes.get(seed.id), id, name: clone.name, themeId, themeName: name });
      const placement = seedLayouts.get(seed.id); if (!placement) throw new Error('Seed placement missing: ' + seed.id);
      graph.layout.nodes.push({ ...placement, elementId: 'VE-N-' + id, unitId: id, x: placement.x + dx });
      if (!groups.has(themeId)) {
        groups.add(themeId); graph.groups.push({ ...graph.groups[0], id: themeId, lessonId: 'LOAD-' + cycle, name, coreOutcome: '合成增长负载，不是新增课程知识', sourceRefs: [] });
        graph.layout.groups.push({ elementId: 'VE-G-' + themeId, themeId, title: name, x: dx, y: 0, width: bounds.right + 100, height: bounds.bottom + 100 });
      }
      appended.push({ id, seedUnitId: seed.id, themeId });
    }
    graph.counts = { ...graph.counts, units: total, themes: graph.groups.length };
    db.prepare("UPDATE metadata SET value=? WHERE key='course-graph'").run(JSON.stringify(graph));
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; } finally { db.close(); }
  assertPreserved(originals, target);
  core = new CourseService(workerPath);
  try {
    const opened = await core.open(target), actual = await core.graph(opened.sessionId);
    if (actual.nodes.length !== total) throw new Error('Core graph count mismatch');
    for (const entry of appended) await core.readUnit(opened.sessionId, entry.id);
  } finally { await core.close(); }
  assertPreserved(originals, target);
  if (hash(readFileSync(join(source, 'course.sqlite'))) !== sourceHash || JSON.stringify(authorityHashes(source)) !== JSON.stringify(authority)) throw new Error('Source changed during fixture preparation');
  if (JSON.stringify(authorityHashes(target)) !== JSON.stringify(authority)) throw new Error('Authority markers changed; do not reseal them in fixture tooling');
  const manifest = { scope: 'synthetic growth fixture; no performance or physical acceptance', source, sourceDatabaseSha256: sourceHash,
    authorityHashes: authority, sourceUnits: originals.length, totalUnits: total, syntheticUnits: appended.length, formalRelations: graph.edges.length,
    originals: originals.map(row => ({ id: row.id, revision: row.revision, sha256: hash(row.payload) })), appended };
  writeFileSync(join(target, 'growth-fixture.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function main() {
  const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const result = await prepareGrowthFixture({ source: args.get('--source'), target: args.get('--target'), total: Number(args.get('--total') ?? 500), workerPath: resolve(args.get('--worker') ?? 'dist/worker.cjs') });
  console.log(JSON.stringify({ target: args.get('--target'), sourceUnits: result.sourceUnits, totalUnits: result.totalUnits, syntheticUnits: result.syntheticUnits }));
}
if (basename(process.argv[1] ?? '') === 'prepare-growth-fixture.mjs') void main().catch(error => { console.error(error); process.exitCode = 1; });
