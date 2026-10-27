/* Preserve the migrated repo layout while keeping course state disposable. */
const { cpSync, existsSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');

const appRoot = resolve(__dirname, '..');
const repoRoot = resolve(appRoot, '../..');
const courseRoot = join(repoRoot, 'courses/digital-logic');
const ignore = path => !['.review-board', '__pycache__', 'node_modules', '.DS_Store'].includes(basename(path)) && !path.endsWith('.pyc');

function copyRuntime(destination, withCourse = false) {
  const app = join(destination, 'legacy/review-board');
  cpSync(appRoot, app, { recursive: true, filter: ignore });
  for (const directory of ['content-depth-prototype', 'style-math-prototype', 'mux-skill-comparison/excalidraw-runtime/fonts']) {
    cpSync(join(repoRoot, 'experiments', directory), join(destination, 'experiments', directory), { recursive: true, filter: ignore });
  }
  const course = join(destination, 'courses/digital-logic');
  if (withCourse) {
    cpSync(courseRoot, course, { recursive: true, filter: ignore });
    if (existsSync(join(course, '.review-board'))) throw Error('never seed production personal state');
  }
  return { app, course, experiments: join(destination, 'experiments') };
}

module.exports = { copyRuntime };
