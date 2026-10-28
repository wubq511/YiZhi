import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectExecutor, executorEnv } from '../src/agent/executor';
import { readOnlyCLIArgs } from '../src/agent/isolation';

test('installed CLI actually disables direct image-file access in the configured narrow-tool profile', {
  skip: process.env.YIZHI_REAL_EXECUTOR !== '1' ? 'Opt-in installed CLI capability check; no inference request' : false,
}, async () => {
  const executor = await detectExecutor();
  assert.equal(executor.available, true, executor.error);
  const { stdout } = await promisify(execFile)(executor.path!, [...readOnlyCLIArgs, 'features', 'list'], {
    env: await executorEnv(executor.path!, process.env), timeout: 15_000,
  });
  const imageFeature = stdout.split('\n').find(line => /^view_image\s/.test(line));
  assert.match(imageFeature ?? '', /^view_image\s+\S+\s+false\s*$/,
    'The actual CLI must disable its built-in file image tool; an ignored setting does not enforce the course-tool boundary.');
});
