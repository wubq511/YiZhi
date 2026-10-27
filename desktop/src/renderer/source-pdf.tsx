import { useEffect, useRef } from 'react';
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, TextLayer, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist/types/src/display/page_viewport';
import type { SourcePage, SourceVersion, CiteSource, SourceCitation } from '../sources-api';

GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.mjs', location.href).href;
export type SourceSelection = Pick<CiteSource, 'projectionId' | 'start' | 'end' | 'region'>;
export const resourceURL = (sessionId: string, versionId: string) => `yizhi-resource://course/${sessionId}/${versionId}`;

/** One page, one canvas, one text layer; destroy the PDF worker/cache on page or version change. */
export function SourcePdf({ sessionId, version, page, scale, regionMode, citation, onSelection, onReady, onError }: {
  sessionId: string; version: SourceVersion; page: SourcePage; scale: number; regionMode: boolean;
  citation?: SourceCitation | null;
  onSelection(value: SourceSelection | null): void; onReady(position?: { x: number; y: number }): void; onError(error: Error): void;
}) {
  const container = useRef<HTMLDivElement>(null), layerRef = useRef<TextLayer | null>(null);
  const viewportRef = useRef<PageViewport | null>(null);
  const callbacks = useRef({ onSelection, onReady, onError }); callbacks.current = { onSelection, onReady, onError };
  const drag = useRef<{ x: number; y: number } | null>(null), rubberband = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current!;
    let disposed = false, task: PDFDocumentLoadingTask | undefined, render: RenderTask | undefined, textLayer: TextLayer | undefined;
    const abort = new AbortController();
    callbacks.current.onSelection(null); host.replaceChildren();
    const complete = () => {
      let position: { x: number; y: number } | undefined;
      if (citation?.region) {
        const r = citation.region;
        const viewport = viewportRef.current;
        const rect = viewport ? [...viewport.convertToViewportPoint(r.x0, r.y0), ...viewport.convertToViewportPoint(r.x1, r.y1)] : [r.x0 * scale, r.y0 * scale, r.x1 * scale, r.y1 * scale];
        const marker = document.createElement('div'); marker.className = 'source-citation-marker';
        marker.setAttribute('aria-label', '引用原选区');
        position = { x: Math.min(rect[0], rect[2]), y: Math.min(rect[1], rect[3]) };
        Object.assign(marker.style, { left: `${position.x}px`, top: `${position.y}px`, width: `${Math.abs(rect[2] - rect[0])}px`, height: `${Math.abs(rect[3] - rect[1])}px` });
        host.append(marker);
      }
      callbacks.current.onReady(position);
    };
    const run = async () => {
      const url = resourceURL(sessionId, version.versionId);
      if (version.mediaType !== 'application/pdf') {
        const image = document.createElement('img'); image.alt = version.title; image.src = url;
        image.width = (page.view[2] - page.view[0]) * scale;
        host.append(image);
        await image.decode();
        if (!disposed) complete();
        return;
      }
      const base = new URL('./pdfjs/', location.href).href;
      // PDF.js's automatic HTTP-range detection excludes custom protocols. Supply its public
      // range transport explicitly so a local scheme never silently falls back to a whole PDF.
      const chunks = new Map<number, Uint8Array>();
      const readRange = async (begin: number, end: number) => {
        const result = new Uint8Array(end - begin);
        for (let offset = begin; offset < end;) {
          const start = Math.floor(offset / 65536) * 65536, stop = Math.min(start + 65536, version.byteLength);
          let bytes = chunks.get(start);
          if (!bytes) {
            const response = await fetch(url, { headers: { Range: `bytes=${start}-${stop - 1}` }, signal: abort.signal, cache: 'no-store' });
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${stop - 1}/${version.byteLength}`)
              throw new Error('本地来源读取失败，请重试原页或从原件修复');
            bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length !== stop - start) throw new Error('本地来源读取不完整');
            chunks.set(start, bytes); if (chunks.size > 8) chunks.delete(chunks.keys().next().value!);
          }
          const length = Math.min(end, stop) - offset;
          result.set(bytes.subarray(offset - start, offset - start + length), offset - begin); offset += length;
        }
        return result;
      };
      const range = new PDFDataRangeTransport(version.byteLength, await readRange(0, Math.min(65536, version.byteLength)));
      range.requestDataRange = (begin, end) => {
        void readRange(begin, end).then(bytes => { if (!disposed) range.onDataRange(begin, bytes); }).catch(error => {
          if (!disposed) { callbacks.current.onError(error); void task?.destroy(); }
        });
      };
      range.abort = () => abort.abort();
      task = getDocument({ range, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536,
        cMapUrl: `${base}cmaps/`, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`,
        iccUrl: `${base}iccs/`, useWorkerFetch: true, useSystemFonts: false, stopAtErrors: true });
      const doc = await task.promise;
      if (disposed) return;
      const pdfPage = await doc.getPage(page.pdfPageIndex + 1);
      if (disposed) return;
      const viewport = pdfPage.getViewport({ scale }); viewportRef.current = viewport;
      host.style.width = `${viewport.width}px`; host.style.height = `${viewport.height}px`;
      host.style.setProperty('--total-scale-factor', String(scale));
      const canvas = document.createElement('canvas');
      // High DPI without an unbounded canvas allocation (max 16M pixels, one current page).
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute('aria-label', `${version.title} · PDF 第 ${page.pdfPageIndex + 1} 页`);
      const layer = document.createElement('div'); layer.className = 'textLayer';
      host.append(canvas, layer);
      render = pdfPage.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      const content = await pdfPage.getTextContent();
      if (disposed) return;
      textLayer = new TextLayer({ textContentSource: content, container: layer, viewport });
      layerRef.current = textLayer;
      await Promise.all([render.promise, textLayer.render()]);
      if (!disposed) complete();
    };
    void run().catch(error => { if (!disposed) callbacks.current.onError(error); });
    const selection = () => {
      if (disposed || !layerRef.current) return;
      const selected = getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) return;
      const range = selected.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return;
      const point = (node: Node, offset: number) => {
        const i = layerRef.current!.textDivs.findIndex(span => span === node || span.contains(node));
        if (i < 0 || !page.projection.items[i]) return null;
        const span = layerRef.current!.textDivs[i], item = page.projection.items[i];
        if (span.textContent !== item.text) return null; // Never apply a different extraction projection.
        const prefix = document.createRange(); prefix.selectNodeContents(span); prefix.setEnd(node, offset);
        return item.start + Array.from(prefix.toString()).length;
      };
      const start = point(range.startContainer, range.startOffset), end = point(range.endContainer, range.endOffset);
      if (start === null || end === null || end <= start) return;
      const rect = range.getBoundingClientRect(), box = host.getBoundingClientRect();
      const region = pdfRegion(rect.left - box.left, rect.top - box.top, rect.right - box.left, rect.bottom - box.top);
      callbacks.current.onSelection({ projectionId: page.projection.id, start, end, region });
    };
    document.addEventListener('selectionchange', selection);
    return () => {
      disposed = true; document.removeEventListener('selectionchange', selection);
      abort.abort();
      render?.cancel(); textLayer?.cancel(); layerRef.current = null; viewportRef.current = null;
      void task?.destroy(); host.replaceChildren();
    };
  }, [sessionId, version.versionId, page.pdfPageIndex, page.projection.id, scale, citation?.id]);
  const pdfRegion = (x0: number, y0: number, x1: number, y1: number) => {
    const box = container.current!.getBoundingClientRect();
    const clampX = (x: number) => Math.max(0, Math.min(box.width, x)), clampY = (y: number) => Math.max(0, Math.min(box.height, y));
    const point = (x: number, y: number) => viewportRef.current?.convertToPdfPoint(clampX(x), clampY(y)) ?? [clampX(x) / scale, clampY(y) / scale];
    const a = point(x0, y0), b = point(x1, y1);
    return { x0: Math.max(page.view[0], Math.min(a[0], b[0])), y0: Math.max(page.view[1], Math.min(a[1], b[1])),
      x1: Math.min(page.view[2], Math.max(a[0], b[0])), y1: Math.min(page.view[3], Math.max(a[1], b[1])) };
  };
  return <div className="source-page-frame"><div ref={container} className="source-pdf" />
    {regionMode && <div className="source-region-picker" aria-label="拖动选取原页区域" onPointerDown={event => {
      const box = event.currentTarget.getBoundingClientRect(); drag.current = { x: event.clientX - box.left, y: event.clientY - box.top };
      event.currentTarget.setPointerCapture(event.pointerId); callbacks.current.onSelection(null);
    }} onPointerMove={event => {
      if (!drag.current) return;
      const box = event.currentTarget.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
      if (rubberband.current) Object.assign(rubberband.current.style, { display: 'block', left: `${Math.min(x, drag.current.x)}px`, top: `${Math.min(y, drag.current.y)}px`, width: `${Math.abs(x - drag.current.x)}px`, height: `${Math.abs(y - drag.current.y)}px` });
    }} onPointerUp={event => {
      if (!drag.current) return;
      const box = event.currentTarget.getBoundingClientRect(), region = pdfRegion(drag.current.x, drag.current.y, event.clientX - box.left, event.clientY - box.top);
      drag.current = null;
      if (region.x1 - region.x0 > 1 && region.y1 - region.y0 > 1) callbacks.current.onSelection({ region });
    }} onPointerCancel={() => { drag.current = null; if (rubberband.current) rubberband.current.style.display = 'none'; }}><div ref={rubberband} className="source-rubberband" /></div>}
  </div>;
}
