import { writeFile } from 'node:fs/promises';
/** Self-contained public-domain tagged PDF. No private course bytes. */
export async function parsingFixture(path: string, extraPages = 0) {
  const labels = ['Logic notes', 'A reliable tagged sample.', 'Input', 'Output', '0', '1', 'y = 1 - x'];
  const roles = ['H1','P','TH','TH','TD','TD','Formula'];
  const points = [[30,260,24],[30,230,12],[30,190,12],[160,190,12],[30,170,12],[160,170,12],[30,130,14]];
  const stream = labels.map((text,i) => `/${roles[i]} <</MCID ${i}>> BDC BT /F1 ${points[i][2]} Tf ${points[i][0]} ${points[i][1]} Td (${text}) Tj ET EMC`).join('\n') + '\n/Figure <</MCID 7>> BDC q 60 0 0 50 30 50 cm /Im1 Do Q EMC';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 9 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 300] /StructParents 0 /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 300] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>',
    '<< /Length 30 >>\nstream\nq 180 0 0 180 30 60 cm /Im1 Do Q\nendstream',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 9 >>\nstream\n00FFFF00>\nendstream',
    '<< /Type /StructTreeRoot /K [10 0 R] /ParentTree 23 0 R >>',
    '<< /Type /StructElem /S /Document /P 9 0 R /K [11 0 R 12 0 R 13 0 R 20 0 R 21 0 R] >>',
    '<< /Type /StructElem /S /H1 /P 10 0 R /Pg 3 0 R /K 0 >>',
    '<< /Type /StructElem /S /P /P 10 0 R /Pg 3 0 R /K 1 >>',
    '<< /Type /StructElem /S /Table /P 10 0 R /K [14 0 R 15 0 R] >>',
    '<< /Type /StructElem /S /TR /P 13 0 R /K [16 0 R 17 0 R] >>',
    '<< /Type /StructElem /S /TR /P 13 0 R /K [18 0 R 19 0 R] >>',
    '<< /Type /StructElem /S /TH /P 14 0 R /Pg 3 0 R /K 2 >>',
    '<< /Type /StructElem /S /TH /P 14 0 R /Pg 3 0 R /K 3 >>',
    '<< /Type /StructElem /S /TD /P 15 0 R /Pg 3 0 R /K 4 >>',
    '<< /Type /StructElem /S /TD /P 15 0 R /Pg 3 0 R /K 5 >>',
    '<< /Type /StructElem /S /Formula /P 10 0 R /Pg 3 0 R /K 6 >>',
    '<< /Type /StructElem /S /Figure /P 10 0 R /Pg 3 0 R /Alt (Checker diagram) /K 7 >>',
    'null', '<< /Nums [0 [11 0 R 12 0 R 16 0 R 17 0 R 18 0 R 19 0 R 20 0 R 21 0 R]] >>',
  ];
  for(let i=0;i<extraPages;i++) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 300] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>');
  objects[1]=`<< /Type /Pages /Kids [3 0 R 6 0 R ${Array.from({length:extraPages},(_,i)=>`${24+i} 0 R`).join(' ')}] /Count ${2+extraPages} >>`;
  let pdf = '%PDF-1.7\n% YiZhi synthetic tagged source\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path, pdf);
}
