import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, linkSync, renameSync } from 'node:fs';
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

/** Bounded asynchronous reads leave the shared Core free between chunks. */
export async function hashFileAsync(path: string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await file.stat();
    if(!before.isFile()||!before.size)throw new Error('来源为空或不是普通文件');
    const hash=createHash('sha256'),chunk=Buffer.alloc(MAX_RESOURCE_READ);
    for(let offset=0;offset<before.size;) {
      const {bytesRead}=await file.read(chunk,0,Math.min(chunk.length,before.size-offset),offset);
      if(!bytesRead)throw new Error('来源读取不完整，请重试导入');
      hash.update(chunk.subarray(0,bytesRead));offset+=bytesRead;
    }
    const after=await file.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('原件在读取时变化，请重试');
    return {sha256:hash.digest('hex'),byteLength:before.size};
  }finally{await file.close();}
}

/** File publish completes and is validated BEFORE a caller can register a formal DB reference.
 * An interrupted/failed SQLite registration can leave an unreferenced complete blob, never a half blob.
 * Content-addressed existing resources are verified and never overwritten, even on retry.
 */
export async function publishResource(directory: string, original: string, validate: (path: string) => Promise<void>, restoreHash?: string, beforePublish: () => void = () => {}) {
  mkdirSync(directory, { recursive: true });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('资源目录无效');
  const partial = join(directory, `.${randomUUID()}.partial`);
  let input: Awaited<ReturnType<typeof open>> | undefined, output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    input = await open(original, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await input.stat();
    if (!before.isFile() || !before.size) throw new Error('来源为空或不是普通文件');
    output = await open(partial, 'wx', 0o600);
    const hash = createHash('sha256'), chunk = Buffer.alloc(MAX_RESOURCE_READ);
    let offset = 0;
    while (offset < before.size) {
      const {bytesRead:n} = await input.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!n) throw new Error('来源复制不完整，请重试导入');
      for (let written = 0; written < n;) { const result=await output.write(chunk,written,n-written); if(!result.bytesWritten)throw new Error('资源写入不完整');written+=result.bytesWritten; }
      hash.update(chunk.subarray(0, n)); offset += n;
    }
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('原件在导入时变化，请重试');
    await output.sync(); await output.close(); output = undefined;
    const sha256 = hash.digest('hex'), byteLength = before.size;
    const verified = await hashFileAsync(partial);
    if (verified.sha256 !== sha256 || verified.byteLength !== byteLength) throw new Error('资源复制校验失败');
    if (restoreHash && sha256 !== restoreHash) throw new Error('所选原件与该版本哈希不同，不能替换旧引用');
    await validate(partial);
    beforePublish();
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('资源目录无效');
    const path = join(directory, sha256);
    try { linkSync(partial, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let intact = false;
      try { const existing = await hashFileAsync(path); intact = existing.sha256 === sha256 && existing.byteLength === byteLength; } catch { /* An explicit exact-hash repair may replace a broken entry. */ }
      beforePublish();
      if (!intact) {
        if (!restoreHash) throw new Error('已保存资源损坏，请从原件重试修复');
        renameSync(partial, path);
      }
    }
    const folder = openSync(directory, 'r');
    try { fsyncSync(folder); } finally { closeSync(folder); }
    return { path, sha256, byteLength };
  } finally {
    if (input !== undefined) await input.close();
    if (output !== undefined) await output.close();
    try { unlinkSync(partial); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
