import { openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** PDF.js parsing also uses bounded range reads inside the one host-owned core Worker. */
export async function withPdf<T>(path: string, use: (document: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), length = fstatSync(fd).size;
  const read = (begin: number, end: number) => {
    const bytes = new Uint8Array(end - begin);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, begin + read);
      if (!n) throw new Error('PDF 读取不完整');
      read += n;
    }
    return bytes;
  };
  let rejectRead: (error: Error) => void;
  const readFailure = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  const range = new pdfjs.PDFDataRangeTransport(length, read(0, Math.min(65536, length)));
  range.requestDataRange = (begin, end) => { queueMicrotask(() => {
    try { range.onDataRange(begin, read(begin, end)); } catch (error) { rejectRead(error as Error); }
  }); };
  const assets = dirname(createRequire(__filename).resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({ range, disableAutoFetch: true, disableStream: true,
    cMapUrl: join(assets, 'cmaps/'), standardFontDataUrl: join(assets, 'standard_fonts/'), wasmUrl: join(assets, 'wasm/'),
    iccUrl: join(assets, 'iccs/'), useWorkerFetch: false, useSystemFonts: false, stopAtErrors: true, verbosity: 0 });
  try { return await Promise.race([use(await Promise.race([task.promise, readFailure])), readFailure]); }
  finally { try { await task.destroy(); } finally { closeSync(fd); } }
}
