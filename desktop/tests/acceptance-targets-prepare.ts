import { CourseService } from '../src/core/course-service';
import { basename, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

/** Controlled producer through public Core APIs. No executor/model, no authority marker or history SQL. */
export async function prepareTargetResults(core: CourseService, directory: string, unitIds: string[]) {
  const opened = await core.open(directory), conversation = await core.agent.create({ sessionId: opened.sessionId, operationId: crypto.randomUUID() });
  const results = [];
  for (const unitId of unitIds) {
    const current = await core.read(opened.sessionId, unitId), block = current.unit.reading.blocks.find(block => block.kind === 'paragraph');
    if (!block) throw new Error('Controlled result needs a root paragraph');
    const task = await core.agent.submit({ sessionId: opened.sessionId, conversationId: conversation.id, operationId: crypto.randomUUID(),
      generation: opened.generation, intent: 'modify', text: `[synthetic controlled producer, NO MODEL] observe result display for ${unitId}`, target: { unitId } });
    const identity = { sessionId: opened.sessionId, taskId: task.id, attemptId: task.attemptId, generation: task.generation };
    const basis = await core.readAgentMutation(identity);
    const marker = `[synthetic saved target ${unitId}; no model]`;
    const receipt = await core.applyAgentMutation({ ...identity, input: { operationId: crypto.randomUUID(), basisId: basis.basisId,
      conclusionOrMethodChanged: false, updates: [{ blockId: block.id, text: String(block.payload.text) + ' ' + marker }] } });
    if (receipt.status !== 'committed') throw new Error(receipt.reason ?? 'Controlled public commit did not succeed');
    await core.recordAgent({ ...identity, eventId: crypto.randomUUID(), kind: 'message', itemId: crypto.randomUUID(), text: 'Synthetic controlled Core producer saved the identified paragraph. No model or executor ran.' });
    await core.recordAgent({ ...identity, eventId: crypto.randomUUID(), kind: 'finish', status: 'completed' });
    const saved = (await core.agent.get({ sessionId: opened.sessionId, conversationId: conversation.id })).tasks.find(value => value.id === task.id)!;
    if (saved.status !== 'completed') throw new Error('Controlled result did not complete');
    results.push({ taskId: task.id, unitId, marker, receipt });
  }
  return { scope: 'synthetic public Core results for UI display; NOT actual model evidence', courseId: opened.courseId,
    conversationId: conversation.id, runtime: opened.runtime, results };
}

async function main() {
  const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const core = new CourseService(resolve(args.get('--worker')!));
  try {
    const result = await prepareTargetResults(core, resolve(args.get('--course')!), args.get('--units')!.split(','));
    await writeFile(resolve(args.get('--output')!), JSON.stringify(result, null, 2) + '\n');
  } finally { await core.close(); }
}
if (['acceptance-targets-prepare.cjs', 'acceptance-targets-prepare.ts'].includes(basename(process.argv[1] ?? ''))) void main().catch(error => { console.error(error); process.exitCode = 1; });
