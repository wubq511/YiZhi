import type { ParsedPage } from '../parsing-api';
import type { EvidenceIds, FiniteExample } from '../generation-api';

type Cell = { id: string; text: string; x: number; y: number };
type Row = { cells: Cell[]; y: number };
const signals = ['B','A','C0','C1','C2','C3','G','OUTPUT Y'] as const;
const bit = (s: string) => s === 'L' ? 0 : s === 'H' ? 1 : -1;
const center = (bounds: number[], axis: 0|1) => (bounds[axis] + bounds[axis+2]) / 2;

/** Read the actual eight-column L/H/X rows from their PDF coordinates. This is
 * independent of the application's Boolean formula/evaluator path. Untagged
 * pages are explicitly accepted as positioned text plus original page raster.
 */
export function selectorEvidence(page: ParsedPage) {
  if(page.textStatus!=='text-layer'||page.coordinateSpace!=='pdf-user-space'||!page.resources.some(r=>r.mediaType==='image/png'))
    throw new Error('来源页缺少可回查的文本与原页图像，不能核对本样本');
  const headers = signals.map(name => {
    const item = page.text.find(t => t.text.trim() === name);
    if(!item)throw new Error(`来源表缺少 ${name} 列头`);
    return {id:item.id,x:center(item.bounds,0),y:center(item.bounds,1)};
  });
  const headerY=Math.min(...headers.slice(0,7).map(h=>h.y));
  const cells:Cell[]=page.text.filter(t=>/^[LHX]$/.test(t.text.trim())&&center(t.bounds,1)<headerY-3)
    .map(t=>({id:t.id,text:t.text.trim(),x:center(t.bounds,0),y:center(t.bounds,1)}));
  const rows:Row[]=[];
  for(const cell of cells.sort((a,b)=>b.y-a.y)) {
    let row=rows.find(r=>Math.abs(r.y-cell.y)<3);
    if(!row){row={y:cell.y,cells:[]};rows.push(row);}
    row.cells.push(cell);
  }
  if(rows.length!==9)throw new Error('来源表格行数不符合禁用态加四通道两输出行');
  const aligned=rows.map(row=>{
    const result:Array<Cell|undefined>=Array(8).fill(undefined);
    for(const cell of row.cells){
      const nearest=headers.map((h,i)=>({i,d:Math.abs(h.x-cell.x)})).sort((a,b)=>a.d-b.d)[0];
      if(nearest.d>35||result[nearest.i])throw new Error('来源表格列位置不唯一，不能推断输出');
      result[nearest.i]=cell;
    }
    if(result.some(c=>!c))throw new Error('来源表格缺列，不足以核对所有通道');
    return result as Cell[];
  });
  const disabled=aligned.find(r=>r[6].text==='H');
  if(!disabled||disabled[7].text!=='L'||disabled.slice(0,6).some(c=>c.text!=='X'))throw new Error('来源禁用态与低有效使能含义不一致');
  const active=aligned.filter(r=>r[6].text==='L');
  if(active.length!==8)throw new Error('来源缺少四通道的两种数据输出');
  const table:Array<{select:string;data:string;output:number;evidenceIds:string[]}>=[];
  for(let select=0;select<4;select++)for(let data=0;data<2;data++){
    const b=(select>>1)&1,a=select&1;
    const matches=active.filter(r=>bit(r[0].text)===b&&bit(r[1].text)===a&&bit(r[2+select].text)===data);
    if(matches.length!==1||matches[0][7].text!==(data?'H':'L')||matches[0].slice(2,6).some((c,i)=>i!==select&&c.text!=='X'))
      throw new Error(`来源表格 ${b}${a} 通道的 L/H 行不完整或矛盾`);
    table.push({select:`${b}${a}`,data:data?'H':'L',output:data,evidenceIds:matches[0].map(c=>c.id)});
  }
  const selectedDataIds=table.map(row=>row.evidenceIds[2+parseInt(row.select,2)]);
  const evidenceIds:EvidenceIds={
    enable:[headers[6].id,disabled[6].id,disabled[7].id,active[0][6].id],
    selection:headers.map(h=>h.id), formula:selectedDataIds,
    example:selectedDataIds,exercise:selectedDataIds,
  };
  return {table,evidenceIds,disabledEvidenceIds:disabled.map(c=>c.id),
    expected:Object.fromEntries(Array.from({length:64},(_,n)=>{
      const b=(n>>5)&1,a=(n>>4)&1,data=[(n>>3)&1,(n>>2)&1,(n>>1)&1,n&1];
      const selected=2*b+a, row=table.find(r=>r.select===`${b}${a}`&&r.data===(data[selected]?'H':'L'))!;
      return [`${b}${a}${data.join('')}`,row.output];
    }))};
}

export function exampleEvidence(example: FiniteExample, table: ReturnType<typeof selectorEvidence>) {
  const names=['S1','S0','I0','I1','I2','I3'] as const;
  if(!example||names.some(n=>![0,1].includes(example.inputs?.[n]))||Object.keys(example.inputs).length!==6||![0,1].includes(example.output))
    throw new Error('例练输入须完整声明六个布尔位和预期输出');
  const select=`${example.inputs.S1}${example.inputs.S0}`;
  const data=example.inputs[`I${2*example.inputs.S1+example.inputs.S0}` as 'I0'];
  const row=table.table.find(r=>r.select===select&&r.data===(data?'H':'L'))!;
  if(example.output!==row.output)throw new Error('例练答案与来源表格选通结果不一致');
  return row.evidenceIds[2+parseInt(select,2)];
}
