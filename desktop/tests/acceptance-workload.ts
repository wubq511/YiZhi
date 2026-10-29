import type { CourseService } from '../src/core/course-service';
import type { OpenedCourse, ReadingBlock } from '../src/shared';
export type StudyAPI = Pick<CourseService, 'read' | 'commitEdit' | 'formalHistory' | 'search' | 'parsing'>;
export interface ProgressEvidence {
  requestedAt: number; acknowledgedAt: number; readAt: number;
  acknowledgedWhileActive: boolean; readBackWhileActive: boolean;
  inputSeq: number; operationId: string; savedText: string; readText: string;
}
export const flattenBlocks = (blocks: ReadingBlock[]): ReadingBlock[] => blocks.flatMap(block => [block, ...flattenBlocks(block.children ?? [])]);
async function progressB(api: StudyAPI, course: OpenedCourse, active: () => boolean, label: string): Promise<ProgressEvidence> {
  const requestedAt = performance.now(), current = await api.read(course.sessionId, course.unit.id);
  const block = flattenBlocks(current.unit.reading.blocks).find(b => b.kind === 'paragraph');
  if (!block) throw new Error('Course B needs an actual editable paragraph');
  const savedText = `[synthetic acceptance ${label}] B latest input`, operationId = crypto.randomUUID();
  const receipt = await api.commitEdit({ sessionId: current.sessionId, unitId: current.unit.id, operationId,
    inputSeq: current.confirmedInputSeq + 1, baseRevision: current.revision, complete: true, changes: [{ blockId: block.id, text: savedText }] });
  const acknowledgedAt = performance.now(), acknowledgedWhileActive = active();
  const read = await api.read(current.sessionId, current.unit.id), readAt = performance.now();
  const readText = String(flattenBlocks(read.unit.reading.blocks).find(b => b.id === block.id)?.payload.text);
  if (receipt.inputSeq !== current.confirmedInputSeq + 1 || readText !== savedText) throw new Error('B did not read back its latest acknowledged input');
  return { requestedAt, acknowledgedAt, readAt, acknowledgedWhileActive, readBackWhileActive: active(),
    inputSeq: receipt.inputSeq, operationId, savedText, readText };
}
function distinct(a: OpenedCourse, b: OpenedCourse) {
  if (a.courseId === b.courseId) throw new Error('Fairness requires two distinct course identities, not two copies of one course');
}

/** Real reset/rebuild; B is requested after indexing begins and must finish before it completes. */
export async function exerciseDirtyIndex(api: StudyAPI, a: OpenedCourse, b: OpenedCourse) {
  distinct(a, b);
  const startedAt = performance.now();
  let status = await api.search.rebuild({ sessionId: a.sessionId, reset: true, batchSize: 1 });
  const pendingAtStart = status.pending;
  if (!pendingAtStart) throw new Error('No remaining dirty work; cannot claim overlap');
  let active = true, batches = 1;
  const job = (async () => {
    try { while (status.pending) { status = await api.search.rebuild({ sessionId: a.sessionId, batchSize: 1 }); batches++; } }
    finally { active = false; }
    return performance.now();
  })();
  let progress: ProgressEvidence;
  try { progress = await progressB(api, b, () => active, 'dirty-index'); } finally { await job; }
  const endedAt = await job;
  if (!progress.acknowledgedWhileActive || !progress.readBackWhileActive) throw new Error('Index completed before B read/save/read-back; overlap was not established');
  return { startedAt, endedAt, pendingAtStart, pendingAtEnd: status.pending, batches, progress };
}

/** Generates labelled disposable edits through the real formal commit path, never SQL history rows. */
export async function prepareLongHistory(api: StudyAPI, course: OpenedCourse, groups: number) {
  if (!Number.isSafeInteger(groups) || groups < 2 || groups > 10000) throw new Error('History fixture group count must be 2–10000');
  let current = await api.read(course.sessionId, course.unit.id), anchorOperationId = '';
  const block = flattenBlocks(current.unit.reading.blocks).find(b => b.kind === 'paragraph');
  if (!block) throw new Error('History fixture needs an editable paragraph');
  for (let i = 0; i < groups; i++) {
    const operationId = crypto.randomUUID();
    await api.commitEdit({ sessionId: current.sessionId, unitId: current.unit.id, operationId,
      inputSeq: current.confirmedInputSeq + 1, baseRevision: current.revision, complete: true,
      changes: [{ blockId: block.id, text: `[synthetic history ${i + 1}/${groups}] ` + String(block.payload.text) }] });
    anchorOperationId ||= operationId;
    current = await api.read(course.sessionId, course.unit.id);
  }
  const anchor = await api.formalHistory.detail({ sessionId: course.sessionId, operationId: anchorOperationId });
  if (!anchor.changes.some(change => change.objectId === block.id)) throw new Error('History preparation did not produce a real formal body group');
  return { groups, anchorOperationId, finalRevision: current.revision, blockId: block.id };
}

export async function exerciseHistoryPreview(api: StudyAPI, a: OpenedCourse, b: OpenedCourse, anchorOperationId: string) {
  distinct(a, b);
  const startedAt = performance.now();
  let active = true, previewCount = 0;
  const durations: number[] = [];
  const job = (async () => {
    try {
      for (let i = 0; i < 8; i++) {
        const start = performance.now();
        const preview = await api.formalHistory.preview({ sessionId: a.sessionId, unitId: a.unit.id, atOperationId: anchorOperationId, side: 'after' });
        durations.push(performance.now() - start); previewCount++;
        if (!preview.unit || !preview.groups.length) throw new Error('No actual historical body preview');
        if (preview.retentionPin) await api.formalHistory.release({ sessionId: a.sessionId, pinId: preview.retentionPin });
      }
    } finally { active = false; }
    return performance.now();
  })();
  let progress: ProgressEvidence;
  try { progress = await progressB(api, b, () => active, 'history-preview'); } finally { await job; }
  const endedAt = await job;
  if (!progress.acknowledgedWhileActive || !progress.readBackWhileActive) throw new Error('History preview workload finished before B acknowledged/read back; no overlap');
  return { startedAt, endedAt, previewCount, durations, progress,
    limitation: 'Repeated real previews overlap B. A single synchronous preview may queue B; durations report that cost without a fabricated cutoff.' };
}

export async function exerciseParserPreparation(api: StudyAPI, a: OpenedCourse, b: OpenedCourse, versionId: string) {
  distinct(a, b);
  const startedAt = performance.now();
  let task = await api.parsing.start({ sessionId: a.sessionId, generation: a.generation, operationId: crypto.randomUUID(), versionId });
  if (task.status !== 'running') throw new Error('Parser did not start');
  const progress = await progressB(api, b, () => true, 'parser-preparation');
  task = await api.parsing.get({ sessionId: a.sessionId, taskId: task.taskId });
  const statusAfterB = task.status;
  if (statusAfterB !== 'running') throw new Error('Parser already finished before B read/save/read-back; no overlap proven');
  // A timeout is a harness completion guard, not a product latency target.
  const deadline = performance.now() + 120000;
  while (task.status === 'running' && performance.now() < deadline) {
    await new Promise(done => setTimeout(done, 10));
    task = await api.parsing.get({ sessionId: a.sessionId, taskId: task.taskId });
  }
  if (task.status !== 'completed') throw new Error(task.failure ?? 'Parser did not complete within harness timeout');
  return { startedAt, endedAt: performance.now(), taskId: task.taskId, statusAfterB,
    statusAtEnd: task.status, confirmedPages: task.confirmed.length, progress };
}
