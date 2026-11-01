import { createHash } from 'node:crypto';
import { readdir, readFile, readlink, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { developmentDirectory } from '../../tools/desktop/paths.mjs';

const cacheFile = 'node_modules/.cache/yizhi/build-state.json';
const repository = resolve('..');
const development = developmentDirectory(repository);
const developmentOutputs = ['worker.cjs', 'course-service.cjs', 'cli.cjs', 'parsing-tool.cjs',
  'upgrade-proof.cjs', 'tests/cutover-process.cjs', 'fixtures', 'extensions',
  'legacy-lock.py', 'directory_authority.py', 'controlled-main.cjs',
  'controlled-preload.cjs', 'renderer', 'node_modules'];
const inputs = ['src', 'tests', 'fixtures', 'licenses', 'scripts', '../tools/desktop',
  'package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.ts',
  '../legacy/review-board/reviewboard/directory_authority.py'];
const ignored = new Set(['node_modules', '__pycache__', '.pytest_cache', '.venv', '.DS_Store']);

async function files(path, skipIgnored = true) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return [path];
  if (!stat.isDirectory()) return [path];
  const names = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(names.filter(name => !skipIgnored || !ignored.has(name.name))
    .map(name => files(join(path, name.name), skipIgnored)));
  return nested.flat();
}

async function digest(paths) {
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash.update(relative(repository, resolve(path)));
    hash.update('\0');
    hash.update((await lstat(path)).isSymbolicLink() ? await readlink(path) : await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function inputDigest() {
  const paths = (await Promise.all(inputs.map(files))).flat();
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    development, version: 1 }));
  hash.update(await digest(paths));
  return hash.digest('hex');
}

async function outputState() {
  const paths = (await Promise.all([files('dist', false),
    ...developmentOutputs.map(name => files(join(development, name), false))])).flat();
  return { paths: paths.map(path => resolve(path)).sort(), hash: await digest(paths) };
}

export async function fresh() {
  try {
    const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (saved.input !== await inputDigest()) return false;
    const current = await outputState();
    return JSON.stringify(current) === JSON.stringify(saved.output);
  } catch { return false; }
}

export async function invalidate() { await rm(cacheFile, { force: true }); }

export async function record() {
  const state = { input: await inputDigest(), output: await outputState() };
  await mkdir('node_modules/.cache/yizhi', { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state));
    await rename(temporary, cacheFile);
  } finally { await rm(temporary, { force: true }); }
}
