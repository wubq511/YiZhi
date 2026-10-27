import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = (await readdir('tests')).filter(file => file.endsWith('.test.ts')).sort()
  .map(file => `dist/tests/${file.replace(/\.ts$/, '.cjs')}`);
if (!files.length) throw new Error('No desktop tests found');

const embedded = process.argv.includes('--electron');
const executable = embedded ? (await import('electron')).default : process.execPath;
const result = spawnSync(executable, ['--test', ...files], {
  stdio: 'inherit', shell: false,
  env: embedded ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
