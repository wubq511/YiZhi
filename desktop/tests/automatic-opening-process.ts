import { CourseService } from '../src/core/course-service';
import { CourseOpening } from '../src/host/course-opening';
import { resolve } from 'node:path';
const [source, point] = process.argv.slice(2), gate = new SharedArrayBuffer(4);
const core = new CourseService(resolve('dist/worker.cjs'), { cutoverScheduling: { [point]: gate } });
const timer = setInterval(() => {
  if (Atomics.load(new Int32Array(gate), 0) === 1) { clearInterval(timer); process.send?.({ point }); }
}, 5);
void new CourseOpening(core).open(source).catch(error => process.send?.({ error: error.message })).finally(async () => {
  clearInterval(timer); await core.close();
});
