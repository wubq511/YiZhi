import { build } from 'esbuild';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
await mkdir('dist/tests', { recursive: true });
const entries = [
  ['src/core/course-service.ts', 'dist/course-service.cjs'],
  ['src/core/worker.ts', 'dist/worker.cjs'],
  ['src/host/main.ts', 'dist/main.cjs'],
  ['src/host/preload.ts', 'dist/preload.cjs'],
  ['tests/course-service.test.ts', 'dist/tests/course-service.test.cjs'],
  ['tests/ownership-child.ts', 'dist/tests/ownership-child.cjs'],
];
for (const [entry, outfile] of entries) {
  try {
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron'], sourcemap: true });
  } catch (error) { throw error; }
}
try {
  await build({ entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/renderer/app.js', bundle: true,
    platform: 'browser', target: 'chrome140', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } });
  await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
} catch (error) { throw error; }
await mkdir('dist/fixtures', { recursive: true });
for (const file of await readdir('fixtures')) await copyFile(`fixtures/${file}`, `dist/fixtures/${file}`);
