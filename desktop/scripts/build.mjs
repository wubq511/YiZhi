import { build } from 'esbuild';
import { mkdir, copyFile, readdir, cp, rm, writeFile } from 'node:fs/promises';
const production=process.argv.includes('--production');
if(process.argv.slice(2).some(arg=>arg!=='--production'))throw new Error('Unknown build argument');
await rm('dist',{recursive:true,force:true});
await mkdir('dist/tests', { recursive: true });
const runtimeInputs={};
const entries = [
  ['src/core/course-service.ts', 'dist/course-service.cjs'],
  ['src/core/parsing-tool.ts', 'dist/parsing-tool.cjs'],
  ['src/core/worker.ts', 'dist/worker.cjs'],
  ['src/core/upgrade-proof.ts', 'dist/upgrade-proof.cjs'],
  ['src/host/main.ts', 'dist/main.cjs'],
  ['src/host/preload.ts', 'dist/preload.cjs'],
  ...(production?[]:await readdir('tests')).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .sort().map(file => [`tests/${file}`, `dist/tests/${file.replace(/\.ts$/, '.cjs')}`]),
];
for (const [entry, outfile] of entries) {
  try {
    const result=await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron', 'pdfjs-dist/*', '@napi-rs/canvas', '@playwright/test', 'playwright', 'playwright-core'], sourcemap: true,metafile:true });
    if(!outfile.startsWith('dist/tests/'))runtimeInputs[outfile.slice(5)]=Object.keys(result.metafile.inputs).sort();
  } catch (error) { throw error; }
}
try {
  const result=await build({ entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/renderer/app.js', bundle: true,
    platform: 'browser', format: 'esm', target: 'chrome140', define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },metafile:true });
  runtimeInputs['renderer/app.js']=Object.keys(result.metafile.inputs).sort();
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

await cp('src/extensions/packages', 'dist/extensions', { recursive: true });

for(const [entry,inputs] of Object.entries(runtimeInputs))if(inputs.some(input=>input.includes('tools/desktop/')))throw new Error('Development dependency in runtime: '+entry);
await writeFile('dist/runtime-inputs.json',JSON.stringify(runtimeInputs,null,2)+'\n');
if(!production)await import('../../tools/desktop/build.mjs');
