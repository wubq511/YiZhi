import { CourseService } from '../src/core/course-service';
import { resolve } from 'node:path';
const service = new CourseService(resolve('dist/worker.cjs'));
(async () => {
  try { console.log('OWNED', (await service.open(process.argv[2])).unit.id); }
  catch (error) { console.log((error as Error).message); process.exitCode = 1; }
  finally { await service.close(); }
})();
