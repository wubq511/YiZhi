import { spawnSync } from 'node:child_process';
import electron from 'electron';
const result = spawnSync(electron, ['--test', 'dist/tests/course-service.test.cjs'], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
});
process.exit(result.status ?? 1);
