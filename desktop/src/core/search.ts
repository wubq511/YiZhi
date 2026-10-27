import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { CourseUnit } from '../shared';
import type { SearchHit, SearchLocation, SearchResults, SearchScope, SearchStatus } from '../search-api';
import { searchScopes } from '../search-api';
import { knowledgeFields, searchText } from '../search-projection';
import { transaction } from './save-store';
import type { PersonalNote } from '../annotation-api';
import type { AgentMessage } from '../agent-api';
import type { Sources } from './sources';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (v: unknown) => JSON.parse(String(v));
interface Entity { scope: SearchScope; id: string; epoch: number; dirty: number; page: number; error: string | null; error_kind: 'index' | 'unreadable' | null; no_text: number }
interface Document extends SearchLocation { text: string }
const DIRECT_ENTITIES = 16, DIRECT_POINTS = 262144;

/** Disposable index only. Authority commits mark it dirty on the same SQLite transaction. */
export class Search {
  private rebuilding = false;
  constructor(private db: DatabaseSync, private unit: (id: string) => CourseUnit | undefined,
    private unitIds: string[], private totalUnits: number, private sources: Sources) {
    db.exec(`CREATE TABLE IF NOT EXISTS search_entities(scope TEXT NOT NULL,id TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,
      dirty INTEGER NOT NULL DEFAULT 1,page INTEGER NOT NULL DEFAULT 0,error TEXT,error_kind TEXT,no_text INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS search_documents(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,entity_id TEXT NOT NULL,epoch INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS search_document_entity ON search_documents(scope,entity_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text,tokenize='trigram case_sensitive 1');
      CREATE TRIGGER IF NOT EXISTS search_document_delete AFTER DELETE ON search_documents BEGIN DELETE FROM search_fts WHERE rowid=old.id; END;`);
    for (const [table, scope] of [['units', 'knowledge'], ['personal_notes', 'notes'], ['agent_messages', 'messages'], ['source_versions', 'sources']]) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = action === 'DELETE' ? 'old' : 'new';
        db.exec(`CREATE TRIGGER IF NOT EXISTS search_${table}_${action} AFTER ${action} ON ${table} BEGIN
          INSERT INTO search_entities(scope,id) VALUES('${scope}',${ref}.id)
          ON CONFLICT(scope,id) DO UPDATE SET epoch=epoch+1,dirty=1,page=0,error=NULL,error_kind=NULL,no_text=0;
        END;`);
      }
      db.exec(`INSERT OR IGNORE INTO search_entities(scope,id) SELECT '${scope}',id FROM ${table}`);
    }
    for (const id of unitIds) db.prepare("INSERT OR IGNORE INTO search_entities(scope,id) VALUES('knowledge',?)").run(id);
  }
  /** Newly registered authority rows are already dirtied by the existing SQLite triggers. */
  includeImportedUnits(ids: string[], totalUnits: number) {
    this.unitIds = [...new Set([...this.unitIds, ...ids])];
    this.totalUnits = totalUnits;
  }
  private entity(scope: SearchScope, id: string): Entity | undefined {
    return this.db.prepare('SELECT * FROM search_entities WHERE scope=? AND id=?').get(scope, id) as unknown as Entity | undefined;
  }
  private documents(entity: Entity): Document[] {
    const common = { scope: entity.scope, entityId: entity.id, disclosure: [] as string[] };
    if (entity.scope === 'knowledge') {
      const unit = this.unit(entity.id); if (!unit) return [];
      const formal = this.db.prepare('SELECT revision FROM units WHERE id=?').get(entity.id);
      const version = `${formal ? `revision-${formal.revision}` : 'fixture'}:${hash(unit)}`;
      return knowledgeFields(unit).map(f => ({ ...common, ...f, version, unitId: unit.id, title: unit.name }));
    }
    if (entity.scope === 'notes') {
      const row = this.db.prepare('SELECT value FROM personal_notes WHERE id=?').get(entity.id); if (!row) return [];
      const note = parse(row.value).note as PersonalNote;
      return [{ ...common, version: String(note.version), title: '个人笔记', noteId: note.id, unitId: note.original.unitId,
        field: 'text', text: note.text }];
    }
    if (entity.scope === 'messages') {
      const row = this.db.prepare('SELECT m.payload,t.conversation_id,c.title FROM agent_messages m JOIN agent_tasks t ON t.id=m.task_id JOIN agent_conversations c ON c.id=t.conversation_id WHERE m.id=?').get(entity.id);
      if (!row) return [];
      const message = parse(row.payload) as AgentMessage;
      return [{ ...common, version: hash(message), title: String(row.title), field: 'text', text: message.text,
        conversationId: String(row.conversation_id), messageId: message.id }];
    }
    return [];
  }
  private async sourceDocument(entity: Entity, pdfPageIndex: number): Promise<Document> {
    const version = this.sources.version(entity.id);
    const page = await this.sources.page({ sessionId: '', versionId: entity.id, pdfPageIndex });
    return { scope: 'sources', entityId: entity.id, version: version.sha256, title: version.title, field: `page.${pdfPageIndex}`,
      text: page.projection.text, disclosure: [], sourceId: version.sourceId, versionId: version.versionId, pdfPageIndex,
      projectionId: page.projection.id, convention: page.projection.convention, extractor: page.projection.extractor };
  }
  private sourceValid(id: string) { this.sources.readResource({ sessionId: '', versionId: id, begin: 0, end: 1 }); }
  private problem(entity: Entity, error: unknown, kind: 'unreadable' | 'index' = 'unreadable') {
    if (this.entity(entity.scope, entity.id)?.epoch !== entity.epoch) return;
    this.db.prepare('UPDATE search_entities SET error=?,error_kind=?,dirty=1 WHERE scope=? AND id=?').run((error as Error).message, kind, entity.scope, entity.id);
  }
  private title(scope: SearchScope, id: string) {
    try { return scope === 'sources' ? this.sources.version(id).title : this.documents(this.entity(scope, id)!)[0]?.title ?? id; }
    catch { return id; }
  }
  status(): SearchStatus {
    return { pending: Number(this.db.prepare("SELECT COUNT(*) AS n FROM search_entities WHERE dirty=1 AND error_kind IS NOT 'unreadable'").get()!.n),
      indexed: Number(this.db.prepare('SELECT COUNT(*) AS n FROM search_entities WHERE dirty=0 AND error IS NULL').get()!.n),
      unreadable: this.db.prepare("SELECT * FROM search_entities WHERE error_kind='unreadable'").all().map(r => ({ scope: r.scope as SearchScope, entityId: String(r.id), title: this.title(r.scope as SearchScope, String(r.id)), reason: String(r.error) })),
      indexErrors: this.db.prepare("SELECT * FROM search_entities WHERE error_kind='index'").all().map(r => ({ scope: r.scope as SearchScope, entityId: String(r.id), title: this.title(r.scope as SearchScope, String(r.id)), reason: String(r.error) })),
      noText: this.db.prepare('SELECT * FROM search_entities WHERE no_text>0 AND error IS NULL').all().map(r => ({ scope: r.scope as SearchScope, entityId: String(r.id), title: this.title(r.scope as SearchScope, String(r.id)), reason: `${r.no_text} 页无可靠文字层，仍可查看原页` })), unavailable: Math.max(0, this.totalUnits - this.unitIds.length) };
  }
  private match(doc: Document, query: string): SearchHit | undefined {
    const index = searchText(doc.text).indexOf(searchText(query)); if (index < 0) return;
    const start = Array.from(doc.text.slice(0, index)).length, end = start + Array.from(query).length;
    const points = Array.from(doc.text);
    return { ...doc, start, end, quote: points.slice(start, end).join(''), excerpt: points.slice(Math.max(0, start - 36), end + 64).join('') };
  }
  private index(entity: Entity, docs: Document[]) {
    transaction(this.db, () => {
      if (this.entity(entity.scope, entity.id)?.epoch !== entity.epoch) return;
      this.db.prepare('DELETE FROM search_documents WHERE scope=? AND entity_id=?').run(entity.scope, entity.id);
      for (const doc of docs) this.insert(entity, doc);
      this.db.prepare('UPDATE search_entities SET dirty=0,error=NULL,error_kind=NULL WHERE scope=? AND id=?').run(entity.scope, entity.id);
    });
  }
  private insert(entity: Entity, doc: Document) {
    const result = this.db.prepare('INSERT INTO search_documents(scope,entity_id,epoch,payload) VALUES(?,?,?,?)').run(entity.scope, entity.id, entity.epoch, JSON.stringify(doc));
    this.db.prepare('INSERT INTO search_fts(rowid,text) VALUES(?,?)').run(result.lastInsertRowid, searchText(doc.text));
  }
  async rebuild(p: { batchSize?: number; reset?: boolean; retryErrors?: boolean }): Promise<SearchStatus> {
    if (this.rebuilding) throw new Error('索引批次正在进行，请稍后重试');
    this.rebuilding = true;
    try { return await this.rebuildBatch(p); } finally { this.rebuilding = false; }
  }
  private async rebuildBatch(p: { batchSize?: number; reset?: boolean; retryErrors?: boolean }): Promise<SearchStatus> {
    const batch = p.batchSize ?? 4;
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > 8) throw new Error('索引批次应为 1–8 个对象');
    if (p.reset) transaction(this.db, () => {
      this.db.exec('DELETE FROM search_documents; UPDATE search_entities SET dirty=1,epoch=epoch+1,page=0,error=NULL,error_kind=NULL,no_text=0');
    });
    if (p.retryErrors) this.db.exec('UPDATE search_entities SET dirty=1,epoch=epoch+1,page=0,error=NULL,error_kind=NULL,no_text=0 WHERE error IS NOT NULL');
    const entities = this.db.prepare('SELECT * FROM search_entities WHERE dirty=1 AND error IS NULL ORDER BY rowid LIMIT ?').all(batch) as unknown as Entity[];
    for (const entity of entities) {
      try {
        if (entity.scope !== 'sources') {
          const docs = this.documents(entity);
          try { this.index(entity, docs); } catch (error) { this.problem(entity, error, 'index'); }
          continue;
        }
        const version = this.sources.version(entity.id), page = entity.page;
        const doc = await this.sourceDocument(entity, page);
        try { transaction(this.db, () => {
          if (this.entity(entity.scope, entity.id)?.epoch !== entity.epoch || this.entity(entity.scope, entity.id)?.page !== page) return;
          if (!page) this.db.prepare('DELETE FROM search_documents WHERE scope=? AND entity_id=?').run(entity.scope, entity.id);
          this.insert(entity, doc);
          this.db.prepare('UPDATE search_entities SET page=?,dirty=?,no_text=no_text+? WHERE scope=? AND id=?').run(page + 1,
            page + 1 < Math.max(1, version.pdfPages) ? 1 : 0, doc.text.trim() ? 0 : 1, entity.scope, entity.id);
        }); } catch (error) { this.problem(entity, error, 'index'); }
      } catch (error) { this.problem(entity, error); }
    }
    return this.status();
  }
  async locate(hit: SearchHit): Promise<SearchHit> {
    if (!hit || !searchScopes.includes(hit.scope) || typeof hit.entityId !== 'string') throw new Error('搜索定位无效');
    const entity = this.entity(hit.scope, hit.entityId);
    let candidates: Document[] = [];
    if (entity?.scope === 'sources') {
      try { candidates = [await this.sourceDocument(entity, hit.pdfPageIndex!)]; }
      catch (error) { this.problem(entity, error); throw error; }
    } else if (entity) candidates = this.documents(entity);
    const doc = candidates.find(d => d.field === hit.field && d.blockId === hit.blockId && d.version === hit.version && d.projectionId === hit.projectionId);
    if (!doc || !Number.isSafeInteger(hit.start) || !Number.isSafeInteger(hit.end) || hit.start < 0 || hit.end <= hit.start || hit.end > Array.from(doc.text).length ||
      Array.from(doc.text).slice(hit.start, hit.end).join('') !== hit.quote) throw new Error('内容版本已变化，请重新搜索');
    const verified = this.match(doc, hit.quote);
    if (!verified) throw new Error('内容版本已变化，请重新搜索');
    return { ...doc, start: hit.start, end: hit.end, quote: hit.quote, excerpt: Array.from(doc.text).slice(Math.max(0, hit.start - 36), hit.end + 64).join('') };
  }
  async query(request: { query: string; scopes?: SearchScope[]; limit?: number }): Promise<SearchResults> {
    const query = request.query;
    if (typeof query !== 'string' || !query.trim() || Array.from(query).length > 256) throw new Error('请输入 1–256 字的查找内容');
    const scopes = request.scopes ?? searchScopes;
    if (!Array.isArray(scopes) || scopes.some(s => !searchScopes.includes(s))) throw new Error('搜索范围无效');
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('搜索结果数量无效');
    const mode = Array.from(query).length >= 3 && !/[^\p{L}\p{N}\s]/u.test(query) ? 'trigram' : 'literal';
    const hits: SearchHit[] = []; let directChecked = 0, points = 0;
    const placeholders = scopes.map(() => '?').join(',');
    if (!scopes.length) return { hits, status: this.status(), mode, incomplete: false, directChecked, truncated: false };
    const filter = mode === 'trigram' ? 'search_fts MATCH ?' : 'instr(search_fts.text,?)>0';
    const needle = mode === 'trigram' ? '"' + searchText(query).replace(/"/g, '""') + '"' : searchText(query);
    const rows = this.db.prepare(`SELECT d.payload FROM search_fts JOIN search_documents d ON d.id=search_fts.rowid
      JOIN search_entities e ON e.scope=d.scope AND e.id=d.entity_id AND e.epoch=d.epoch
      WHERE e.error_kind IS NOT 'unreadable' AND ${filter} AND d.scope IN (${placeholders}) ORDER BY d.id LIMIT ?`).all(needle, ...scopes, limit + 1);
    const verifiedSources = new Set<string>();
    for (const row of rows) {
      const doc = parse(row.payload) as Document;
      if (doc.scope === 'sources' && !verifiedSources.has(doc.entityId)) {
        try { this.sourceValid(doc.entityId); verifiedSources.add(doc.entityId); }
        catch (error) { this.problem(this.entity('sources', doc.entityId)!, error); continue; }
      }
      if (this.entity(doc.scope, doc.entityId)?.error_kind === 'unreadable') continue;
      const hit = this.match(doc, query); if (hit) hits.push(hit);
    }
    const pending = this.db.prepare(`SELECT * FROM search_entities WHERE dirty=1 AND error_kind IS NOT 'unreadable' AND scope IN (${placeholders}) ORDER BY rowid`).all(...scopes) as unknown as Entity[];
    let sourcePages = 0, sourceIncomplete = false;
    for (const entity of pending.slice(0, DIRECT_ENTITIES)) {
      let docs: Document[];
      try {
        if (entity.scope === 'sources') {
          const count = Math.max(1, this.sources.version(entity.id).pdfPages);
          docs = [];
          for (let page = entity.page; page < count && sourcePages < 2; page++) { sourcePages++; docs.push(await this.sourceDocument(entity, page)); }
          sourceIncomplete ||= entity.page + docs.length < count;
        } else docs = this.documents(entity);
      } catch (error) { this.problem(entity, error); directChecked++; continue; }
      directChecked++;
      for (const doc of docs) {
        points += Array.from(doc.text).length; if (points > DIRECT_POINTS) break;
        const hit = this.match(doc, query);
        if (hit && !hits.some(h => h.scope === hit.scope && h.entityId === hit.entityId && h.field === hit.field && h.blockId === hit.blockId)) hits.push(hit);
      }
      if (points > DIRECT_POINTS) break;
    }
    // A source read yielded to saves; recheck every previously collected hit against the authority.
    const current = new Map<string, Document[]>();
    const fresh = hits.filter(hit => {
      const key = `${hit.scope}:${hit.entityId}`, entity = this.entity(hit.scope, hit.entityId);
      if (!entity || entity.error_kind === 'unreadable') return false;
      if (hit.scope === 'sources') {
        try { this.sourceValid(hit.entityId); return this.sources.version(hit.entityId).sha256 === hit.version; }
        catch (error) { this.problem(entity, error); return false; }
      }
      if (!current.has(key)) current.set(key, this.documents(entity));
      return current.get(key)!.some(d => d.version === hit.version && d.field === hit.field && d.blockId === hit.blockId);
    });
    return { hits: fresh.slice(0, limit), status: this.status(), mode,
      incomplete: fresh.length !== hits.length || sourceIncomplete || points > DIRECT_POINTS || pending.length > directChecked,
      directChecked, truncated: fresh.length > limit };
  }
  async dispatch(action: string, p: any) {
    if (action === 'search:query') return this.query(p);
    if (action === 'search:status') return this.status();
    if (action === 'search:rebuild') return this.rebuild(p);
    if (action === 'search:locate') return this.locate(p.hit);
    throw new Error('未知搜索接口');
  }
}
