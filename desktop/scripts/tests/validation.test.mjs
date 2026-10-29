import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const scripts = new URL('../', import.meta.url);
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'yizhi validation $()-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['scripts', 'tests', 'dist/tests']) await mkdir(join(root, path), { recursive: true });
  await copyFile(new URL('run-tests.mjs', scripts), join(root, 'scripts/run-tests.mjs'));
  return root;
}
async function run(root, script, args = [], env = {}) {
  const { NODE_TEST_CONTEXT, ...parentEnv } = process.env;
  const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd: root, shell: false, env: { ...parentEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, output }));
  });
}
async function suite(root, name, body) {
  await writeFile(join(root, 'tests', `${name}.test.ts`), '// discovery input');
  await writeFile(join(root, 'dist/tests', `${name}.test.cjs`), body);
}

test('a bounded Core run executes the complete sorted suite without overlapping files', async t => {
  const root = await workspace(t);
  for (const name of ['z', 'a']) await suite(root, name, `
    const fs = require('node:fs');
    fs.writeFileSync('exclusive', '', {flag:'wx'});
    fs.appendFileSync('completed', '${name}\\n');
    setTimeout(() => fs.unlinkSync('exclusive'), 200);
  `);
  await writeFile(join(root, 'tests', 'ignored.spec.ts'), 'not a Core test');
  const result = await run(root, 'run-tests.mjs', ['--concurrency=1']);
  assert.equal(result.status, 0, result.output);
  assert.equal(await readFile(join(root, 'completed'), 'utf8'), 'a\nz\n');
});

test('Core failures stay nonzero while later files still run; empty suites and invalid budgets fail', async t => {
  const root = await workspace(t);
  assert.notEqual((await run(root, 'run-tests.mjs')).status, 0);
  await suite(root, 'a', "throw new Error('deliberate Core failure')");
  await suite(root, 'z', "require('node:fs').writeFileSync('last-file-ran', '')");
  const result = await run(root, 'run-tests.mjs', ['--concurrency=1']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /deliberate Core failure/);
  assert.equal(await readFile(join(root, 'last-file-ran'), 'utf8'), '');
  for (const value of ['0', '-1', '1.5', 'NaN']) {
    assert.notEqual((await run(root, 'run-tests.mjs', [`--concurrency=${value}`])).status, 0);
  }
});

async function verificationWorkspace(t) {
  const root = await workspace(t);
  await copyFile(new URL('verify.mjs', scripts), join(root, 'scripts/verify.mjs'));
  await mkdir(join(root, 'node_modules/typescript/bin'), { recursive: true });
  await mkdir(join(root, 'scripts/tests'), { recursive: true });
  await writeFile(join(root, 'scripts/build.mjs'), `
    import fs from 'node:fs';
    fs.appendFileSync('build-count', 'build\\n');
    setTimeout(() => {
      if (process.env.FAIL_BUILD) process.exit(7);
      fs.writeFileSync('build-complete', '');
    }, 100);
  `);
  const check = `
    (async () => {
    const fs = await import('node:fs');
    if (!fs.existsSync('build-complete')) throw Error('started before completed build');
    const label = process.argv[1].endsWith('validation.test.mjs') ? 'runner' :
      process.argv.includes('--electron') ? 'electron' :
      process.argv[1].endsWith('tsc') ? 'typecheck' : 'node';
    fs.writeFileSync(label + '-started', JSON.stringify(process.argv.slice(2)));
    const deadline = Date.now() + 3000;
    const timer = setInterval(() => {
      const allStarted = ['node', 'electron', 'typecheck', 'runner'].every(x => fs.existsSync(x + '-started'));
      if (!process.env.REQUIRE_OVERLAP || allStarted) {
        clearInterval(timer);
        fs.writeFileSync(label + '-finished', '');
        if (process.env.SIGNAL_CHECK === label) process.kill(process.pid, 'SIGTERM');
        if (process.env.FAIL_CHECK === label) process.exit(9);
      } else if (Date.now() > deadline) { throw Error('checks never overlapped'); }
    }, 10);
    })();
  `;
  await writeFile(join(root, 'scripts/run-tests.mjs'), check);
  await writeFile(join(root, 'node_modules/typescript/bin/tsc'), check);
  await writeFile(join(root, 'scripts/tests/validation.test.mjs'), check);
  return root;
}

