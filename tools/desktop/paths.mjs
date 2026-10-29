import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Resolve development executables without creating directories or depending on bundle location. */
export function developmentDirectory(projectDirectory = process.cwd()) {
  const override = process.env.YIZHI_DEVELOPMENT_OUT;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error('YIZHI_DEVELOPMENT_OUT must be an absolute path');
    return resolve(override);
  }
  const git = (...args) => execFileSync('git', ['rev-parse', ...args], {
    cwd: projectDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const checkout = realpathSync(git('--show-toplevel'));
  const repository = dirname(realpathSync(git('--path-format=absolute', '--git-common-dir')));
  const output = join(repository, 'artifacts', 'desktop-development');
  if (checkout === repository) return output;
  const identity = createHash('sha256').update(checkout).digest('hex').slice(0, 16);
  return join(output, 'worktrees', identity);
}
