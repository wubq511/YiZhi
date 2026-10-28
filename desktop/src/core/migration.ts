import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, lstatSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashFile, publishResource } from './immutable-resource';
import { validateRelationGraph } from './relation-validation';
import { withPdf } from './source-pdf';
import type { CourseGraph, CourseUnit, ReadingBlock } from '../shared';
import type { SourceVersion } from '../sources-api';
import type { MigrationReport, MigrationTarget, LegacyContent } from '../migration-api';

const json = (value: unknown) => JSON.stringify(value);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function coursePath(root: string, name: string) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) throw new Error(`课程相对路径无效: ${name}`);
  const path = resolve(root, name);
  if (relative(root, path).startsWith('..')) throw new Error('课程路径越界');
  let current = path;
  while (current !== root) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('课程资源不接受软链'); current = dirname(current); }
  return path;
}
export async function acquireLegacyLease(source:string) {
  const child=spawn('python3',[join(__dirname,'legacy-lock.py'),source],{stdio:['pipe','pipe','pipe'],shell:false});
  child.stdin!.on('error',()=>{});let errorText='';child.stderr!.on('data',data=>{errorText+=data;});
  const ended=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('exit',yes);});
  await Promise.race([new Promise<void>(yes=>child.stdout!.once('data',()=>yes())),ended.then(()=>{throw new Error(errorText||'无法取得源课程写入锁');})]);
  return {child,async close(){child.stdin!.end();await ended;}};
}
export async function locked<T>(source:string,use:(child:ReturnType<typeof spawn>)=>Promise<T>):Promise<T>{
 const lease=await acquireLegacyLease(source);try{return await use(lease.child);}finally{await lease.close();}
}
export async function snapshotLegacy(request: MigrationTarget) {
  const root = realpathSync(request.sourceDirectory), directory = resolve(request.directory);
  if (existsSync(directory) || directory.startsWith(root + '/')) throw new Error('必须使用源课程外的全新目录');
  return locked(root, async child => {
    const output = new Promise<{ directory: string; files: Record<string, string> }>((resolve, reject) => {
      let text = ''; child.stdout!.on('data', data => { text += data; });
      child.once('exit', code => { if (code !== 0) reject(new Error('一致副本复制失败')); else { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } } });
    });
    child.stdin!.end(json({ action: 'snapshot', directory }) + '\n'); return output;
  });
}
export function legacyContent(db: DatabaseSync): LegacyContent {
  const row = db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
  if (!row) throw new Error('当前课程不是已转换的内容候选');
  return JSON.parse(String(row.value));
}
export function candidateResource(db: DatabaseSync, directory: string, asset: string) {
  const exchanged = db.prepare("SELECT 1 FROM sqlite_master WHERE name='exchange_resources'").get() ? db.prepare('SELECT payload FROM exchange_resources WHERE asset=?').get(asset) : undefined;
  const legacy = db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
  const item = exchanged ? JSON.parse(String(exchanged.payload)) : legacy ? JSON.parse(String(legacy.value)).report.resources.find((item: any) => item.asset === asset) : undefined;
  if (!item || !item.mediaType.startsWith('image/')) throw new Error('未登记的课程图片');
  const path = coursePath(directory, item.path), actual = hashFile(path);
  if (actual.sha256 !== item.sha256 || actual.byteLength !== item.byteLength) throw new Error('课程图片损坏或缺失');
  return { bytes: new Uint8Array(readFileSync(path)), mediaType: item.mediaType };
}
function graphFor(knowledge: any, layout: any): CourseGraph {
  const groups = knowledge.themes;
  const nodes = knowledge.units.map((u: any) => ({ id: u.id, name: u.name, kind: u.kind, themeId: u.themeId ?? u.theme?.id,
    themeName: groups.find((g: any) => g.id === (u.themeId ?? u.theme?.id))?.name, stars: u.rating.stars }));
  const edges = structuredClone(knowledge.relations);
  for (const group of knowledge.requirementGroups ?? []) for (const edge of edges) if (group.relationIds.includes(edge.id)) edge.requirementGroupId = group.id;
  return { nodes, groups: structuredClone(groups), edges, requirementGroups: structuredClone(knowledge.requirementGroups ?? []), conditions: {},
    counts: { units: nodes.length, themes: groups.length, relations: edges.length }, layout: structuredClone(layout) };
}
function validate(knowledge: any, graph: CourseGraph) {
  if (knowledge.schemaVersion !== 'midterm-map-1' || !knowledge.units.length || !knowledge.units.some((u: any) => u.id === 'KU-001')) throw new Error('不支持的旧课程格式或缺少首单元');
  for (const name of ['themes','units','questions','mappings','relations','sources','requirementGroups']) {
    const items = knowledge[name] ?? [];
    if (!Array.isArray(items) || items.some((item: any) => !item.id) || new Set(items.map((item: any) => item.id)).size !== items.length) throw new Error('课程稳定身份缺失或重复: '+name);
  }
  const refs = (value: any) => { if (Array.isArray(value)) value.forEach(refs); else if (value && typeof value === 'object') {
    if (Array.isArray(value.sourceRefs)) for (const ref of value.sourceRefs) {
      if (!knowledge.sources.some((s: any) => s.id === ref.sourceId && s.versions?.some((v: any) => v.id === ref.versionId))) throw new Error('固定来源版本不存在');
    }
    Object.values(value).forEach(refs);
  } }; refs(knowledge);
  validateRelationGraph(graph, knowledge.sources, (knowledge.retiredUnits ?? []).map((u: any) => u.id));
  const ids = new Set(graph.nodes.map(n => n.id)), blocks = new Set<string>();
  if (ids.size !== graph.nodes.length || knowledge.retiredUnits?.some((u: any) => ids.has(u.id))) throw new Error('稳定身份重复或恢复了退休身份');
  const walk = (list: ReadingBlock[]) => { for (const block of list) {
    if (!block.id || blocks.has(block.id) || !block.payload || !block.kind) throw new Error('正文稳定身份重复或载荷不完整'); blocks.add(block.id);
    if (block.kind === 'knowledge-reference' && !ids.has(block.payload.targetUnitId)) throw new Error('知识引用目标不存在');
    if (block.children) walk(block.children);
  } };
  for (const u of knowledge.units) {
    if (u.reading?.schemaVersion !== 'review-reading-1' || !Array.isArray(u.reading.blocks)) throw new Error('单元正文缺失或格式不支持');
    if (!graph.groups.some(g => g.id === (u.themeId ?? u.theme?.id))) throw new Error('单元主题不存在'); walk(u.reading.blocks);
  }
  if (graph.layout.nodes.length !== ids.size || new Set(graph.layout.nodes.map(n => n.unitId)).size !== ids.size || graph.layout.nodes.some(n => !ids.has(n.unitId))) throw new Error('布局缺少单元或含失效身份');
  for (const e of graph.edges) if (!ids.has(e.fromUnitId) || !ids.has(e.toUnitId)) throw new Error('正式关系端点不存在');
  const questions = new Set(knowledge.questions.map((q: any) => q.id));
  for (const m of knowledge.mappings) if (!ids.has(m.unitId) || !questions.has(m.questionId)) throw new Error('题目映射目标不存在');
}
function durableFile(path: string, bytes: string) { const fd = openSync(path, 'wx'); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } }
export async function convertLegacy(request: MigrationTarget, scheduling?: import('../migration-api').MigrationScheduling): Promise<MigrationReport> {
  const root = realpathSync(request.sourceDirectory), target = resolve(request.directory);
  if (existsSync(target) || target.startsWith(root + '/') || root.startsWith(target + '/')) throw new Error('内容候选必须使用源课程外的全新目录');
  return locked(root, async child => {
    child.stdin!.write(json({ action: 'hold' }) + '\n');
    const manifestFile = join(root, '课程.json'), manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    if (manifest.schemaVersion !== 'review-course-1') throw new Error('不支持的旧课程清单');
    const knowledgeFile = coursePath(root, manifest.knowledge), layoutFile = coursePath(root, manifest.layout);
    const knowledge = JSON.parse(readFileSync(knowledgeFile, 'utf8')), layout = JSON.parse(readFileSync(layoutFile, 'utf8'));
    const graph = graphFor(knowledge, layout); validate(knowledge, graph);
    const stage = target + '.converting-' + randomUUID(); mkdirSync(stage);
    let db: DatabaseSync | undefined;
    try {
      const report: MigrationReport = { schema: 'yizhi-content-candidate-1', scope: 'content-candidate', sourceDirectory: root,
        sourceHashes: Object.fromEntries([manifestFile, knowledgeFile, layoutFile].map(p => [relative(root, p), hashFile(p).sha256])),
        unitHashes: {}, resources: [], differences: ['单元增加现有 renderer 所需 theme {id,name} 投影；原始知识载荷完整另存。', '关系路线组成员按既有 relationIds 投影到边；原关系与布局完整另存。'], gaps: [
          '仅内容候选：未迁入个人状态、任务、草稿、对话与历史；T25 负责完整迁移和唯一权威切换。',
          '旧版缺少精确导入时间；来源 importedAt 保留为空值，不以转换时间冒充历史。',
          '旧版 PDF 页码与印刷页记录保留原载荷；未推断印刷页映射或文本投影。',
          'reading.revision 原样保留；新版逐块修订为候选运行版本，不冒充旧历史或旧文本投影。' ],
        counts: { themes: knowledge.themes.length, units: knowledge.units.length,
          answerableQuestions: knowledge.questions.filter((q: any) => !knowledge.questions.some((child: any) => child.parentId === q.id)).length,
          questionRecords: knowledge.questions.length, mappings: knowledge.mappings.length, relations: knowledge.relations.length } };
      if (manifest.courseId !== knowledge.course.id) report.gaps.push(`包身份 ${manifest.courseId} 与内容身份 ${knowledge.course.id} 分别保留。`);
      if (manifest.name !== knowledge.course.title) report.gaps.push(`标题差异保留：${manifest.name} / ${knowledge.course.title}`);
      const versions: SourceVersion[] = [], byVersion = new Map<string, { path: string; sourceId: string; pages: number }>();
      const resources = join(stage, 'resources');
      const copy = async (path: string, expected?: string) => publishResource(resources, path, async () => {}, expected);
      for (const source of knowledge.sources) for (const version of source.versions ?? []) {
        if (!/^[a-f0-9]{64}$/.test(version.sha256)) throw new Error('固定来源版本缺少有效 SHA-256');
        if (byVersion.has(version.id)) throw new Error('来源版本身份重复');
        const path = coursePath(root, version.path), copied = await copy(path, version.sha256);
        report.sourceHashes[version.path] = copied.sha256;
        const pdfPages = await withPdf(join(resources, copied.sha256), async pdf => pdf.numPages);
        if (version.totalPages !== pdfPages) report.gaps.push(`${source.id}/${version.id} 页数元数据 ${version.totalPages}，实际 PDF ${pdfPages}；原元数据保留，阅读边界采用实际页数。`);
        versions.push({ sourceId: source.id, versionId: version.id, sha256: copied.sha256, byteLength: copied.byteLength,
          mediaType: 'application/pdf', originalName: basename(version.path), title: source.title, pdfPages, importedAt: '' });
        byVersion.set(version.id, { path: join(resources, copied.sha256), sourceId: source.id, pages: pdfPages });
        report.resources.push({ asset: version.path, path: 'resources/' + copied.sha256, sha256: copied.sha256, byteLength: copied.byteLength, mediaType: 'application/pdf' });
      }
      const assets = new Set<string>();
      const walk = (value: any) => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') {
        if (value.kind === 'figure' && typeof value.payload?.asset === 'string') assets.add(value.payload.asset);
        for (const child of Object.values(value)) walk(child);
      } }; walk(knowledge);
      for (const asset of assets) {
        const match = /^\/source-pages\/([^/]+)\/([^/]+)\/(\d+)\.png$/.exec(asset);
        if (match) {
          const [, sourceId, versionId, number] = match, version = byVersion.get(versionId), pageIndex = Number(number);
          if (!version || version.sourceId !== sourceId || pageIndex < 1 || pageIndex > version.pages) throw new Error('图片引用的固定来源/页码无效');
          const bytes = await withPdf(version.path, async pdf => {
            const page = await pdf.getPage(pageIndex), viewport = page.getViewport({ scale: 1.5 });
            if (viewport.width * viewport.height > 16_000_000) throw new Error('原页图片超出逐页上限');
            const { createCanvas } = await import('@napi-rs/canvas');
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
            return canvas.toBuffer('image/png');
          });
          const digest = sha(bytes), path = join(resources, digest);
          if (!existsSync(path)) { const fd = openSync(path, 'wx'); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); } }
          report.resources.push({ asset, path: 'resources/' + digest, sha256: digest, byteLength: bytes.length, mediaType: 'image/png' });
        } else {
          const path = coursePath(root, asset.replace(/^\/(?:course-assets|assets)\//, '')), copied = await copy(path);
          if (!/\.(png|jpe?g)$/i.test(path)) throw new Error('未支持的课程图片类型');
          const { loadImage } = await import('@napi-rs/canvas'); await loadImage(join(resources, copied.sha256));
          report.resources.push({ asset, path: 'resources/' + copied.sha256, sha256: copied.sha256, byteLength: copied.byteLength, mediaType: /\.png$/i.test(path) ? 'image/png' : 'image/jpeg' });
          report.sourceHashes[relative(root,path)] = copied.sha256;
        }
      }
      db = new DatabaseSync(join(stage, 'course.sqlite'));
      db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE units(id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL);
        CREATE TABLE source_versions(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, payload TEXT NOT NULL);
        PRAGMA user_version=1;`);
      if (scheduling?.beforeRegistration) {
        const signal = new Int32Array(scheduling.beforeRegistration);
        if (Atomics.compareExchange(signal,0,0,1) === 0) {
          const deadline = Date.now() + 15000;
          while (Atomics.load(signal,0) === 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,10));
          if (Atomics.load(signal,0) !== 2) throw new Error('候选登记等待超时');
        }
      }
      db.exec('BEGIN IMMEDIATE');
      for (const original of knowledge.units) {
        const theme = knowledge.themes.find((t: any) => t.id === (original.themeId ?? original.theme?.id));
        const unit: CourseUnit = { ...original, theme: { ...original.theme, id: theme.id, name: theme.name } };
        db.prepare('INSERT INTO units VALUES(?,?,?)').run(unit.id, json(unit), original.reading.revision ?? 1);
        report.unitHashes[unit.id] = sha(json(original));
      }
      for (const version of versions) db.prepare('INSERT INTO source_versions VALUES(?,?,?)').run(version.versionId, version.sourceId, json(version));
      const meta = db.prepare('INSERT INTO metadata VALUES(?,?)');
      meta.run('courseId', manifest.courseId); meta.run('course-graph', json(graph));
      meta.run('relation-catalog', json({ sources: knowledge.sources, retiredUnitIds: knowledge.retiredUnits.map((u: any) => u.id) }));
      meta.run('legacy-content', json({ manifest, knowledge, layout, report }));
      meta.run('content-scope', 'content-candidate');
      // Verify every persisted payload, rather than checking only conversion inputs.
      for (const original of knowledge.units) {
        const stored = JSON.parse(String(db.prepare('SELECT payload FROM units WHERE id=?').get(original.id)!.payload));
        const { theme: _, ...projection } = stored, { theme: _old, ...expected } = original;
        if (json(projection) !== json(expected)) throw new Error('持久化单元与源内容不同');
      }
      if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new Error('候选数据库校验失败');
      for (const [file, hash] of Object.entries(report.sourceHashes)) if (hashFile(coursePath(root,file)).sha256 !== hash) throw new Error('转换期间源课程发生变化');
      for (const item of report.resources) if (hashFile(coursePath(stage,item.path)).sha256 !== item.sha256) throw new Error('候选资源校验失败');
      if (child.exitCode !== null || child.killed) throw new Error('源课程写入锁租约已丢失');
      const resourcesFd = openSync(resources,'r'); try { fsyncSync(resourcesFd); } finally { closeSync(resourcesFd); }
      db.exec('COMMIT'); db.close(); db = undefined;
      durableFile(join(stage, 'content-candidate.json'), json(report));
      const stageFd = openSync(stage,'r'); try { fsyncSync(stageFd); } finally { closeSync(stageFd); }
      // New destination only. No application authority pointer is switched by T24.
      if (existsSync(target)) throw new Error('目标目录已存在');
      const published = new Promise<void>((resolve,reject) => {
        child.stdout!.once('data',data => { try { const result=JSON.parse(String(data)); if(result.published) resolve(); else reject(new Error('候选独占发布失败: '+result.error)); } catch(error) { reject(error); } });
        child.once('exit',()=>reject(new Error('源课程锁租约在发布前丢失')));
      });
      child.stdin!.write(json({action:'publish',from:stage,to:target})+'\n');
      await published;
      const parentFd = openSync(dirname(target),'r'); try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      return report;
    } catch (error) { if (db) { try { db.exec('ROLLBACK'); } catch {} db.close(); } rmSync(stage, { recursive: true, force: true }); throw error; }
  });
}
