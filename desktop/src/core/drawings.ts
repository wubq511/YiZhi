import { layoutGraph, saveLayout } from './local-layout';
import type { CourseGraph } from '../shared';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { DrawingApply, DrawingValue, PersonalDrawing } from '../drawing-api';
import type { Annotations } from './annotations';
import type { CourseUnit, ReadingBlock } from '../shared';
import { equal } from '../editor-api';
import { transaction, appendEvent } from './save-store';
const parse = (v: unknown) => JSON.parse(String(v));
const json = JSON.stringify;
export class Drawings {
  constructor(private db: DatabaseSync, private readUnit: (id: string) => CourseUnit | undefined, private annotations: Annotations, private graph: CourseGraph) {
    db.exec(`CREATE TABLE IF NOT EXISTS personal_drawings(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drawing_operations(id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS placement_history(seq INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drawing_history(seq INTEGER PRIMARY KEY, value TEXT NOT NULL);`);
  }
  private target(value: DrawingValue): ReadingBlock | CourseUnit | undefined {
    const a = value.anchor;
    if (a.space !== 'object' && a.space !== 'image') return;
    const unit = this.readUnit(a.unitId);
    if (!a.blockId) return a.space === 'object' ? unit : undefined;
    const find = (blocks: ReadingBlock[]): ReadingBlock | undefined => { for (const b of blocks) { if (b.id === a.blockId) return b; const child = find(b.children ?? []); if (child) return child; } };
    return unit && find(unit.reading.blocks);
  }
  private visible(record: PersonalDrawing): PersonalDrawing {
    const v = record.value;
    const note = v?.anchor.space === 'text' && this.annotations.dispatch('annotations:list', {}).find((n: any) => n.id === (v.anchor as { noteId: string }).noteId);
    return { ...record, status: !v ? 'deleted' : v.anchor.space === 'text' ? note?.current.status ?? 'orphan' : v.anchor.space === 'board' || this.target(v) ? 'attached' : 'orphan' };
  }
  private validate(value: DrawingValue, old?: PersonalDrawing) {
    if (!value || !['rectangle','ellipse','arrow','line','wave','highlighter'].includes(value.kind) || !value.anchor ||
      !['board','object','image','text'].includes(value.anchor.space) || !value.geometry ||
      !['x','y','width','height'].every(key => Number.isFinite(value.geometry[key as keyof typeof value.geometry]) && Math.abs(value.geometry[key as keyof typeof value.geometry]) <= 1e7)) throw new Error('无效的图形几何');
    const g = value.geometry, a = value.anchor;
    if (a.space === 'image') {
      if (g.x < 0 || g.y < 0 || g.x > 1 || g.y > 1 || g.x + g.width < 0 || g.x + g.width > 1 || g.y + g.height < 0 || g.y + g.height > 1 || Math.abs(g.width) + Math.abs(g.height) < .001) throw new Error('无效的相对几何');
    } else if (Math.abs(g.width) + Math.abs(g.height) < 1) throw new Error('无效的图形几何');
    if (a.space === 'text') {
      if (value.kind !== 'highlighter' || !this.annotations.dispatch('annotations:list', {}).some((n: any) => n.id === a.noteId)) throw new Error('文字标注范围不存在');
    } else if (a.space !== 'board') {
      const target = this.target(value);
      if (old && [old.value?.anchor,old.original.anchor].some(anchor=>equal(anchor,a))) return;
      if (!target || (a.space === 'image' && (!('kind' in target) || target.kind !== 'figure')) || ('block' in a && a.block && !equal(a.block, target))) throw new Error('标注目标已变化，请重新选择');
      if (a.blockId) a.block = structuredClone(target as ReadingBlock);
    }
  }
  fence(action: string, id: string) {
    if (!action.startsWith('drawings:') && this.db.prepare('SELECT 1 FROM drawing_operations WHERE id=?').get(id)) throw new Error('操作身份已用于个人图形');
    if (action.startsWith('drawings:') && (this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(id) || this.db.prepare('SELECT 1 FROM cg_candidates WHERE id=?').get(id))) throw new Error('操作身份已用于正文');
  }
  private place(request: any) {
    if(typeof request.operationId!=='string'||!request.operationId.length||request.operationId.length>160||request.before?.unitId!==request.after?.unitId) throw new Error('无效的布局操作');
    const {sessionId:_,...body}=request,digest=createHash('sha256').update(json({action:'place',...body})).digest('hex');
    return transaction(this.db,()=>{
      const prior=this.db.prepare('SELECT * FROM drawing_operations WHERE id=?').get(request.operationId);
      if(prior){if(prior.digest!==digest) throw new Error('同一操作不能换用不同布局');return parse(prior.result);}
      const current=layoutGraph(this.db,this.graph).layout.nodes.find(n=>n.unitId===request.before.unitId);
      if(!current||!['x','y','width'].every(key=>current[key as keyof typeof current]===request.before[key])) throw new Error('布局已变化，请重新读取后继续');
      const beforeVersion=Number(this.db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(request.before.unitId)?.version??0);
      saveLayout(this.db,this.graph,[request.after]);
      const result={operationId:request.operationId,before:request.before,after:request.after,beforeVersion,afterVersion:Number(this.db.prepare('SELECT version FROM layout_versions WHERE unit_id=?').get(request.after.unitId)?.version??0),committedAt:new Date().toISOString(),actor:'student' as const};
      this.db.prepare('INSERT INTO placement_history(value) VALUES(?)').run(json(result));
      appendEvent(this.db,{type:'drawing.changed',drawingId:`layout:${request.after.unitId}`});
      this.db.prepare('INSERT INTO drawing_operations VALUES(?,?,?)').run(request.operationId,digest,json(result));
      return result;
    });
  }
  dispatch(action: string, request: any): any {
    if (action === 'drawings:list') return this.db.prepare('SELECT value FROM personal_drawings ORDER BY rowid').all().map(r => this.visible(parse(r.value)));
    if (action === 'drawings:placements') return this.db.prepare('SELECT value FROM placement_history ORDER BY seq').all().map(r=>parse(r.value));
    if (action === 'drawings:queryPlacement') { const r=this.db.prepare('SELECT result FROM drawing_operations WHERE id=?').get(request.operationId); return r && parse(r.result).after ? parse(r.result) : null; }
    if (action === 'drawings:place') return this.place(request);
    if (action === 'drawings:query') { const r = this.db.prepare('SELECT result FROM drawing_operations WHERE id=?').get(request.operationId); return r && 'value' in parse(r.result) ? parse(r.result) : null; }
    if (action === 'drawings:history') return this.db.prepare('SELECT value FROM drawing_history ORDER BY seq').all().map(r => parse(r.value)).filter(h => !request.id || h.id === request.id);
    if (action !== 'drawings:apply' || typeof request.operationId !== 'string' || !request.operationId.length || request.operationId.length > 160 || typeof request.id !== 'string' || !request.id.length || request.id.length > 160) throw new Error('无效的图形操作');
    const { sessionId: _, ...body } = request;
    const digest = createHash('sha256').update(json({action,...body})).digest('hex');
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT * FROM drawing_operations WHERE id=?').get(request.operationId);
      if (prior) { if (prior.digest !== digest) throw new Error('同一操作不能换用不同图形'); return parse(prior.result); }
      const command = request as DrawingApply;
      const row = this.db.prepare('SELECT value FROM personal_drawings WHERE id=?').get(command.id);
      const old: PersonalDrawing | undefined = row && parse(row.value);
      if (command.expectedVersion !== (old?.version ?? 0)) throw new Error('图形已变化，请重新读取后继续');
      const v = structuredClone(command.value);
      if (command.selection) {
        if (old || !v || v.kind !== 'highlighter' || v.anchor.space !== 'text' || v.anchor.noteId) throw new Error('无效的文字高亮创建');
        v.anchor.noteId = this.annotations.createDrawingRange(command.selection).id;
      }
      if (v === null && !old) throw new Error('图形不存在');
      if (v !== null) this.validate(v,old);
      const saved: PersonalDrawing = this.visible({ id: command.id, version: (old?.version ?? 0) + 1, value: v, original: old?.original ?? v!, status: v ? 'attached' : 'deleted' });
      this.db.prepare('INSERT INTO personal_drawings VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(saved.id, json(saved));
      this.db.prepare('INSERT INTO drawing_history(value) VALUES(?)').run(json({ committedAt:new Date().toISOString(),actor:'student',operationId: command.operationId, id: saved.id, before: old?.value ?? null, after: v, version: saved.version }));
      appendEvent(this.db, { type: 'drawing.changed', drawingId: saved.id });
      this.db.prepare('INSERT INTO drawing_operations VALUES(?,?,?)').run(command.operationId, digest, json(saved));
      return this.visible(saved);
    });
  }
}
