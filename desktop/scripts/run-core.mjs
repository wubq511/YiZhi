import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { coreBudget, coreRuns } from './core-runs.mjs';

const budget = coreBudget(process.argv.slice(2), 0);
console.log(`[core] CPU budget=${budget.cpus}; files/runtime=${budget.concurrency}`);
async function check(label, args) {
  const start = performance.now();
  console.log(`[${label}] starting`);
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', line => console.log(`[${label}] ${line}`));
    }
    child.on('error', error => console.error(`[${label}] ${error.message}`));
    child.on('close', (code, signal) => {
      console.log(`[${label}] ${signal ? `signal=${signal}` : `exit=${code}`} (${((performance.now() - start) / 1000).toFixed(2)}s)`);
      resolve(code === 0 && !signal);
    });
  });
}
if (!(await coreRuns(check, budget)).every(Boolean)) process.exitCode = 1;
