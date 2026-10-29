import { protocol } from 'electron';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CourseService } from '../core/course-service';

/** No path translation for course assets: only a current session + registered immutable version. */
export function registerSourceProtocols(core: CourseService, rendererDirectory: string) {
  const assets = new Map<string, string>();
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const route = `${prefix}/${entry.name}`, path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, route);
      else if (entry.isFile()) assets.set(route, path);
    }
  };
  walk(rendererDirectory);
  const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', png: 'image/png', jpg: 'image/jpeg', wasm: 'application/wasm', svg: 'image/svg+xml' };
  protocol.handle('yizhi-app', request => {
    const url = new URL(request.url), path = assets.get(url.pathname);
    if (request.method !== 'GET' || url.hostname !== 'app' || url.username || url.password || url.search || !path)
      return new Response('未登记的应用资源', { status: 404 });
    return new Response(readFileSync(path), { headers: { 'Content-Type': types[path.split('.').at(-1)!] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } });
  });
  protocol.handle('yizhi-resource', async request => {
    try {
      const url = new URL(request.url);
      const contentAsset = /^\/([a-f0-9-]{36})\/content\/(.+)$/.exec(url.pathname);
      if (contentAsset && url.hostname === 'course' && !url.username && !url.password && !url.search && request.method === 'GET') {
        const result = await core.resources.read({ sessionId: contentAsset[1], asset: decodeURIComponent(contentAsset[2]) });
        return new Response(new Uint8Array(result.bytes).buffer, { headers: { 'Content-Type': result.mediaType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'yizhi-app://app', 'X-Content-Type-Options': 'nosniff' } });
      }
      const match = /^\/([a-f0-9-]{36})\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname),
        artifact = /^\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(url.pathname);
      if ((!match && !artifact) || url.hostname !== 'course' || url.username || url.password || url.search || !['GET', 'HEAD'].includes(request.method))
        return new Response('未登记的来源资源', { status: 404 });
      const [, sessionId, versionId] = (match ?? artifact)!;
      const read = (begin: number, end: number) => artifact ? core.parsing.readResource({sessionId,artifactId:versionId,sha256:artifact[3],begin,end}) : core.sources.readResource({sessionId,versionId,begin,end});
      const info = artifact ? await read(0,1) : undefined;
      const version = info ? {byteLength:info.total,mediaType:info.mediaType} : await core.sources.getVersion({ sessionId, versionId });
      const header = request.headers.get('range');
      const range = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
      if (header && !range) return new Response('资源范围无效', { status: 416 });
      const begin = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) + 1 : version.byteLength;
      if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || begin >= end || end > version.byteLength)
        return new Response('资源范围无效', { status: 416, headers: { 'Content-Range': `bytes */${version.byteLength}` } });
      // Validate before headers, then read at most 1 MiB per pull. Never buffer the whole PDF in the host.
      const first = await read(begin, Math.min(end, begin + 65536));
      const headers: Record<string, string> = { 'Content-Type': version.mediaType, 'Content-Length': String(end - begin),
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'yizhi-app://app',
        'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Length,Content-Range', 'X-Content-Type-Options': 'nosniff' };
      if (range) headers['Content-Range'] = `bytes ${begin}-${end - 1}/${version.byteLength}`;
      let offset = begin;
      const body = request.method === 'HEAD' ? null : new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const bytes = offset === begin ? first.bytes : (await read(offset, Math.min(end, offset + 65536))).bytes;
            controller.enqueue(bytes); offset += bytes.length;
            if (offset >= end) controller.close();
          } catch (error) { controller.error(error); }
        },
      });
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch { return new Response('来源缺失、损坏或会话已失效，请重试', { status: 404, headers: { 'Access-Control-Allow-Origin': 'yizhi-app://app' } }); }
  });
}
