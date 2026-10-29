import { cp, mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const output = process.argv.find(arg => arg.startsWith('--out='))?.slice(6);
if (!output || !isAbsolute(output)) throw new Error('Usage: node scripts/stage-t28-physical.mjs --out=/persistent/new-directory');
try { await stat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
await cp(resolve('dist/tests/t28-physical.cjs'), join(output, 't28-physical.cjs'));
for (const name of ['@playwright/test', 'playwright', 'playwright-core']) await cp(resolve('node_modules', name), join(output, 'node_modules', name), { recursive: true });
const bytes = await readFile(join(output, 't28-physical.cjs'));
await writeFile(join(output, 'tool-manifest.json'), JSON.stringify({ scope: 'passive physical observation tool, not installed-app runtime dependency',
  harnessSha256: createHash('sha256').update(bytes).digest('hex'), playwright: JSON.parse(await readFile(resolve('node_modules/playwright/package.json'), 'utf8')).version }, null, 2) + '\n');
console.log(output);
