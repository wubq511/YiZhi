import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { hashFile, publishResource } from './immutable-resource';
import { withPdf } from './source-pdf';
import type { TextItem, TextMarkedContent, StructTreeNode, StructTreeContent } from 'pdfjs-dist/types/src/display/api';
import type { ArtifactResource, Bounds, ParsedPage, ParseScheduling, ParseStructure, ParseText } from '../parsing-api';
import type { SourceVersion } from '../sources-api';

export const PARSE_TOOL = { name: 'PDF.js', version: '6.4.299', adapter: 'tagged-layout-v1' };
export const PARSE_CONFIG = { version: 1, ocr: 'none', rasterScale: 1 } as const;
function gate(buffer?: SharedArrayBuffer) {
  if (!buffer) return; const state = new Int32Array(buffer);
  Atomics.store(state, 0, 1); Atomics.notify(state, 0);
  while (Atomics.load(state, 1) === 0) Atomics.wait(state, 1, 0);
}
function union(bounds: Bounds[]): Bounds | undefined {
  if (!bounds.length) return;
  return [Math.min(...bounds.map(b=>b[0])), Math.min(...bounds.map(b=>b[1])), Math.max(...bounds.map(b=>b[2])), Math.max(...bounds.map(b=>b[3]))];
}
export async function publishBytes(directory: string, bytes: Uint8Array, mediaType: ArtifactResource['mediaType']): Promise<ArtifactResource> {
  const temp = mkdtempSync(join(directory, '.parse-'));
  try {
    const path = join(temp, 'output'); writeFileSync(path, bytes);
    const result = await publishResource(directory, path, async () => {});
    return { sha256: result.sha256, byteLength: result.byteLength, relativePath: `resources/${result.sha256}`, mediaType };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
export async function parsePage(directory: string, source: SourceVersion, pdfPageIndex: number): Promise<ParsedPage> {
  const path = join(directory, 'resources', source.sha256);
  const input = hashFile(path);
  if (input.sha256 !== source.sha256 || input.byteLength !== source.byteLength) throw new Error('解析输入副本损坏或与固定版本不符');
  return withPdf(path, async doc => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (pdfjs.version !== PARSE_TOOL.version) throw new Error('解析工具版本与登记版本不符');
    const page = await doc.getPage(pdfPageIndex + 1);
    const content = await page.getTextContent({ includeMarkedContent: true });
    const text: ParseText[] = [], marks: string[] = [];
    for (const entry of content.items) {
      if (!('str' in entry)) {
        const marker = entry as TextMarkedContent;
        if (marker.type === 'endMarkedContent') marks.pop();
        else marks.push(marker.id ?? '');
        continue;
      }
      const item = entry as TextItem, [a,b,c,d,x,y] = item.transform;
      if (!item.str.trim()) continue;
      const h = Math.hypot(c,d) || item.height, w = item.width;
      const angle = Math.atan2(b,a), ux = Math.cos(angle), uy = Math.sin(angle);
      const ascent=content.styles[item.fontName]?.ascent ?? 1;
      const bottom=h*(ascent-1),top=h*ascent;
      const corners = [[x-bottom*uy,y+bottom*ux],[x+w*ux-bottom*uy,y+w*uy+bottom*ux],[x-top*uy,y+top*ux],[x+w*ux-top*uy,y+w*uy+top*ux]];
      const bounds: Bounds = [Math.min(...corners.map(p=>p[0])), Math.min(...corners.map(p=>p[1])), Math.max(...corners.map(p=>p[0])), Math.max(...corners.map(p=>p[1]))];
      text.push({ id: `text-${text.length}`, text: item.str, bounds, markedContentId: marks.at(-1) || null, font: item.fontName, direction: item.dir, transform: item.transform, width: item.width, height: item.height });
    }
    const tree = await page.getStructTree();
    function structure(node: StructTreeNode | StructTreeContent): ParseStructure {
      if ('type' in node) return { role: node.type, id: node.id, children: [], bounds: union([...text.filter(t=>t.markedContentId === node.id).map(t=>t.bounds),...images.filter(image=>image.markedContentId===node.id).map(image=>image.bounds)]) };
      const children = node.children.map(structure);
      return { role: node.role, ...((node as StructTreeNode & {alt?:string}).alt ? {alt:(node as StructTreeNode & {alt?:string}).alt}:{}), children, bounds: union(children.flatMap(n=>n.bounds ? [n.bounds] : [])) };
    }
    const images: ParsedPage['images'] = [];
    const markIds=new Map<number,string>();
    function collect(node:StructTreeNode|StructTreeContent) {
      if('type' in node) {const match=/_mc(\d+)$/.exec(node.id);if(match)markIds.set(Number(match[1]),node.id);}
      else node.children.forEach(collect);
    }
    if(tree)collect(tree);
    const imageMarks:Array<string|null>=[];
    const ops = await page.getOperatorList();
    let transform = [1,0,0,1,0,0], stack: number[][] = [];
    for (let i=0;i<ops.fnArray.length;i++) {
      const op=ops.fnArray[i], args=ops.argsArray[i];
      if(op===pdfjs.OPS.beginMarkedContentProps) imageMarks.push(markIds.get(args[1])??null);
      else if(op===pdfjs.OPS.beginMarkedContent) imageMarks.push(null);
      else if(op===pdfjs.OPS.endMarkedContent) imageMarks.pop();
      else if(op===pdfjs.OPS.paintFormXObjectBegin) {stack.push([...transform]);if(args[0])transform=pdfjs.Util.transform(transform,args[0]);}
      else if(op===pdfjs.OPS.paintFormXObjectEnd) transform=stack.pop()??[1,0,0,1,0,0];
      else if (op===pdfjs.OPS.save) stack.push([...transform]);
      else if (op===pdfjs.OPS.restore) transform=stack.pop() ?? [1,0,0,1,0,0];
      else if (op===pdfjs.OPS.transform) transform=pdfjs.Util.transform(transform,args);
      else if ([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageMaskXObject].includes(op)) {
        const corners=[[0,0],[1,0],[0,1],[1,1]].map(p=>{pdfjs.Util.applyTransform(p,transform);return p;});
        images.push({ id:`image-${images.length}`, markedContentId:imageMarks.at(-1)??null, bounds:[Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1]))], representation:'page-raster-region' });
      }
    }
    const { createCanvas } = await import('@napi-rs/canvas');
    const viewport = page.getViewport({ scale: 1 });
    if (viewport.width * viewport.height > 16_000_000) throw new Error('页面过大，超出当前逐页图像上限');
    const canvas = createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
    const raster = await publishBytes(join(directory,'resources'),canvas.toBuffer('image/png'),'image/png');
    const result: ParsedPage = { schema:'yizhi-pdf-page-v1',source,pdfPageIndex,view:page.view as Bounds,rotation:page.rotate,
      coordinateSpace:'pdf-user-space',tool:PARSE_TOOL,config:PARSE_CONFIG,textStatus:text.length?'text-layer':'ocr-needed',text,
      structure:tree?structure(tree):null,images,resources:[raster],
      limitations:['文字按 PDF 字形位置保存，不证明阅读顺序或语义正确。','表格、公式与层级只保留 PDF 原生标签；无标签时不猜测语义。','PDF.js 未暴露的表格合并属性不推断；合并单元格与复杂排版以原页图像为准。','图片保留整页图像与普通图像绘制包围框；裁剪、重复图像或矢量图在原页核对，未做图像语义识别。',...(text.length?[]:['没有可靠文本层，需要另行 OCR；未识别或虚构文字。'])] };
    page.cleanup(); return result;
  });
}
// Importing publication helpers in Core must not start a tool.
if (workerData?.kind === 'parse-page') {
  const { directory, source, pageIndex, scheduling } = workerData as { directory: string; source: SourceVersion; pageIndex: number; scheduling?: ParseScheduling };
  void (async () => {
    try {
      if (scheduling?.pageIndex === pageIndex) gate(scheduling.beforeCompute);
      const page = await parsePage(directory,source,pageIndex);
      const encoded=Buffer.from(JSON.stringify(page));
      if(encoded.length>8_000_000)throw new Error('页面结构化产物超出当前 8 MB 读取上限');
      const resource = await publishBytes(join(directory,'resources'),encoded,'application/json');
      if (scheduling?.pageIndex === pageIndex) gate(scheduling.beforeResult);
      parentPort!.postMessage({ ok:true, resource, resources:page.resources });
    } catch (error) { parentPort!.postMessage({ ok:false, error:(error as Error).message }); }
    finally { parentPort!.close(); }
  })();
}
