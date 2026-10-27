import { build } from 'esbuild';
import { mkdir, copyFile, readdir, cp } from 'node:fs/promises';
await mkdir('dist/tests', { recursive: true });
const entries = [
  ['src/core/course-service.ts', 'dist/course-service.cjs'],
  ['src/core/worker.ts', 'dist/worker.cjs'],
  ['src/host/main.ts', 'dist/main.cjs'],
  ['src/host/preload.ts', 'dist/preload.cjs'],
  ...(await readdir('tests')).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .sort().map(file => [`tests/${file}`, `dist/tests/${file.replace(/\.ts$/, '.cjs')}`]),
];
for (const [entry, outfile] of entries) {
  try {
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron', 'pdfjs-dist/*', '@napi-rs/canvas'], sourcemap: true });
  } catch (error) { throw error; }
}
try {
  await build({ entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/renderer/app.js', bundle: true,
    platform: 'browser', format: 'esm', target: 'chrome140', loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' } });
  await copyFile('src/renderer/index.html', 'dist/renderer/index.html');
  await copyFile('src/renderer/assets/ti74153-1.png', 'dist/renderer/ti74153-1.png');
  await cp('node_modules/mathlive/fonts', 'dist/renderer/mathlive-fonts', { recursive: true });
  await mkdir('dist/renderer/pdfjs', { recursive: true });
  await copyFile('node_modules/pdfjs-dist/build/pdf.worker.mjs', 'dist/renderer/pdfjs/pdf.worker.mjs');
  await copyFile('node_modules/pdfjs-dist/LICENSE', 'dist/renderer/pdfjs/LICENSE');
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
    await cp(`node_modules/pdfjs-dist/${directory}`, `dist/renderer/pdfjs/${directory}`, { recursive: true });
} catch (error) { throw error; }
await mkdir('dist/fixtures', { recursive: true });
await cp('licenses', 'dist/licenses', { recursive: true });
for (const file of await readdir('fixtures')) await copyFile(`fixtures/${file}`, `dist/fixtures/${file}`);
