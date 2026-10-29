import {build} from '../../desktop/node_modules/esbuild/lib/main.js';
import {mkdir,cp,copyFile,symlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {developmentDirectory} from './paths.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
export const output=developmentDirectory(root);
await mkdir(output,{recursive:true});
try{await symlink(join(root,'desktop/node_modules'),join(output,'node_modules'),'dir');}catch(error){if(error.code!=='EEXIST')throw error;}
for(const [entry,name] of [['tools/desktop/worker.ts','worker'],['tools/desktop/course-service.ts','course-service'],['tools/desktop/cli.ts','cli'],['desktop/src/core/parsing-tool.ts','parsing-tool'],['desktop/src/core/upgrade-proof.ts','upgrade-proof'],['desktop/tests/cutover-process.ts','tests/cutover-process']])await build({entryPoints:[join(root,entry)],outfile:join(output,name+'.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['pdfjs-dist/*','@napi-rs/canvas'],nodePaths:[join(root,'desktop/node_modules')]});
await cp(join(root,'desktop/fixtures'),join(output,'fixtures'),{recursive:true});
await cp(join(root,'desktop/src/extensions/packages'),join(output,'extensions'),{recursive:true});
await copyFile(join(root,'tools/desktop/legacy-lock.py'),join(output,'legacy-lock.py'));
await copyFile(join(root,'legacy/review-board/reviewboard/directory_authority.py'),join(output,'directory_authority.py'));
console.log(output);

// Controlled producer executable is built only with this development builder.
for (const [entry, name] of [['controlled-main.ts', 'controlled-main'], ['controlled-preload.ts', 'controlled-preload']])
  await build({ entryPoints: [join(root, 'tools/desktop', entry)], outfile: join(output, name + '.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'pdfjs-dist/*', '@napi-rs/canvas'],
    nodePaths: [join(root, 'desktop/node_modules')] });
await build({ entryPoints: [join(root, 'tools/desktop/controlled-renderer.tsx')], outfile: join(output, 'renderer/app.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'chrome140', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  nodePaths: [join(root, 'desktop/node_modules')] });
await copyFile(join(root, 'tools/desktop/controlled-index.html'), join(output, 'renderer/index.html'));
await copyFile(join(root, 'desktop/src/renderer/assets/ti74153-1.png'), join(output, 'renderer/ti74153-1.png'));
await cp(join(root, 'desktop/node_modules/mathlive/fonts'), join(output, 'renderer/mathlive-fonts'), { recursive: true });
await mkdir(join(output, 'renderer/pdfjs'), { recursive: true });
await copyFile(join(root, 'desktop/node_modules/pdfjs-dist/build/pdf.worker.mjs'), join(output, 'renderer/pdfjs/pdf.worker.mjs'));
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
  await cp(join(root, 'desktop/node_modules/pdfjs-dist', directory), join(output, 'renderer/pdfjs', directory), { recursive: true });
