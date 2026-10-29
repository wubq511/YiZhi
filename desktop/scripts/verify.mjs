import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

let cpus = availableParallelism();
let sequential = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--sequential') sequential = true;
  else if (/^--cpus=[1-9]\d*$/.test(arg) && Number.isSafeInteger(Number(arg.split('=')[1]))) {
    cpus = Number(arg.split('=')[1]);
  } else throw new Error(`Invalid verification argument: ${arg}`);
}
if (cpus === 1) sequential = true;
// Reserve slots for typecheck and the independent runner regression suite.
const concurrency = Math.max(1, sequential ? cpus - 1 : Math.floor((cpus - 2) / 2));
console.log(`[verify] CPU budget=${cpus}; Core files/runtime=${concurrency}; ${sequential ? 'sequential' : 'parallel'}`);

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
  const node = () => check('core:node', ['scripts/run-tests.mjs', `--concurrency=${concurrency}`]);
  const electron = () => check('core:electron', ['scripts/run-tests.mjs', '--electron', `--concurrency=${concurrency}`]);
  let results;
  if (sequential) results = [await runner(), await typecheck(), await node(), await electron()];
  else if (cpus < 4) results = [...await Promise.all([runner(), typecheck()]), ...await Promise.all([node(), electron()])];
  else results = await Promise.all([runner(), typecheck(), node(), electron()]);
  if (!results.every(Boolean)) process.exitCode = 1;
}
