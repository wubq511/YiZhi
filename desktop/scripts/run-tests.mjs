import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

let concurrency;
for (const arg of process.argv.slice(2)) {
  if (arg === '--electron') continue;
  if (/^--concurrency=[1-9]\d*$/.test(arg) && concurrency === undefined) {
    concurrency = Number(arg.split('=')[1]);
    if (Number.isSafeInteger(concurrency)) continue;
  }
  throw new Error(`Invalid Core runner argument: ${arg}`);
}
const files = (await readdir('tests')).filter(file => file.endsWith('.test.ts')).sort()
  .map(file => `dist/tests/${file.replace(/\.ts$/, '.cjs')}`);
if (!files.length) throw new Error('No desktop tests found');

const embedded = process.argv.includes('--electron');
const executable = embedded ? (await import('electron')).default : process.execPath;
console.log(`[core:${embedded ? 'electron' : 'node'}] ${files.length} sorted files; file concurrency=${concurrency ?? 'runtime default'}; executable=${executable}`);
const result = spawnSync(executable, ['--test', ...(concurrency ? [`--test-concurrency=${concurrency}`] : []), ...files], {
  stdio: 'inherit', shell: false,
  env: embedded ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
