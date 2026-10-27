import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
await build({ entryPoints: ['src/main.jsx'], bundle: true, minify: true,
  format: 'esm', outfile: 'dist/app.js', define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof' });
const names = ['react', 'react-dom', 'scheduler', '@xyflow/react', '@xyflow/system',
  'zustand', 'use-sync-external-store', 'classcat', 'd3-selection', 'd3-drag',
  'd3-dispatch', 'd3-interpolate', 'd3-color', 'd3-timer', 'd3-ease', 'd3-transition', 'd3-zoom'];
let licenses = '# Bundled runtime dependency notices\n\n';
for (const name of names) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  let license;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(`node_modules/${name}/${file}`, 'utf8'); break; } catch {}
  }
  if (!license) throw new Error(`Missing license: ${name}`);
  licenses += `## ${name} ${pkg.version} (${pkg.license})\n\n${license}\n\n`;
}
await writeFile('THIRD_PARTY_NOTICES.md', licenses);
