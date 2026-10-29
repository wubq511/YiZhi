import { existsSync,lstatSync } from 'node:fs';
import { resolve,relative,dirname } from 'node:path';
export function coursePath(root: string, name: string) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) throw new Error(`课程相对路径无效: ${name}`);
  const path = resolve(root, name);
  if (relative(root, path).startsWith('..')) throw new Error('课程路径越界');
  let current = path;
  while (current !== root) { if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('课程资源不接受软链'); current = dirname(current); }
  return path;
}
