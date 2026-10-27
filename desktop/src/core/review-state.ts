import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CourseGraph } from '../shared';
import type { ReviewPrompt, ReviewPromptResult, ReviewSnapshot, ReviewStatus } from '../shared';

const valid = (value: unknown): value is ReviewStatus => ['pending', 'weak', 'mastered'].includes(String(value));
const parse = (value: unknown) => JSON.parse(String(value));

export function initializeReviewState(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS review_states(unit_id TEXT PRIMARY KEY, status TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_prompts(id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, content_revision INTEGER NOT NULL,
      state_version INTEGER NOT NULL, semantic_version INTEGER NOT NULL, resolved TEXT);`);
}

export function reviewSnapshot(db: DatabaseSync, graph: CourseGraph): ReviewSnapshot & { prompts: ReviewPrompt[] } {
  const rows = new Map(db.prepare('SELECT unit_id,status,version FROM review_states').all().map(row => [String(row.unit_id), row]));
  const units: ReviewSnapshot['units'] = {};
  const themes: ReviewSnapshot['themes'] = {};
  for (const group of graph.groups) themes[group.id] = { pending: 0, weak: 0, mastered: 0 };
  for (const node of graph.nodes) {
    const row = rows.get(node.id);
    const status = row ? String(row.status) as ReviewStatus : 'pending';
    units[node.id] = { status, version: row ? Number(row.version) : 0 };
    themes[node.themeId][status]++;
  }
  const prompts = db.prepare("SELECT id,unit_id,content_revision,state_version,semantic_version FROM review_prompts WHERE resolved IS NULL ORDER BY rowid").all()
    .map(row => ({ id: String(row.id), unitId: String(row.unit_id), contentRevision: Number(row.content_revision),
      stateVersion: Number(row.state_version), semanticVersion: 1 as const }));
  return { units, themes, prompts };
}

export function setReviewStatus(db: DatabaseSync, graph: CourseGraph, unitId: string, status: unknown) {
  if (!graph.nodes.some(node => node.id === unitId)) throw new Error('复习状态只属于知识单元');
  if (!valid(status)) throw new Error('复习状态无效');
  db.prepare(`INSERT INTO review_states VALUES(?,?,1) ON CONFLICT(unit_id) DO UPDATE SET
    status=excluded.status, version=review_states.version+1 WHERE status<>excluded.status`).run(unitId, status);
  return reviewSnapshot(db, graph);
}

export function recordSemanticImpact(db: DatabaseSync, graph: CourseGraph, impact: unknown, contentUnitId: string, contentRevision: number): ReviewPrompt | undefined {
  if (!impact || typeof impact !== 'object') return;
  const value = impact as { version?: number; unitId?: string; conclusionOrMethodChanged?: boolean };
  if (value.version !== 1 || typeof value.unitId !== 'string' || typeof value.conclusionOrMethodChanged !== 'boolean')
    throw new Error('实质变化元数据版本无效');
  if (value.unitId !== contentUnitId) throw new Error('实质变化元数据必须指向本次已保存的知识单元');
  if (!value.conclusionOrMethodChanged || !graph.nodes.some(node => node.id === value.unitId)) return;
  const row = db.prepare('SELECT status,version FROM review_states WHERE unit_id=?').get(value.unitId);
  if (!row || row.status !== 'mastered') return;
  const prompt: ReviewPrompt = { id: randomUUID(), unitId: value.unitId, contentRevision, stateVersion: Number(row.version), semanticVersion: 1 };
  db.prepare('INSERT INTO review_prompts VALUES(?,?,?,?,?,NULL)').run(prompt.id, prompt.unitId,
    prompt.contentRevision, prompt.stateVersion, prompt.semanticVersion);
  return prompt;
}

export function confirmReviewPrompt(db: DatabaseSync, graph: CourseGraph, promptId: string, adjust: boolean): ReviewPromptResult {
  if (typeof adjust !== 'boolean') throw new Error('确认选项无效');
  const row = db.prepare('SELECT * FROM review_prompts WHERE id=?').get(promptId);
  if (!row || row.resolved !== null) return 'stale';
  const state = db.prepare('SELECT status,version FROM review_states WHERE unit_id=?').get(String(row.unit_id));
  const unit = db.prepare('SELECT revision FROM units WHERE id=?').get(String(row.unit_id));
  if (!state || !unit || Number(state.version) !== Number(row.state_version) ||
    Number(unit.revision) !== Number(row.content_revision)) {
    db.prepare("UPDATE review_prompts SET resolved='stale' WHERE id=?").run(promptId);
    return 'stale';
  }
  if (adjust) setReviewStatus(db, graph, String(row.unit_id), 'pending');
  db.prepare('UPDATE review_prompts SET resolved=? WHERE id=?').run(adjust ? 'adjusted' : 'kept', promptId);
  return adjust ? 'adjusted' : 'kept';
}
