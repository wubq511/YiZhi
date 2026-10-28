import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function discover(shard) {
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
    '--list', '--reporter=json', ...(shard ? [`--shard=${shard}/2`] : [])], {
    shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.errors ?? [], [], 'Playwright discovery errors');
  const tests = [];
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) for (const test of spec.tests) tests.push({
        id: `${spec.id}:${test.projectId}`, file: spec.file, line: spec.line,
        title: spec.title, annotations: test.annotations,
      });
      visit(suite.suites ?? []);
    }
  }
  visit(report.suites);
  assert.ok(tests.length, `Empty UI discovery: ${shard ?? 'full'}`);
  return tests;
}

const full = discover();
const shards = [discover(1), discover(2)];
const ids = tests => tests.map(test => test.id).sort();
const union = shards.flat();
assert.equal(new Set(ids(full)).size, full.length, 'Duplicate full-suite test identity');
assert.equal(new Set(ids(union)).size, union.length, 'UI shards overlap');
assert.deepEqual(ids(union), ids(full), 'UI shards must cover the exact full suite');
const summary = { full: full.length, shards: shards.map(tests => tests.length),
  overlap: 0, missing: 0, unexpected: 0,
};
console.log(JSON.stringify({ ...summary, ...(process.argv.includes('--json') ? {
  // --list discovers opt-in cases too; their existing runtime skip predicates stay intact.
  tests: full.map(test => ({ ...test, shard: shards[0].some(candidate => candidate.id === test.id) ? 1 : 2 })),
} : {}) }, null, 2));