test('verification builds once before overlapping checks and shares a CPU budget', async t => {
  const root = await verificationWorkspace(t);
  const result = await run(root, 'verify.mjs', ['--cpus=6'], { REQUIRE_OVERLAP: '1' });
  assert.equal(result.status, 0, result.output);
  assert.equal(await readFile(join(root, 'build-count'), 'utf8'), 'build\n');
  for (const runtime of ['node', 'electron']) {
    const args = JSON.parse(await readFile(join(root, `${runtime}-started`), 'utf8'));
    assert.ok(args.includes('--concurrency=2'), `${runtime}: ${args}`);
    assert.equal(await readFile(join(root, `${runtime}-finished`), 'utf8'), '');
  }
  assert.equal(await readFile(join(root, 'runner-finished'), 'utf8'), '');
});

test('verification includes runner regressions and propagates their failure', async t => {
  const root = await verificationWorkspace(t);
  await writeFile(join(root, 'scripts/tests/validation.test.mjs'), "throw Error('deliberate runner regression failure')");
  const result = await run(root, 'verify.mjs', ['--cpus=6']);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /deliberate runner regression failure/);
});

test('verification reports every failed runtime or typecheck and waits for the other checks', async t => {
  for (const label of ['node', 'electron', 'typecheck']) {
    const root = await verificationWorkspace(t);
    const result = await run(root, 'verify.mjs', ['--cpus=5'], { REQUIRE_OVERLAP: '1', FAIL_CHECK: label });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`\\[${label === 'typecheck' ? label : `core:${label}`}\\] exit=9`));
    for (const check of ['node', 'electron', 'typecheck', 'runner']) {
      assert.equal(await readFile(join(root, `${check}-finished`), 'utf8'), '');
    }
  }
});

test('failed build starts no checks and a signalled check cannot pass verification', async t => {
  const failedBuild = await verificationWorkspace(t);
  const build = await run(failedBuild, 'verify.mjs', [], { FAIL_BUILD: '1' });
  assert.notEqual(build.status, 0);
  assert.match(build.output, /\[build\] exit=7/);
  assert.doesNotMatch(build.output, /\[(?:typecheck|core:node|core:electron)\] starting/);
  const signalled = await verificationWorkspace(t);
  const signal = await run(signalled, 'verify.mjs', ['--cpus=5'], { SIGNAL_CHECK: 'electron' });
  assert.notEqual(signal.status, 0);
  assert.match(signal.output, /\[core:electron\] signal=SIGTERM/);
});

test('verification can use one CPU or sequential checks without silently omitting a runtime', async t => {
  for (const args of [['--cpus=1'], ['--cpus=2'], ['--cpus=5', '--sequential']]) {
    const root = await verificationWorkspace(t);
    const result = await run(root, 'verify.mjs', args);
    assert.equal(result.status, 0, result.output);
    for (const label of ['node', 'electron', 'typecheck', 'runner']) {
      assert.equal(await readFile(join(root, `${label}-finished`), 'utf8'), '');
    }
  }
});

test('an unavailable embedded runtime cannot turn the Core suite green', async t => {
  const root = await workspace(t);
  await suite(root, 'a', '// valid test input');
  await mkdir(join(root, 'node_modules/electron'), { recursive: true });
  await writeFile(join(root, 'node_modules/electron/package.json'), '{"main":"index.cjs"}');
  await writeFile(join(root, 'node_modules/electron/index.cjs'), `module.exports = ${JSON.stringify(join(root, 'missing-electron'))}`);
  const result = await run(root, 'run-tests.mjs', ['--electron']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /ENOENT/);
});

test('embedded Core applies its runtime environment to the same complete sorted suite', async t => {
  const root = await workspace(t);
  await mkdir(join(root, 'node_modules/electron'), { recursive: true });
  await writeFile(join(root, 'node_modules/electron/package.json'), '{"main":"index.cjs"}');
  // Substitute only the external executable boundary, not any runner internals.
  await writeFile(join(root, 'node_modules/electron/index.cjs'), 'module.exports = process.execPath');
  for (const name of ['z', 'a']) await suite(root, name, `
    require('node:assert/strict').equal(process.env.ELECTRON_RUN_AS_NODE, '1');
    require('node:fs').appendFileSync('embedded-files', '${name}\\n');
  `);
  const result = await run(root, 'run-tests.mjs', ['--electron', '--concurrency=1']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /\[core:electron\]/);
  assert.equal(await readFile(join(root, 'embedded-files'), 'utf8'), 'a\nz\n');
});
