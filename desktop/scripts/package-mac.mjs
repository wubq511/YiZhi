import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
const args = process.argv.slice(2);
const outArg = args.find(arg => arg.startsWith('--out='));
if (args.some(arg => arg !== outArg)) throw new Error('Usage: npm run package:mac -- --out=/absolute/new-directory');
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('This command packages only the current macOS architecture.');
if (outArg && !isAbsolute(outArg.slice(6))) throw new Error('--out must be an absolute path.');
// Keep package output with the original repository when building from a worktree.
const out = outArg ? outArg.slice(6) : resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  '..', 'artifacts', 'scratch', `macos-${Date.now()}`);
try { await stat(out); throw new Error(`Output already exists: ${out}`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const run = (command, commandArgs, cwd) => execFileSync(command, commandArgs, { cwd, stdio: 'inherit' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

run('npm', ['run', 'build','--','--production'], project);
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
  const nativeNotices = JSON.parse(await readFile(join(stage, 'licenses/native-canvas/manifest.json'), 'utf8'));
  if (nativeNotices.target.os !== process.platform || nativeNotices.target.arch !== process.arch)
    throw new Error('Native notice materials do not cover this target architecture.');
  const nativePackage = nativeNotices.target.npmNative.slice(0, nativeNotices.target.npmNative.lastIndexOf('@'));
  const nativeBinary = await readFile(join(stage, 'node_modules', nativePackage, nativeNotices.target.file));
  if (digest(nativeBinary) !== nativeNotices.target.sha256 || nativeBinary.length !== nativeNotices.target.bytes)
    throw new Error('Native binary differs from the audited notice input.');
  for (const [from, to] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']])
    await cp(join(project, 'node_modules/electron/dist', from), join(stage, to));
  // Decode and encode using the staged native module before signing or publishing an artifact.
  run(process.execPath, ['-e', "const c=require('@napi-rs/canvas').createCanvas(2,2);if(!c.toBuffer('image/png').length)throw Error('Native canvas unavailable')"], stage);
  const metadata = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const source = { commit: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--porcelain', '--untracked-files=normal']) };
  const runtimeFiles = await Promise.all(['main.cjs', 'worker.cjs', 'preload.cjs', 'parsing-tool.cjs', 'course-service.cjs', 'renderer/app.js']
    .map(async path => ({ path: `dist/${path}`, sha256: digest(await readFile(join(stage, 'dist', path))) })));
  await writeFile(join(stage, 'package-manifest.json'), JSON.stringify({
    name: 'YiZhi', version: metadata.version, platform: 'darwin', arch: process.arch,
    electron: metadata.devDependencies.electron, lockSha256: digest(await readFile(join(stage, 'package-lock.json'))),
    source, runtimeFiles, runtimeInputs:JSON.parse(await readFile(join(stage,'dist/runtime-inputs.json'),'utf8')),
    productionPackages: production.sort((a,b) => a.path.localeCompare(b.path)),
    licenseFiles: licenseFiles.sort((a,b) => a.path.localeCompare(b.path)),
    nativeSbom: `node_modules/@napi-rs/canvas-darwin-${process.arch}/sbom.cdx.json`,
    nativeNotices: { path: 'licenses/native-canvas/manifest.json', sha256: digest(await readFile(join(stage, 'licenses/native-canvas/manifest.json'))) },
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
    const packaged = join(app, 'Contents/Resources/app');
    const sums = await readFile(join(stage, 'licenses/native-canvas/SHA256SUMS'), 'utf8');
    for (const line of sums.trim().split('\n')) {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      if (!match || match[2].split('/').includes('..')) throw new Error('Invalid native notice checksum manifest.');
      const path = join(packaged, 'licenses/native-canvas', match[2]);
      if (digest(await readFile(path)) !== match[1]) throw new Error(`Packaged native notice differs: ${match[2]}`);
    }
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], project);
    console.log(`Packaged application: ${app}`);
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
