import { build } from 'esbuild';
import { cp, copyFile } from 'node:fs/promises';
await build({entryPoints:['entry.js'],bundle:true,minify:true,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},outfile:'editor.js'});
await copyFile('node_modules/@excalidraw/excalidraw/dist/prod/index.css','editor.css');
await cp('node_modules/@excalidraw/excalidraw/dist/prod/fonts','fonts',{recursive:true});
