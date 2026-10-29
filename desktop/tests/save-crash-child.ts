import { CourseService } from '../src/core/course-service';
import { resolve } from 'node:path';
void (async () => {
const service = new CourseService(resolve('dist/worker.cjs'));
const course = await service.open(process.argv[2]);
const input = { sessionId: course.sessionId, inputSeq: 12, baseRevision: course.revision, complete: true,
  changes: [{ blockId: course.editableBlockId, text: '强杀边界前已进入真实 SQLite 的输入' }] };
await service.saveDraft(input);
if (process.argv[3] === 'committed') await service.commitEdit({ ...input, operationId: 'crash-operation' });
// This is the host-to-renderer transport boundary. The parent kills this process before delivering an acknowledgement.
process.stdout.write('DURABLE\n');
setInterval(() => {}, 1000);

})().catch(error => { console.error(error); process.exit(1); });
