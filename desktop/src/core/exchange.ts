import { withPdf } from './source-pdf';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseGraph, CourseUnit, ReadingBlock } from '../shared';
import type { RelationSource } from '../relation-api';
import type { SourceVersion } from '../sources-api';
import {
  exchangeVersion,
  exchangeExcludes,
  type ExportExchange,
  type ImportExchange,
  type ExchangeReceipt,
} from '../exchange-api';
import { appendEvent, eventCursor, transaction } from './save-store';
import { hashFile, publishResource } from './immutable-resource';
import { validateRelationGraph } from './relation-validation';
import { syncAnnotations } from './annotations';
import {
  json,
  parse,
  digest,
  id,
  hash,
  record,
  safePath,
  readPlain,
  summary,
  catalog,
  validate,
  load,
  flush,
  type Package,
  type Resource,
} from './exchange-format';

export class Exchange {
  constructor(
    private db: DatabaseSync,
    private directory: string,
    private seed: CourseGraph,
    private graph: () => CourseGraph,
    private relationCatalog: () => { sources: RelationSource[]; retiredUnitIds: string[] },
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS exchange_operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exchange_resources(asset TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exchange_history(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  }
  fence(action: string, operationId: string) {
    if (
      !action.startsWith('exchange:') &&
      this.db.prepare('SELECT 1 FROM exchange_operations WHERE id=?').get(operationId)
    )
      throw new Error('操作身份已用于交换导入');
  }
  available() {
    return this.db
      .prepare('SELECT id,payload FROM units ORDER BY id')
      .all()
      .map((r) => ({ id: String(r.id), name: parse(r.payload).name }));
  }
  private basis() {
    return digest({
      course: this.db
        .prepare(
          "SELECT value FROM metadata WHERE key IN ('courseId','generation','formal-relations-revision') ORDER BY key",
        )
        .all(),
      units: this.db.prepare('SELECT id,payload,revision FROM units ORDER BY id').all(),
      graph: this.graph(),
      notes: this.db.prepare('SELECT * FROM personal_notes ORDER BY id').all(),
      drafts: this.db.prepare('SELECT * FROM drafts ORDER BY rowid').all(),
      cursor: eventCursor(this.db),
    });
  }
  exportPackage(request: ExportExchange) {
    if (
      !Array.isArray(request.unitIds) ||
      !request.unitIds.length ||
      new Set(request.unitIds).size !== request.unitIds.length ||
      typeof request.annotations !== 'boolean'
    )
      throw new Error('请选择明确的交换范围');
    const graph = this.graph(),
      selected = new Set(request.unitIds);
    const units = request.unitIds.map((unitId) => {
      const row = this.db.prepare('SELECT payload,revision FROM units WHERE id=?').get(unitId);
      if (!row) throw new Error('所选单元尚无持久化正文');
      return { value: parse(row.payload), revision: Number(row.revision) };
    });
    const nodes = graph.nodes.filter((n) => selected.has(n.id)),
      themes = new Set(nodes.map((n) => n.themeId));
    const edges = graph.edges.filter((e) => selected.has(e.fromUnitId) && selected.has(e.toUnitId));
    const groups = graph.requirementGroups.filter((g) => edges.some((e) => e.requirementGroupId === g.id));
    if (groups.some((g) => g.relationIds.some((id) => !edges.some((e) => e.id === id))))
      throw new Error('路线组跨出所选范围，请共同选择完整成员');
    const notes = request.annotations
      ? this.db
          .prepare('SELECT value FROM personal_notes ORDER BY rowid')
          .all()
          .map((r) => parse(r.value))
          .filter((n) => selected.has(n.note.original.unitId))
      : [];
    const annotationVersions = this.db
      .prepare('SELECT * FROM annotation_versions')
      .all()
      .filter((r) =>
        notes.some((n) =>
          [...n.note.current.fragments, ...n.lineage.flat()].some(
            (l) => l.blockId === r.block_id && l.version === r.version,
          ),
        ),
      )
      .map((r) => ({ ...r, block: parse(r.block) }));
    const references = new Set<string>(),
      assets = new Set<string>();
    const refs = (v: any) => {
      if (Array.isArray(v)) v.forEach(refs);
      else if (record(v)) {
        if (Array.isArray(v.sourceRefs)) for (const r of v.sourceRefs) references.add(r.versionId);
        if (v.kind === 'figure' && v.payload?.asset !== undefined) assets.add(v.payload.asset);
        Object.values(v).forEach(refs);
      }
    };
    refs([units, edges, groups, notes, annotationVersions]);
    const sources = [...references].map((versionId) => {
      const r = this.db.prepare('SELECT payload FROM source_versions WHERE id=?').get(versionId);
      if (!r) throw new Error('固定来源资源尚未登记');
      return parse(r.payload) as SourceVersion;
    });
    const legacy = this.db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
    const registered: Resource[] = [
      ...(legacy ? parse(legacy.value).report.resources : []),
      ...this.db
        .prepare('SELECT payload FROM exchange_resources')
        .all()
        .map((r) => parse(r.payload)),
    ];
    const resources: Resource[] = sources.map((s) => ({
      path: `resources/${s.sha256}`,
      sha256: s.sha256,
      byteLength: s.byteLength,
      mediaType: s.mediaType,
    }));
    for (const asset of assets) {
      const item = registered.find((r) => r.asset === asset);
      if (!item) throw new Error('图片资源尚未登记');
      resources.push(item);
    }
    const p: Package = {
      formatVersion: exchangeVersion,
      kind: 'content-exchange',
      payloadVersion: 'review-reading-1',
      scope: { unitIds: request.unitIds, annotations: request.annotations, excludes: [...exchangeExcludes] },
      units,
      graph: {
        nodes,
        groups: graph.groups.filter((g) => themes.has(g.id)),
        edges,
        requirementGroups: groups,
        conditions: {},
        layout: { nodes: [], groups: [] },
      },
      sources,
      resources,
      pageMaps: this.db
        .prepare('SELECT payload FROM source_page_maps ORDER BY rowid')
        .all()
        .map((r) => parse(r.payload))
        .filter((m) => references.has(m.versionId)),
      notes,
      annotationVersions: annotationVersions as Package['annotationVersions'],
    };
    validate(p);
    // A manifest is the last, exclusive publication marker. A crash residue without it is unusable.
    const target = resolve(request.directory);
    if (existsSync(target) || target === this.directory || target.startsWith(this.directory + '/'))
      throw new Error('导出必须选择课程外的全新目录');
    mkdirSync(target);
    let complete = false;
    try {
      mkdirSync(join(target, 'resources'));
      for (const r of p.resources) {
        const source = safePath(this.directory, r.path),
          actual = hashFile(source);
        if (actual.sha256 !== r.sha256 || actual.byteLength !== r.byteLength) throw new Error('资源摘要不符');
        const out = join(target, r.path);
        if (!existsSync(out)) {
          writeFileSync(out, readPlain(source, 512 * 1024 * 1024), { flag: 'wx' });
          const fd = openSync(out, 'r');
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          const copied = hashFile(out);
          if (copied.sha256 !== r.sha256) throw new Error('资源复制摘要不符');
        }
      }
      flush(join(target, 'resources'));
      writeFileSync(join(target, 'manifest.json'), json(p), { flag: 'wx' });
      const fd = openSync(join(target, 'manifest.json'), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      flush(target);
      flush(dirname(target));
      complete = true;
      return summary(p);
    } finally {
      if (!complete) rmSync(target, { recursive: true, force: true });
    }
  }
  inspect(directory: string) {
    const p = load(directory);
    return { ...summary(p), packageDigest: digest(p), basis: this.basis() };
  }
  query(operationId: string): ExchangeReceipt | null {
    const r = this.db.prepare('SELECT receipt FROM exchange_operations WHERE id=?').get(operationId);
    return r ? parse(r.receipt) : null;
  }
  async importPackage(request: ImportExchange) {
    if (!id(request.operationId) || !hash(request.packageDigest) || !hash(request.basis))
      throw new Error('非法导入操作或当前依据');
    const identity = digest({ packageDigest: request.packageDigest, basis: request.basis });
    const old = this.db.prepare('SELECT * FROM exchange_operations WHERE id=?').get(request.operationId);
    if (old) {
      if (old.digest !== identity) throw new Error('同一操作身份不能换用不同包或依据');
      return parse(old.receipt);
    }
    for (const table of [
      'operations',
      'cg_candidates',
      'annotation_operations',
      'source_operations',
      'source_imports',
      'parse_operations',
      'agent_operations',
      'builtin_experiment_operations',
      'extension_operations',
    ])
      if (
        this.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table) &&
        this.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(request.operationId)
      )
        throw new Error('操作身份已用于其他修改');
    const p = load(request.directory);
    if (digest(p) !== request.packageDigest) throw new Error('交换包已变化，请重新检查');
    if (this.basis() !== request.basis) throw new Error('当前依据已变化，请重新检查；既有内容未修改');
    const ownedBlocks = new Map<string, string>();
    const collect = (unit: CourseUnit, blocks: ReadingBlock[]) => {
      for (const b of blocks) {
        ownedBlocks.set(b.id, unit.id);
        collect(unit, b.children ?? []);
      }
    };
    for (const row of this.db.prepare('SELECT payload FROM units').all()) {
      const unit = parse(row.payload);
      collect(unit, unit.reading.blocks);
    }
    const check = (unit: CourseUnit, blocks: ReadingBlock[]) => {
      for (const b of blocks) {
        if (ownedBlocks.has(b.id) && ownedBlocks.get(b.id) !== unit.id) throw new Error('块结构身份冲突: ' + b.id);
        check(unit, b.children ?? []);
      }
    };
    for (const u of p.units) check(u.value, u.value.reading.blocks);
    const graph = this.graph();
    const merge = (current: any[], incoming: any[], key: (v: any) => string, label: string) => {
      const next = structuredClone(current);
      for (const item of incoming) {
        const prior = next.find((x) => key(x) === key(item));
        if (prior && digest(prior) !== digest(item)) throw new Error('身份冲突，保留既有' + label + ': ' + key(item));
        if (!prior) next.push(item);
      }
      return next;
    };
    for (const u of p.units) {
      const r = this.db.prepare('SELECT payload FROM units WHERE id=?').get(u.value.id);
      if (!r && this.seed.nodes.some((n) => n.id === u.value.id))
        throw new Error('身份冲突，既有单元尚未持久化，不能替换其正文: ' + u.value.id);
      if (r && digest(parse(r.payload)) !== digest(u.value)) throw new Error('身份冲突，保留既有正文: ' + u.value.id);
    }
    const next: CourseGraph = {
      ...this.seed,
      nodes: merge(graph.nodes, p.graph.nodes, (x) => x.id, '单元结构'),
      groups: merge(graph.groups, p.graph.groups, (x) => x.id, '主题'),
      edges: merge(graph.edges, p.graph.edges, (x) => x.id, '关系'),
      requirementGroups: merge(graph.requirementGroups, p.graph.requirementGroups, (x) => x.id, '路线组'),
    };
    const combinedSources = this.db
      .prepare('SELECT payload FROM source_versions')
      .all()
      .map((r) => parse(r.payload));
    merge(combinedSources, p.sources, (x) => x.versionId, '来源版本');
    for (const [table, items, key, payload] of [
      ['personal_notes', p.notes, (x: any) => x.note.id, 'value'],
      ['source_page_maps', p.pageMaps, (x: any) => x.id, 'payload'],
      ['exchange_resources', p.resources.filter((r) => r.asset), (x: any) => x.asset, 'payload'],
    ] as const) {
      for (const item of items) {
        const r = this.db
          .prepare(`SELECT ${payload} FROM ${table} WHERE ${table === 'exchange_resources' ? 'asset' : 'id'}=?`)
          .get(key(item));
        if (r && digest(parse(r[payload])) !== digest(item)) throw new Error('身份冲突，保留既有个人记录或资源');
      }
    }
    const legacy = this.db.prepare("SELECT value FROM metadata WHERE key='legacy-content'").get();
    const existingImages: Resource[] = legacy
      ? parse(legacy.value).report.resources.filter((r: Resource) => r.mediaType.startsWith('image/'))
      : [];
    for (const r of p.resources.filter((r) => r.asset)) {
      const old = existingImages.find((x) => x.asset === r.asset);
      if (old && (old.sha256 !== r.sha256 || old.byteLength !== r.byteLength || old.mediaType !== r.mediaType))
        throw new Error('图片身份冲突，保留既有不可变资源');
    }
    const { sources: sourceCatalog, retiredUnitIds: retired } = this.relationCatalog();
    const availableSources = structuredClone(sourceCatalog);
    for (const incoming of catalog(p)) {
      for (const version of incoming.versions)
        if (availableSources.some((s) => s.id !== incoming.id && s.versions.some((v) => v.id === version.id)))
          throw new Error('固定来源版本身份冲突');
      const source = availableSources.find((s) => s.id === incoming.id);
      if (!source) availableSources.push(incoming);
      else
        for (const v of incoming.versions) if (!source.versions.some((old) => old.id === v.id)) source.versions.push(v);
    }
    if (p.graph.nodes.some((n) => retired.includes(n.id))) throw new Error('退休单元身份冲突，不能复活既有退休身份');
    validateRelationGraph(next, availableSources, retired);
    for (const r of p.resources) {
      const source = safePath(request.directory, r.path);
      const published = await publishResource(join(this.directory, 'resources'), source, async (path) => {
        if (r.mediaType === 'application/pdf')
          await withPdf(path, async (document) => {
            if (p.sources.some((s) => s.sha256 === r.sha256 && s.pdfPages !== document.numPages))
              throw new Error('固定来源页数与实际原件不符');
          });
        else {
          const { loadImage } = await import('@napi-rs/canvas');
          const image = await loadImage(path);
          if (!image.width || !image.height) throw new Error('图片载荷无法解码');
        }
      });
      if (published.sha256 !== r.sha256 || published.byteLength !== r.byteLength) throw new Error('资源摘要不符');
    }
    // File validation is asynchronous; compare the entire formal basis again inside the one commit.
    return transaction(this.db, () => {
      if (this.basis() !== request.basis) throw new Error('当前依据已变化，请重新检查');
      const changes: Array<{ kind: string; id: string; before: null; after: unknown }> = [];
      const register = (sql: string, parameters: Array<string | number>, kind: string, id: string, value: unknown) => {
        if (Number(this.db.prepare(sql).run(...parameters).changes))
          changes.push({ kind, id, before: null, after: value });
      };
      for (const u of p.units)
        register(
          'INSERT OR IGNORE INTO units VALUES(?,?,?)',
          [u.value.id, json(u.value), u.revision],
          'unit',
          u.value.id,
          u,
        );
      for (const s of p.sources)
        register(
          'INSERT OR IGNORE INTO source_versions VALUES(?,?,?)',
          [s.versionId, s.sourceId, json(s)],
          'source-version',
          s.versionId,
          s,
        );
      for (const m of p.pageMaps)
        register(
          'INSERT OR IGNORE INTO source_page_maps VALUES(?,?,?,?)',
          [m.id, m.versionId, m.pdfPageIndex, json(m)],
          'page-map',
          m.id,
          m,
        );
      for (const r of p.resources.filter((r) => r.asset))
        register(
          'INSERT OR IGNORE INTO exchange_resources VALUES(?,?)',
          [r.asset!, json(r)],
          'image-resource',
          r.asset!,
          r,
        );
      for (const v of p.annotationVersions)
        register(
          'INSERT OR IGNORE INTO annotation_versions(block_id,version,revision,block,unit_id) VALUES(?,?,?,?,?)',
          [v.block_id, v.version, v.revision, json(v.block), v.unit_id ?? 'KU-001'],
          'annotation-version',
          v.block_id + ':' + v.version,
          v,
        );
      for (const n of p.notes)
        register(
          'INSERT OR IGNORE INTO personal_notes VALUES(?,?)',
          [n.note.id, json(n)],
          'personal-note',
          n.note.id,
          n,
        );
      for (const e of p.graph.edges)
        register('INSERT OR IGNORE INTO formal_relations VALUES(?,?)', [e.id, json(e)], 'formal-relation', e.id, e);
      for (const g of p.graph.requirementGroups)
        register(
          'INSERT OR IGNORE INTO formal_requirement_groups VALUES(?,?)',
          [g.id, json(g)],
          'requirement-group',
          g.id,
          g,
        );
      const placements = structuredClone(this.seed.layout.nodes);
      for (const n of next.nodes)
        if (!placements.some((p) => p.unitId === n.id))
          placements.push({
            unitId: n.id,
            x: 104,
            y: Math.max(0, ...placements.map((p) => p.y + p.height)) + 200,
            width: 650,
            height: 86,
          });
      const layoutGroups = structuredClone(this.seed.layout.groups);
      for (const g of next.groups)
        if (!layoutGroups.some((p) => p.themeId === g.id)) {
          const members = placements.filter((p) => next.nodes.some((n) => n.id === p.unitId && n.themeId === g.id));
          layoutGroups.push({
            themeId: g.id,
            title: g.name,
            x: 64,
            y: Math.min(...members.map((p) => p.y)) - 100,
            width: 750,
            height: Math.max(...members.map((p) => p.y + p.height)) - Math.min(...members.map((p) => p.y)) + 200,
          });
        }
      const stored = {
        ...this.seed,
        nodes: next.nodes,
        groups: next.groups,
        layout: { ...this.seed.layout, nodes: placements, groups: layoutGroups },
      };
      this.db
        .prepare("INSERT INTO metadata VALUES('course-graph',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(json(stored));
      this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='formal-relations-revision'").run();
      syncAnnotations(this.db);
      const cursor = appendEvent(this.db, {
        type: 'exchange.imported',
        operationId: request.operationId,
        unitIds: p.scope.unitIds,
      });
      const receipt: ExchangeReceipt = {
        operationId: request.operationId,
        packageDigest: request.packageDigest,
        status: 'committed',
        cursor,
        unitIds: p.scope.unitIds,
      };
      this.db
        .prepare('INSERT INTO exchange_operations VALUES(?,?,?)')
        .run(request.operationId, identity, json(receipt));
      this.db.prepare('INSERT INTO exchange_history VALUES(?,?)').run(
        request.operationId,
        json({
          committedAt: new Date().toISOString(),
          operationId: request.operationId,
          generation: Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value),
          basis: request.basis,
          graphBefore: this.seed,
          graphAfter: stored,
          changes,
          packageDigest: request.packageDigest,
        }),
      );
      // Update shared graph only after SQLite commits, never on a failed transaction.
      return receipt;
    });
  }
  refresh() {
    const r = this.db.prepare("SELECT value FROM metadata WHERE key='course-graph'").get();
    if (r) Object.assign(this.seed, parse(r.value));
  }
}
