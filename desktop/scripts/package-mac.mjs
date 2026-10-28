import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.find(arg => arg.startsWith('--out='));
if (args.some(arg => arg !== outArg)) throw new Error('Usage: npm run package:mac -- --out=/absolute/new-directory');
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('This command packages only the current macOS architecture.');
if (outArg && !isAbsolute(outArg.slice(6))) throw new Error('--out must be an absolute path.');
const out = outArg ? outArg.slice(6) : join(project, 'artifacts', `macos-${Date.now()}`);
try { await stat(out); throw new Error(`Output already exists: ${out}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const run = (command, commandArgs, cwd) => execFileSync(command, commandArgs, { cwd, stdio: 'inherit' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

run('npm', ['run', 'build'], project);
const temporary = await mkdtemp(join(tmpdir(), 'yizhi-package-'));
try {
  const stage = join(temporary, 'app');
  await mkdir(stage);
  for (const name of ['package.json', 'package-lock.json', 'THIRD-PARTY-NOTICES.md'])
    await cp(join(project, name), join(stage, name));
  await cp(join(project, 'dist'), join(stage, 'dist'), { recursive: true, filter: path => {
    const relative = path.slice(join(project, 'dist').length);
    return !relative.startsWith('/tests') && !path.endsWith('.map') && !path.endsWith('/generate.py');
  } });
  await cp(join(project, 'licenses'), join(stage, 'licenses'), { recursive: true });
  await mkdir(join(stage, 'scripts'));
  await cp(join(project, 'scripts/migrate-course.mjs'), join(stage, 'scripts/migrate-course.mjs'));
  // Use the exact production graph; no development tool or checkout symlink enters the app.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], stage);
  for (const name of ['electron', '@electron/packager', '@playwright/test', 'typescript']) {
    try { await stat(join(stage, 'node_modules', name)); throw new Error(`Development dependency in runtime: ${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const production = [];
  const licenseFiles = [];
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected runtime symlink: ${path}`);
      if (entry.isDirectory()) await inventory(path);
      else if (entry.name === 'package.json') {
        const metadata = JSON.parse(await readFile(path, 'utf8'));
        if (metadata.name && metadata.version) production.push({ name: metadata.name, version: metadata.version,
          license: metadata.license ?? null, path: path.slice(stage.length + 1) });
      } else if (/^(licen[cs]e|copying|notice)([.\-_]|$)/i.test(entry.name)) {
        licenseFiles.push({ path: path.slice(stage.length + 1), sha256: digest(await readFile(path)) });
      }
    }
  }
  await inventory(join(stage, 'node_modules'));
  for (const [from, to] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']])
    await cp(join(project, 'node_modules/electron/dist', from), join(stage, to));
  // Decode and encode using the staged native module before signing or publishing an artifact.
  run(process.execPath, ['-e', "const c=require('@napi-rs/canvas').createCanvas(2,2);if(!c.toBuffer('image/png').length)throw Error('Native canvas unavailable')"], stage);
  const metadata = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  await writeFile(join(stage, 'package-manifest.json'), JSON.stringify({
    name: 'YiZhi', version: metadata.version, platform: 'darwin', arch: process.arch,
    electron: metadata.devDependencies.electron, lockSha256: digest(await readFile(join(stage, 'package-lock.json'))),
    productionPackages: production.sort((a,b) => a.path.localeCompare(b.path)),
    licenseFiles: licenseFiles.sort((a,b) => a.path.localeCompare(b.path)),
    nativeSbom: `node_modules/@napi-rs/canvas-darwin-${process.arch}/sbom.cdx.json`,
    signing: { identity: 'ad-hoc', notarized: false }
  }, null, 2) + '\n');
  const outputs = await packager({ dir: stage, out, name: 'YiZhi', executableName: 'YiZhi',
    appBundleId: 'com.yizhi.desktop', appVersion: metadata.version,
    platform: 'darwin', arch: process.arch, electronVersion: metadata.devDependencies.electron,
    asar: false, prune: false, overwrite: false,
    osxSign: { identity: '-', continueOnError: false, identityValidation: false, preAutoEntitlements: false,
      preEmbedProvisioningProfile: false, optionsForFile: () => ({ hardenedRuntime: false }) }
  });
  for (const output of outputs) {
    const app = join(output, 'YiZhi.app');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], project);
    console.log(`Packaged application: ${app}`);
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
