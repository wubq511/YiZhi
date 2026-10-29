import { definitionFrom } from './builtin-model';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CourseGraph, CourseUnit, ReadingBlock } from '../shared';
import type { SourceVersion, PrintedPage } from '../sources-api';
import { exchangeVersion, exchangeExcludes, type ExchangeSummary } from '../exchange-api';
import { hashFile } from './immutable-resource';
import { validateRelationGraph } from './relation-validation';

export const json = JSON.stringify;
export const parse = (v: unknown) => JSON.parse(String(v));
export const digest = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
function canonical(v: any): string {
  return Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => json(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : json(v);
}
export const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(v);
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const record = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
export interface Resource {
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  asset?: string;
}
export interface Package {
  formatVersion: typeof exchangeVersion;
  kind: 'content-exchange';
  payloadVersion: 'review-reading-1';
  scope: { unitIds: string[]; annotations: boolean; excludes: string[] };
  units: Array<{ value: CourseUnit; revision: number }>;
  graph: CourseGraph;
  sources: SourceVersion[];
  resources: Resource[];
  pageMaps: PrintedPage[];
  notes: Array<{
    note: import('../annotation-api').PersonalNote;
    lineage: import('../annotation-api').AnchorLocation[][];
  }>;
  annotationVersions: Array<{ block_id: string; version: string; revision: number; block: ReadingBlock; unit_id?: string }>;
}
/** Portable relative names, exact case/NFC spelling. Host absolute directory names are not package paths. */
function relative(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 240 ||
    name !== name.normalize('NFC') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name
      .split('/')
      .some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[<>:"|?*\u0000-\u001f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new Error('非法跨平台相对路径');
}
export function safePath(root: string, name: string) {
  relative(name);
  let path = resolve(root);
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('交换目录不接受软链');
  for (const part of name.split('/')) {
    if (!readdirSync(path).includes(part)) throw new Error('资源缺失或路径大小写不匹配');
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error('交换资源不接受软链');
  }
  return path;
}
export function readPlain(path: string, max: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.size > max || !s.size) throw new Error('交换文件大小或类型不支持');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function unique(items: any[], identity: (item: any) => unknown, label: string) {
  if (!Array.isArray(items) || items.length > 100000) throw new Error('不支持的交换载荷: ' + label);
  const keys = items.map(identity);
  if (keys.some((v) => !id(v)) || new Set(keys).size !== keys.length) throw new Error('身份冲突或非法身份: ' + label);
}
export function summary(p: Package): ExchangeSummary {
  return {
    formatVersion: p.formatVersion,
    kind: p.kind,
    unitIds: p.scope.unitIds,
    annotations: p.scope.annotations,
    excludes: p.scope.excludes,
    counts: {
      units: p.units.length,
      relations: p.graph.edges.length,
      sources: p.sources.length,
      resources: p.resources.length,
      notes: p.notes.length,
    },
  };
}
export function catalog(p: Package) {
  return p.sources
    .map((s) => ({ id: s.sourceId, title: s.title, versions: [{ id: s.versionId, totalPages: s.pdfPages }] }))
    .reduce(
      (all, s) => {
        const old = all.find((x) => x.id === s.id);
        if (old) old.versions.push(...s.versions);
        else all.push(s);
        return all;
      },
      [] as Array<{ id: string; title: string; versions: Array<{ id: string; totalPages: number }> }>,
    );
}
export function validate(p: Package) {
  if (
    !record(p) ||
    Object.keys(p).sort().join(',') !==
      [
        'formatVersion',
        'kind',
        'payloadVersion',
        'scope',
        'units',
        'graph',
        'sources',
        'resources',
        'pageMaps',
        'notes',
        'annotationVersions',
      ]
        .sort()
        .join(',') ||
    p.formatVersion !== exchangeVersion ||
    p.kind !== 'content-exchange' ||
    p.payloadVersion !== 'review-reading-1'
  )
    throw new Error('不支持的交换格式或载荷版本');
  if (
    !record(p.scope) ||
    Object.keys(p.scope).sort().join(',') !== 'annotations,excludes,unitIds' ||
    typeof p.scope.annotations !== 'boolean' ||
    json(p.scope.excludes) !== json(exchangeExcludes)
  )
    throw new Error('不支持或未声明的交换范围');
  if (
    !record(p.graph) ||
    Object.keys(p.graph).sort().join(',') !== 'conditions,edges,groups,layout,nodes,requirementGroups' ||
    !record(p.graph.conditions) ||
    Object.keys(p.graph.conditions).length ||
    !record(p.graph.layout) ||
    Object.keys(p.graph.layout).sort().join(',') !== 'groups,nodes' ||
    !Array.isArray(p.graph.layout.nodes) ||
    p.graph.layout.nodes.length ||
    !Array.isArray(p.graph.layout.groups) ||
    p.graph.layout.groups.length
  )
    throw new Error('不支持的课程结构载荷');
  unique(p.units, (x) => x?.value?.id, 'units');
  unique(p.graph?.nodes, (x) => x?.id, 'nodes');
  unique(p.graph?.groups, (x) => x?.id, 'groups');
  unique(p.sources, (x) => x?.versionId, 'sources');
  unique(p.notes, (x) => x?.note?.id, 'notes');
  unique(p.pageMaps, (x) => x?.id, 'pageMaps');
  if (
    !p.units.length ||
    !Array.isArray(p.scope.unitIds) ||
    digest(p.scope.unitIds) !== digest(p.units.map((u) => u.value.id)) ||
    digest([...p.scope.unitIds].sort()) !== digest(p.graph.nodes.map((n) => n.id).sort()) ||
    (!p.scope.annotations && (p.notes.length || p.annotationVersions.length))
  )
    throw new Error('声明范围与实际载荷不符');
  const blocks = new Map<string, ReadingBlock>(),
    versions = new Map(p.sources.map((s) => [s.versionId, s])),
    resources = new Map<string, Resource>();
  if (!Array.isArray(p.resources) || p.resources.length > 100000 || !Array.isArray(p.annotationVersions))
    throw new Error('资源载荷不支持');
  const paths = new Set<string>(),
    assets = new Set<string>(),
    portableAssets = new Set<string>();
  for (const r of p.resources) {
    relative(r.path);
    if (
      !hash(r.sha256) ||
      r.path !== `resources/${r.sha256}` ||
      !Number.isSafeInteger(r.byteLength) ||
      r.byteLength <= 0 ||
      r.byteLength > 512 * 1024 * 1024 ||
      !['application/pdf', 'image/png', 'image/jpeg'].includes(r.mediaType)
    )
      throw new Error('非法资源清单');
    // Multiple semantic assets may share the same immutable bytes.
    if (r.asset !== undefined && (typeof r.asset !== 'string' || assets.has(r.asset))) throw new Error('图片身份冲突');
    if (r.asset) {
      relative(r.asset.startsWith('/') ? r.asset.slice(1) : r.asset);
      const portable = r.asset.toLowerCase();
      if (portableAssets.has(portable)) throw new Error('图片路径大小写身份冲突');
      portableAssets.add(portable);
      assets.add(r.asset);
    }
    const old = resources.get(r.sha256);
    if (old && (old.byteLength !== r.byteLength || old.mediaType !== r.mediaType)) throw new Error('资源身份冲突');
    resources.set(r.sha256, r);
    const key = r.path.normalize('NFC').toLowerCase();
    if (paths.has(key) && !old) throw new Error('资源路径大小写冲突');
    paths.add(key);
  }
  for (const s of p.sources) {
    relative(s.originalName);
    if (
      !id(s.sourceId) ||
      !hash(s.sha256) ||
      !Number.isSafeInteger(s.pdfPages) ||
      (s.mediaType === 'application/pdf' ? s.pdfPages < 1 : s.pdfPages !== 0) ||
      typeof s.title !== 'string' ||
      (s.importedAt !== null && typeof s.importedAt !== 'string') ||
      !resources.has(s.sha256) ||
      resources.get(s.sha256)!.byteLength !== s.byteLength ||
      resources.get(s.sha256)!.mediaType !== s.mediaType
    )
      throw new Error('固定来源资源缺失或载荷非法');
  }
  const visit = (v: any, depth = 0) => {
    if (depth > 100) throw new Error('不支持的嵌套载荷');
    if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (record(v)) {
      if ('sourceRefs' in v) {
        if (!Array.isArray(v.sourceRefs)) throw new Error('非法来源引用');
        for (const ref of v.sourceRefs) {
          const s = versions.get(ref.versionId);
          if (
            !s ||
            s.sourceId !== ref.sourceId ||
            (s.mediaType === 'application/pdf'
              ? !Array.isArray(ref.pdfPages) ||
                !ref.pdfPages.length ||
                ref.pdfPages.some((n: any) => !Number.isSafeInteger(n) || n < 1 || n > s.pdfPages)
              : typeof ref.section !== 'string' ||
                !ref.section.trim() ||
                (ref.pdfPages !== undefined &&
                  (!Array.isArray(ref.pdfPages) || ref.pdfPages.some((n: any) => n !== 1))))
          )
            throw new Error('非法固定来源引用');
        }
      }
      if (v.kind === 'knowledge-reference' && v.payload && !p.scope.unitIds.includes(v.payload.targetUnitId))
        throw new Error('知识引用超出声明范围');
      if (v.kind === 'figure' && v.payload?.asset !== undefined && !assets.has(v.payload.asset))
        throw new Error('图片引用缺少所需资源');
      for (const [k, x] of Object.entries(v)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error('不支持的载荷属性');
        visit(x, depth + 1);
      }
    }
  };
  const walk = (list: ReadingBlock[], depth = 0) => {
    if (!Array.isArray(list) || depth > 50) throw new Error('非法正文结构');
    for (const b of list) {
      if (
        !id(b.id) ||
        blocks.has(b.id) ||
        !record(b.payload) ||
        ![
          'paragraph',
          'formula',
          'table',
          'callout',
          'example',
          'steps',
          'exercise',
          'knowledge-reference',
          'figure',
          'interactive',
        ].includes(b.kind)
      )
        throw new Error('不支持的正文载荷或结构身份冲突');
      const payload = b.payload;
      if (
        (['paragraph', 'callout'].includes(b.kind) && typeof payload.text !== 'string') ||
        (b.kind === 'formula' && typeof payload.latex !== 'string') ||
        (b.kind === 'steps' &&
          (!Array.isArray(payload.items) || payload.items.some((v: unknown) => typeof v !== 'string'))) ||
        (b.kind === 'table' &&
          (!Array.isArray(payload.columns) ||
            payload.columns.some((v: unknown) => typeof v !== 'string') ||
            !Array.isArray(payload.rows) ||
            payload.rows.some(
              (row: unknown) =>
                !Array.isArray(row) ||
                row.some((v) => typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))),
            ))) ||
        (['example', 'exercise'].includes(b.kind) &&
          (typeof payload.title !== 'string' || (payload.problem !== undefined && typeof payload.problem !== 'string')))
      )
        throw new Error('不支持的正文载荷结构');
      if (b.kind === 'interactive') definitionFrom(b.payload);
      if (b.kind === 'figure' && b.payload.asset === undefined) {
        const config = b.payload.config;
        if (
          !record(config) ||
          !Array.isArray(config.nodes) ||
          !config.nodes.length ||
          !Array.isArray(config.edges) ||
          new Set(config.nodes.map((n: any) => n.id)).size !== config.nodes.length ||
          config.nodes.some(
            (n: any) =>
              typeof n.id !== 'string' || !n.id || typeof n.label !== 'string' || ![n.x, n.y].every(Number.isFinite),
          ) ||
          config.edges.some(
            (e: any) =>
              !config.nodes.some((n: any) => n.id === e.from) || !config.nodes.some((n: any) => n.id === e.to),
          )
        )
          throw new Error('不支持的结构图载荷或非法图引用');
      }
      blocks.set(b.id, b);
      if (b.children !== undefined) walk(b.children, depth + 1);
    }
  };
  if (
    p.graph.groups.some((g) => typeof g.name !== 'string') ||
    p.graph.nodes.some(
      (n) =>
        typeof n.name !== 'string' ||
        typeof n.kind !== 'string' ||
        !Number.isFinite(n.stars) ||
        n.stars < 0 ||
        n.stars > 5 ||
        !p.graph.groups.some((g) => g.id === n.themeId),
    )
  )
    throw new Error('不支持的课程结构字段');
  for (const u of p.units) {
    if (
      typeof u.value.name !== 'string' ||
      typeof u.value.outcome !== 'string' ||
      typeof u.value.theme?.name !== 'string' ||
      !Number.isFinite(u.value.rating?.stars)
    )
      throw new Error('不支持的单元元数据载荷');
    if (
      u.value.reading?.schemaVersion !== 'review-reading-1' ||
      !Number.isSafeInteger(u.revision) ||
      u.revision < 1 ||
      !p.graph.groups.some((g) => g.id === u.value.theme?.id) ||
      p.graph.nodes.find((n) => n.id === u.value.id)?.themeId !== u.value.theme.id
    )
      throw new Error('不支持的正文版本或主题引用');
    walk(u.value.reading.blocks);
  }
  for (const map of p.pageMaps) {
    const s = versions.get(map.versionId);
    if (
      !s ||
      !Number.isSafeInteger(map.pdfPageIndex) ||
      map.pdfPageIndex < 0 ||
      map.pdfPageIndex >= (s.mediaType === 'application/pdf' ? s.pdfPages : 1) ||
      typeof map.label !== 'string'
    )
      throw new Error('非法印刷页引用');
  }
  const retained = new Map<string, ReadingBlock>();
  for (const v of p.annotationVersions) {
    if (
      !id(v.block_id) ||
      (v.unit_id !== undefined && !id(v.unit_id)) ||
      v.block.id !== v.block_id ||
      !['paragraph', 'formula'].includes(v.block.kind) ||
      !Number.isSafeInteger(v.revision) ||
      createHash('sha256').update(json(v.block)).digest('hex') !== v.version
    )
      throw new Error('批注原文版本非法');
    const key = v.block_id + ':' + v.version;
    if (retained.has(key)) throw new Error('批注版本身份冲突');
    retained.set(key, v.block);
  }
  for (const { note: n, lineage } of p.notes) {
    if (
      !n ||
      !p.scope.unitIds.includes(n.original?.unitId) ||
      (n.current?.unitId !== undefined && !p.scope.unitIds.includes(n.current.unitId)) ||
      typeof n.text !== 'string' ||
      !Number.isSafeInteger(n.version) ||
      n.version < 1 ||
      !Array.isArray(lineage) ||
      !Array.isArray(n.original.fragments) ||
      n.original.fragments.length !== n.originalVersions?.length ||
      !n.original.fragments.length ||
      !Array.isArray(n.current?.fragments) ||
      !n.current.fragments.length
    )
      throw new Error('不支持的个人批注载荷');
    for (const [i, f] of n.original.fragments.entries()) {
      if (
        f.blockId !== f.block?.id ||
        createHash('sha256').update(json(f.block)).digest('hex') !== n.originalVersions[i] ||
        !['text', 'latex'].includes(f.field) ||
        !Number.isSafeInteger(f.from) ||
        !Number.isSafeInteger(f.to) ||
        f.from < 0 ||
        f.to <= f.from
      )
        throw new Error('批注原文或选区非法');
      if (
        !['formal', 'student-draft'].includes(f.source) ||
        !Number.isSafeInteger(f.formalRevision) ||
        f.formalRevision < 1 ||
        f.projection?.version !== 1 ||
        typeof f.quote !== 'string'
      )
        throw new Error('批注原始依据非法');
      if (f.field === 'text') {
        if (
          f.block.kind !== 'paragraph' ||
          f.projection.encoding !== 'unicode-code-points' ||
          f.projection.text !== f.block.payload.text ||
          f.to > Array.from(f.projection.text).length ||
          Array.from(f.projection.text).slice(f.from, f.to).join('') !== f.quote
        )
          throw new Error('批注文字投影或引用不符');
      } else if (
        f.block.kind !== 'formula' ||
        f.projection.encoding !== 'mathlive-model' ||
        f.projection.latex !== f.block.payload.latex ||
        !Array.isArray(f.projection.cells) ||
        f.to > f.projection.cells.length ||
        f.projection.cells.some((c) => typeof c.latex !== 'string' || !Number.isSafeInteger(c.depth))
      )
        throw new Error('批注公式投影非法');
    }
    for (const loc of [...n.current.fragments, ...lineage.flat()]) {
      if (
        !id(loc.blockId) ||
        !hash(loc.version) ||
        !['attached', 'orphan'].includes(loc.status) ||
        !['text', 'latex'].includes(loc.field) ||
        !Number.isSafeInteger(loc.from) ||
        !Number.isSafeInteger(loc.to) ||
        loc.from < 0 ||
        loc.to <= loc.from
      )
        throw new Error('非法批注锚点');
      if (
        loc.status === 'attached' &&
        !retained.has(loc.blockId + ':' + loc.version) &&
        !n.original.fragments.some((f, i) => f.blockId === loc.blockId && n.originalVersions[i] === loc.version)
      )
        throw new Error('批注锚点缺少版本');
      if (
        n.current.fragments.includes(loc) &&
        loc.status === 'attached' &&
        createHash('sha256')
          .update(json(blocks.get(loc.blockId)))
          .digest('hex') !== loc.version
      )
        throw new Error('批注当前引用非法');
    }
  }
  visit(p.units);
  visit(p.notes);
  visit(p.annotationVersions);
  validateRelationGraph(p.graph, catalog(p), []);
}
export function load(directory: string) {
  const p = parse(readPlain(safePath(directory, 'manifest.json'), 32 * 1024 * 1024).toString('utf8')) as Package;
  validate(p);
  for (const r of p.resources) {
    const actual = hashFile(safePath(directory, r.path));
    if (actual.sha256 !== r.sha256 || actual.byteLength !== r.byteLength)
      throw new Error('资源摘要不符（hash mismatch）');
  }
  return p;
}
export function flush(directory: string) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
