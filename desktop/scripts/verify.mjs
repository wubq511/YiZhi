import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { coreBudget, coreRuns } from './core-runs.mjs';

const budget = coreBudget();
console.log(`[verify] CPU budget=${budget.cpus}; Core files/runtime=${budget.concurrency}; ${budget.sequential ? 'sequential' : 'parallel'}`);

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

if (!await check('build', ['scripts/build.mjs'])) process.exitCode = 1;
else {
  const runner = () => check('runner', ['--test', '--test-concurrency=1', 'scripts/tests/validation.test.mjs']);
  const typecheck = () => check('typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']);
  let results;
  if (budget.sequential) results = [await runner(), await typecheck(), ...await coreRuns(check, budget)];
  else if (budget.cpus < 4) results = [...await Promise.all([runner(), typecheck()]), ...await coreRuns(check, budget)];
  else results = (await Promise.all([runner(), typecheck(), coreRuns(check, budget)])).flat();
  if (!results.every(Boolean)) process.exitCode = 1;
}
