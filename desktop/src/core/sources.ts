import { randomUUID, createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { constants, openSync, closeSync, readSync, lstatSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportSource, SourceReceipt, SourceVersion, ResourceRange, SourcePage, SourcePageRequest, SourceCommand, CiteSource, SourceCitation, PrintedPage, UpdateIntent, SourceReadingContext } from '../sources-api';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { CourseUnit, ReadingBlock } from '../shared';
import type { RelationSource } from '../relation-api';
import { appendEvent, transaction } from './save-store';
import { hashFile, MAX_RESOURCE_READ, publishResource } from './immutable-resource';
import { withPdf } from './source-pdf';
import { observation } from '../acceptance-observation';

const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200;
export class Sources {
  private verified = new Map<string, string>();
  private verifiedObservation = observation.resource('sources.verifiedCacheEntries');
  constructor(private db: DatabaseSync, private directory: string, private unit?: (id: string) => CourseUnit | undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS source_versions(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_imports(id TEXT PRIMARY KEY, digest TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_page_maps(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES source_versions(id), page_index INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_citations(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES source_versions(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_intents(id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES source_versions(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_reading(id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL);`);
  }
  private generation() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value); }
  /** Preserve the common logical-operation namespace across student, producer, relation and source writes. */
  fenceOperation(action: string, operationId: unknown) {
    if (typeof operationId !== 'string') return;
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='parse_operations'").get() &&
      !action.startsWith('parsing:') && this.db.prepare('SELECT 1 FROM parse_operations WHERE id=?').get(operationId) &&
      ['sources:write', 'save', 'commitEdit', 'commands:commit', 'relations:commit'].includes(action)) throw new Error('操作身份已用于解析');
    if (action === 'sources:write') {
      if (this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(operationId) || this.db.prepare('SELECT 1 FROM cg_candidates WHERE id=?').get(operationId))
        throw new Error('操作身份已用于其他正式修改');
    } else if (['save', 'commitEdit', 'commands:commit', 'relations:commit'].includes(action)) {
      if (this.db.prepare('SELECT 1 FROM source_operations WHERE id=?').get(operationId) || this.db.prepare('SELECT 1 FROM source_imports WHERE id=?').get(operationId))
        throw new Error('操作身份已用于来源修改');
    }
  }
  list(sessionId: string) { const reading = this.db.prepare('SELECT session_id,seq FROM source_reading WHERE id=1').get();
    return { generation: this.generation(), readingSeq: reading?.session_id === sessionId ? Number(reading.seq) : 0,
    versions: this.db.prepare('SELECT payload FROM source_versions ORDER BY rowid').all().map(row => JSON.parse(String(row.payload)) as SourceVersion),
    intents: this.db.prepare('SELECT payload FROM source_intents ORDER BY rowid').all().map(row => JSON.parse(String(row.payload)) as UpdateIntent) }; }
  /** A live projection of the actual registry, not another writable source catalog.
   * Seed entries retain their metadata identity; this does not claim their original files are copied.
   */
  relationCatalog(seed: RelationSource[]): RelationSource[] {
    const catalog = structuredClone(seed);
    for (const version of this.list('').versions) {
      let source = catalog.find(item => item.id === version.sourceId);
      if (!source) { source = { id: version.sourceId, title: version.title, versions: [] }; catalog.push(source); }
      if (!source.versions.some(item => item.id === version.versionId)) source.versions.push({ id: version.versionId, ...(version.pdfPages ? { totalPages: version.pdfPages } : {}) });
    }
    return catalog;
  }
  private eligible(command: SourceCommand) {
    if (!id(command.operationId)) throw new Error('无效的来源操作身份');
    if (command.generation !== this.generation()) throw new Error('课程代际已变化，请重新读取');
  }
  private async operation<T>(kind: string, command: SourceCommand, prepare: () => Promise<() => T>): Promise<T> {
    this.fenceOperation('sources:write', command.operationId);
    if (!id(command.operationId)) throw new Error('无效的来源操作身份');
    const { sessionId: _, ...identity } = command;
    const digest = createHash('sha256').update(JSON.stringify([kind, identity])).digest('hex');
    const old = this.db.prepare('SELECT * FROM source_operations WHERE id=?').get(command.operationId);
    if (old) {
      if (old.digest !== digest) throw new Error('同一操作不能换用不同内容');
      return JSON.parse(String(old.receipt));
    }
    if (this.db.prepare('SELECT 1 FROM source_imports WHERE id=?').get(command.operationId)) throw new Error('同一操作不能换用不同内容');
    this.eligible(command);
    const commit = await prepare();
    return transaction(this.db, () => {
      this.eligible(command);
      const result = commit();
      appendEvent(this.db, { type: 'source.changed', kind, operationId: command.operationId });
      this.db.prepare('INSERT INTO source_operations VALUES (?, ?, ?)').run(command.operationId, digest, JSON.stringify(result));
      return result;
    });
  }
  version(versionId: string): SourceVersion {
    if (!id(versionId)) throw new Error('来源版本身份无效');
    const row = this.db.prepare('SELECT payload FROM source_versions WHERE id=?').get(versionId);
    if (!row) throw new Error('来源版本未登记');
    const version = JSON.parse(String(row.payload)) as SourceVersion;
    if (!/^[a-f0-9]{64}$/.test(version.sha256)) throw new Error('来源资源身份损坏');
    return version;
  }
  async importFile(command: ImportSource): Promise<SourceReceipt> {
    this.fenceOperation('sources:write', command.operationId);
    if (!id(command.operationId) || typeof command.path !== 'string' || !id(command.title) ||
      (command.sourceId !== undefined && !id(command.sourceId))) throw new Error('来源导入请求无效');
    const { sessionId: _, ...identity } = command;
    const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const old = this.db.prepare('SELECT * FROM source_operations WHERE id=?').get(command.operationId);
    if (old) {
      if (old.digest !== digest) throw new Error('同一操作不能换用不同内容');
      return JSON.parse(String(old.receipt));
    }
    if (command.generation !== this.generation()) throw new Error('课程代际已变化，请重新读取');
    if (command.sourceId && !this.db.prepare('SELECT 1 FROM source_versions WHERE source_id=?').get(command.sourceId))
      throw new Error('来源身份不存在');
    const staged = this.db.prepare('SELECT * FROM source_imports WHERE id=?').get(command.operationId);
    let version: SourceVersion;
    if (staged) {
      if (staged.digest !== digest) throw new Error('同一操作不能换用不同内容');
      version = JSON.parse(String(staged.payload));
      this.verifiedPath(version);
    } else {
      let pdfPages = 0;
      const mediaType = /\.pdf$/i.test(command.path) ? 'application/pdf' : /\.png$/i.test(command.path) ? 'image/png' : /\.jpe?g$/i.test(command.path) ? 'image/jpeg' : undefined;
      if (!mediaType) throw new Error('当前支持 PDF、PNG 和 JPEG 原件');
      const resource = await publishResource(join(this.directory, 'resources'), command.path, async path => {
        if (mediaType === 'application/pdf') await withPdf(path, async doc => {
          if (!doc.numPages) throw new Error('PDF 没有可读页面');
          pdfPages = doc.numPages;
          await doc.getPage(1); await doc.getPage(doc.numPages);
        });
        else {
          const { loadImage } = await import('@napi-rs/canvas');
          const image = await loadImage(path);
          if (!image.width || !image.height) throw new Error('图片不可读');
        }
      });
      version = { sourceId: command.sourceId ?? randomUUID(), versionId: randomUUID(),
        sha256: resource.sha256, byteLength: resource.byteLength, mediaType, pdfPages,
        originalName: basename(command.path), title: command.title, importedAt: new Date().toISOString() };
      // A validated, complete candidate is durable before formal registration. A retry must
      // retain the selected bytes even if the external original is later edited or removed.
      transaction(this.db, () => {
        this.eligible(command);
        this.db.prepare('INSERT INTO source_imports VALUES (?, ?, ?)').run(command.operationId, digest, JSON.stringify(version));
      });
    }
    return transaction(this.db, () => {
      if (command.generation !== this.generation()) throw new Error('课程代际已变化，请重新读取');
      this.db.prepare('INSERT INTO source_versions VALUES (?, ?, ?)').run(version.versionId, version.sourceId, JSON.stringify(version));
      const cursor = appendEvent(this.db, { type: 'source.registered', versionId: version.versionId, sourceId: version.sourceId });
      const receipt = { operationId: command.operationId, generation: command.generation, cursor, version };
      this.db.prepare('INSERT INTO source_operations VALUES (?, ?, ?)').run(command.operationId, digest, JSON.stringify(receipt));
      this.db.prepare('DELETE FROM source_imports WHERE id=?').run(command.operationId);
      return receipt;
    });
  }
  private verifiedPath(version: SourceVersion) {
    const directory = join(this.directory, 'resources');
    if (lstatSync(directory).isSymbolicLink()) throw new Error('来源资源目录无效');
    const path = join(directory, version.sha256);
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('来源原件副本缺失，请从原件修复此版本'); throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('来源资源无效，请从原件重试');
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (this.verified.get(version.sha256) !== signature) {
      const actual = hashFile(path);
      if (actual.sha256 !== version.sha256 || actual.byteLength !== version.byteLength) throw new Error('来源资源损坏，请从原件重试');
      this.verified.delete(version.sha256); this.verified.set(version.sha256, signature);
      if (this.verified.size > 8) this.verified.delete(this.verified.keys().next().value!);
    }
    this.verifiedObservation.set(this.verified.size);
    return path;
  }
  repairFile(command: SourceCommand & { versionId: string; path: string }) {
    return this.operation('repair', command, async () => {
      const version = this.version(command.versionId);
      await publishResource(join(this.directory, 'resources'), command.path, async () => {}, version.sha256);
      this.verified.delete(version.sha256); this.verifiedPath(version);
      return () => version;
    });
  }
  private pageIndex(version: SourceVersion, index: number) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= (version.mediaType === 'application/pdf' ? version.pdfPages : 1))
      throw new Error('PDF 页索引超出来源范围');
  }
  async page(request: SourcePageRequest): Promise<SourcePage> {
    const version = this.version(request.versionId); this.pageIndex(version, request.pdfPageIndex);
    const path = this.verifiedPath(version);
    let view: number[], rotation = 0, extractor: string, text = '';
    const items: SourcePage['projection']['items'] = [];
    if (version.mediaType === 'application/pdf') {
      const result = await withPdf(path, async document => {
        const page = await document.getPage(request.pdfPageIndex + 1);
        const content = await page.getTextContent();
        let offset = 0;
        for (const item of content.items.filter((item): item is TextItem => 'str' in item)) {
          const length = Array.from(item.str).length;
          items.push({ text: item.str, start: offset, end: offset + length });
          text += item.str; offset += length;
          if (item.hasEOL) { text += '\n'; offset++; }
        }
        // The last line terminator is layout trivia, not a selected character.
        text = text.replace(/\n$/, '');
        return { view: page.view, rotation: page.rotate };
      });
      view = result.view; rotation = result.rotation;
      extractor = `pdfjs-${(await import('pdfjs-dist/legacy/build/pdf.mjs')).version}`;
    } else {
      const { loadImage } = await import('@napi-rs/canvas');
      const image = await loadImage(path); view = [0, 0, image.width, image.height]; extractor = 'image/no-ocr-v1';
    }
    const convention = 'pdfjs-text-items-eol/codepoint-v1' as const;
    const projectionId = createHash('sha256').update(JSON.stringify([version.sha256, request.pdfPageIndex, extractor, convention, text, items])).digest('hex');
    const mapped = this.db.prepare('SELECT payload FROM source_page_maps WHERE version_id=? AND page_index=? ORDER BY rowid DESC LIMIT 1').get(version.versionId, request.pdfPageIndex);
    return { versionId: version.versionId, pdfPageIndex: request.pdfPageIndex, view, rotation,
      printedPage: mapped ? JSON.parse(String(mapped.payload)) : null,
      projection: { id: projectionId, convention, extractor, text, items } };
  }
  mapPrintedPage(command: SourceCommand & { versionId: string; pdfPageIndex: number; printedPage: string }) {
    return this.operation('page-map', command, async () => {
      const version = this.version(command.versionId); this.pageIndex(version, command.pdfPageIndex);
      if (!id(command.printedPage) || !command.printedPage.trim()) throw new Error('请填写已核对的印刷页');
      const result: PrintedPage = { id: randomUUID(), versionId: version.versionId, pdfPageIndex: command.pdfPageIndex,
        label: command.printedPage.trim(), verifiedBy: 'student', verifiedAt: new Date().toISOString() };
      return () => { this.db.prepare('INSERT INTO source_page_maps VALUES (?, ?, ?, ?)').run(result.id, version.versionId, command.pdfPageIndex, JSON.stringify(result)); return result; };
    });
  }
  locatePrintedPage(request: { versionId: string; printedPage: string }): PrintedPage[] {
    this.version(request.versionId);
    if (!id(request.printedPage)) throw new Error('印刷页无效');
    return this.db.prepare(`SELECT payload FROM source_page_maps WHERE rowid IN
      (SELECT MAX(rowid) FROM source_page_maps WHERE version_id=? GROUP BY page_index) ORDER BY page_index`)
      .all(request.versionId).map(row => JSON.parse(String(row.payload)) as PrintedPage).filter(map => map.label === request.printedPage.trim());
  }
  cite(command: CiteSource) {
    return this.operation('citation', command, async () => {
      const version = this.version(command.versionId), page = await this.page(command);
      const hasRange = command.start !== undefined || command.end !== undefined;
      if (hasRange && (command.projectionId !== page.projection.id || !Number.isSafeInteger(command.start) ||
        !Number.isSafeInteger(command.end) || command.start! < 0 || command.end! <= command.start! || command.end! > Array.from(page.projection.text).length))
        throw new Error('来源文本投影或选段范围无效，请重新选取');
      const region = command.region;
      if (region && (![region.x0, region.y0, region.x1, region.y1].every(Number.isFinite) ||
        region.x0 < page.view[0] || region.y0 < page.view[1] || region.x1 > page.view[2] || region.y1 > page.view[3] || region.x0 >= region.x1 || region.y0 >= region.y1))
        throw new Error('来源选区超出实际页面');
      const { id: projectionId, convention, extractor } = page.projection;
      if (command.target) {
        const target = command.target, unit = this.unit?.(target.unitId) ?? (() => {
          const row = this.db.prepare('SELECT payload FROM units WHERE id=?').get(target.unitId);
          return row ? JSON.parse(String(row.payload)) as CourseUnit : undefined;
        })();
        const find = (blocks: ReadingBlock[]): boolean => blocks.some(block => block.id === target.blockId || find(block.children ?? []));
        if (!unit || (target.blockId !== undefined && !find(unit.reading.blocks))) throw new Error('来源引用目标不存在');
      }
      const citation: SourceCitation = { id: randomUUID(), versionId: version.versionId, sourceId: version.sourceId,
        sha256: version.sha256, pdfPageIndex: command.pdfPageIndex, printedPage: page.printedPage,
        projection: { id: projectionId, convention, extractor },
        quote: hasRange ? Array.from(page.projection.text).slice(command.start, command.end).join('') : null,
        start: hasRange ? command.start! : null, end: hasRange ? command.end! : null,
        textStatus: hasRange ? 'selected-text' : page.projection.text.length ? 'page-or-region' : 'no-text-layer',
        region: region ?? null, coordinateSpace: version.mediaType === 'application/pdf' ? 'pdf-user-space' : 'image-pixels-top-left', createdAt: new Date().toISOString(),
        ...(command.target ? { target: command.target } : {}) };
      return () => { this.db.prepare('INSERT INTO source_citations VALUES (?, ?, ?)').run(citation.id, version.versionId, JSON.stringify(citation)); return citation; };
    });
  }
  setUpdateIntent(command: SourceCommand & { versionId: string; decision: 'update' | 'defer' }) {
    return this.operation('update-intent', command, async () => {
      this.version(command.versionId);
      if (!['update', 'defer'].includes(command.decision)) throw new Error('资料更新意图无效');
      const intent: UpdateIntent = { id: randomUUID(), generation: command.generation, versionId: command.versionId, decision: command.decision, createdAt: new Date().toISOString() };
      return () => { this.db.prepare('INSERT INTO source_intents VALUES (?, ?, ?)').run(intent.id, intent.versionId, JSON.stringify(intent)); return intent; };
    });
  }
  context(): SourceReadingContext | null {
    const row = this.db.prepare('SELECT payload FROM source_reading WHERE id=1').get();
    return row ? JSON.parse(String(row.payload)) : null;
  }
  saveContext(request: { sessionId: string; generation: number; seq: number; state: SourceReadingContext }) {
    if (request.generation !== this.generation()) throw new Error('课程代际已变化');
    const state = request.state, version = this.version(state.versionId); this.pageIndex(version, state.pdfPageIndex);
    if (typeof state.open !== 'boolean' || !Number.isFinite(state.scrollTop) || state.scrollTop < 0 ||
      !Number.isFinite(state.scrollLeft) || state.scrollLeft < 0 || !Number.isFinite(state.scale) || state.scale < 0.25 || state.scale > 3 ||
      !Number.isSafeInteger(request.seq) || request.seq < 1) throw new Error('原文阅读状态无效');
    transaction(this.db, () => {
      const old = this.db.prepare('SELECT * FROM source_reading WHERE id=1').get();
      if (old?.session_id === request.sessionId && request.seq <= Number(old.seq)) {
        if (request.seq === Number(old.seq) && JSON.stringify(state) === old.payload) return;
        throw new Error('原文阅读状态序号已过期');
      }
      this.db.prepare('INSERT OR REPLACE INTO source_reading VALUES (1,?,?,?)').run(request.sessionId, request.seq, JSON.stringify(state));
    });
  }
  readResource(request: ResourceRange) {
    const version = this.version(request.versionId);
    if (!Number.isSafeInteger(request.begin) || !Number.isSafeInteger(request.end) || request.begin < 0 ||
      request.end <= request.begin || request.end > version.byteLength || request.end - request.begin > MAX_RESOURCE_READ)
      throw new Error('资源读取范围无效或超过上限');
    const path = this.verifiedPath(version), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = new Uint8Array(request.end - request.begin);
      const n = readSync(fd, bytes, 0, bytes.length, request.begin);
      if (n !== bytes.length) throw new Error('来源资源读取不完整');
      return { bytes, total: version.byteLength, mediaType: version.mediaType };
    } finally { closeSync(fd); }
  }
  citations(): SourceCitation[] { return this.db.prepare('SELECT payload FROM source_citations ORDER BY rowid').all().map(row => JSON.parse(String(row.payload))); }
  async dispatch(action: string, payload: any) {
    if (action === 'sources:importFile') return this.importFile(payload);
    if (action === 'sources:list') return this.list(payload.sessionId);
    if (action === 'sources:repairFile') return this.repairFile(payload);
    if (action === 'sources:getVersion') return this.version(payload.versionId);
    if (action === 'sources:page') return this.page(payload);
    if (action === 'sources:mapPrintedPage') return this.mapPrintedPage(payload);
    if (action === 'sources:locatePrintedPage') return this.locatePrintedPage(payload);
    if (action === 'sources:cite') return this.cite(payload);
    if (action === 'sources:citations') return this.citations();
    if (action === 'sources:setUpdateIntent') return this.setUpdateIntent(payload);
    if (action === 'sources:query') {
      const row = this.db.prepare('SELECT receipt FROM source_operations WHERE id=?').get(payload.operationId);
      return row ? JSON.parse(String(row.receipt)) : null;
    }
    if (action === 'sources:context') return this.context();
    if (action === 'sources:saveContext') return this.saveContext(payload);
    if (action === 'sources:readResource') return this.readResource(payload);
    throw new Error('未知来源命令');
  }
}
