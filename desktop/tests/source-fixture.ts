import { writeFile } from 'node:fs/promises';

/** Tiny synthetic PDF fixtures, generated at runtime; never copied course material. */
export async function sourceFixture(path: string, text = 'Original course evidence', padding = 0) {
  const escaped = text.replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 20 Tf 32 240 Td (${escaped}) Tj 0 -35 Td (Second line of evidence) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 300] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>',
    '<< /Length 29 >>\nstream\nq 180 0 0 180 30 60 cm /Im1 Do Q\nendstream',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 10 >>\nstream\n00FFFF00>\nendstream',
  ];
  let pdf = '%PDF-1.7\n% Synthetic YiZhi test fixture\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  if (padding) pdf += '%' + 'x'.repeat(padding) + '\n';
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path, pdf);
}
