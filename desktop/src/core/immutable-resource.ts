import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync, linkSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_RESOURCE_READ = 1024 * 1024;
export function hashFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !stat.size) throw new Error('来源为空或不是普通文件');
    const hash = createHash('sha256'), chunk = Buffer.alloc(MAX_RESOURCE_READ);
    for (let offset = 0; offset < stat.size;) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!n) throw new Error('来源读取不完整，请重试导入');
      hash.update(chunk.subarray(0, n)); offset += n;
    }
    return { sha256: hash.digest('hex'), byteLength: stat.size };
  } finally { closeSync(fd); }
}

/** File publish completes and is validated BEFORE a caller can register a formal DB reference.
 * An interrupted/failed SQLite registration can leave an unreferenced complete blob, never a half blob.
 * Content-addressed existing resources are verified and never overwritten, even on retry.
 */
export async function publishResource(directory: string, original: string, validate: (path: string) => Promise<void>, restoreHash?: string) {
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('资源目录无效');
  const partial = join(directory, `.${randomUUID()}.partial`);
  let input: number | undefined, output: number | undefined;
  try {
    input = openSync(original, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(input);
    if (!before.isFile() || !before.size) throw new Error('来源为空或不是普通文件');
    output = openSync(partial, 'wx', 0o600);
    const hash = createHash('sha256'), chunk = Buffer.alloc(MAX_RESOURCE_READ);
    let offset = 0;
    while (offset < before.size) {
      const n = readSync(input, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!n) throw new Error('来源复制不完整，请重试导入');
      for (let written = 0; written < n;) written += writeSync(output, chunk, written, n - written);
      hash.update(chunk.subarray(0, n)); offset += n;
    }
    const after = fstatSync(input);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('原件在导入时变化，请重试');
    fsyncSync(output); closeSync(output); output = undefined;
    const sha256 = hash.digest('hex'), byteLength = before.size;
    const verified = hashFile(partial);
    if (verified.sha256 !== sha256 || verified.byteLength !== byteLength) throw new Error('资源复制校验失败');
    if (restoreHash && sha256 !== restoreHash) throw new Error('所选原件与该版本哈希不同，不能替换旧引用');
    await validate(partial);
    const path = join(directory, sha256);
    try { linkSync(partial, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let intact = false;
      try { const existing = hashFile(path); intact = existing.sha256 === sha256 && existing.byteLength === byteLength; } catch { /* An explicit exact-hash repair may replace a broken entry. */ }
      if (!intact) {
        if (!restoreHash) throw new Error('已保存资源损坏，请从原件重试修复');
        renameSync(partial, path);
      }
    }
    const folder = openSync(directory, 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
    return { path, sha256, byteLength };
  } finally {
    if (input !== undefined) closeSync(input);
    if (output !== undefined) closeSync(output);
    try { unlinkSync(partial); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
