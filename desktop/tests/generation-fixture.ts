import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CourseService} from '../src/core/course-service';
// An independent, untagged PDF at the public Sources -> Parsing seam. Its active-low
// table has the same finite semantics as the real TI acceptance source.
export async function tablePdf(path: string) {
  const labels = ['7.3', 'Device Functional Modes', 'B', 'A', 'C0', 'C1', 'C2', 'C3', 'G', 'OUTPUT Y'];
  const xs = [36, 72, 40, 80, 120, 160, 200, 240, 280, 320];
  const cells = [
    ['X','X','X','X','X','X','H','L'],
    ['L','L','L','X','X','X','L','L'], ['L','L','H','X','X','X','L','H'],
    ['L','H','X','L','X','X','L','L'], ['L','H','X','H','X','X','L','H'],
    ['H','L','X','X','L','X','L','L'], ['H','L','X','X','H','X','L','H'],
    ['H','H','X','X','X','L','L','L'], ['H','H','X','X','X','H','L','H'],
  ];
  const at = (value: string, x: number, y: number) => `BT /F1 8 Tf ${x} ${y} Td (${value}) Tj ET`;
  const stream = labels.map((v, i) => at(v, xs[i], i < 2 ? 280 - i * 14 : 250)).join('\n') + '\n' +
    cells.flatMap((row, i) => row.map((v, j) => at(v, 40 + j * 40, 228 - i * 16))).join('\n') +
    '\n1 w 279 260 m 288 260 l S';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  objects.forEach((v, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${v}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(path, pdf);
}

export async function prepared(core: CourseService, root: string, directory=join(root,'course')) {
  const opened = await core.open(directory); const sessionId = opened.sessionId;
  const path = join(root, 'table.pdf'); await tablePdf(path);
  const version = (await core.sources.importFile({ sessionId, operationId: 'table-source', generation: 1, path, title: 'Finite selector table' })).version;
  const parsing = await core.parsing.start({ sessionId, operationId: 'table-parse', generation: 1, versionId: version.versionId });
  let artifact;
  for (let i = 0; i < 200; i++) {
    const state = await core.parsing.get({ sessionId, taskId: parsing.taskId });
    if (state.status === 'completed') { artifact = state.confirmed[0]; break; }
    if (state.status === 'failed') throw new Error(state.failure);
    await new Promise(done => setTimeout(done, 10));
  }
  assert.ok(artifact, 'actual parser confirmed the source page');
  const conversation = await core.agent.create({ sessionId, operationId: 'conversation' });
  const task = await core.agent.submit({ sessionId, conversationId: conversation.id, operationId: 'generate', generation: 1,
    intent: 'generate', text: '从此页生成独立的单通道四选一主题，含完整解释与例练', target: { unitId: 'KU-001' },
    generationSpec: { unitId: 'KU-GEN-MUX-01', themeId: 'TH-GEN-MUX-01', themeName: '四选一数据选择',
      sourceVersionId: version.versionId, artifactId: artifact.artifactId, pdfPageIndex: 0 } });
  return { sessionId, task, conversation, opened };
}

export function lesson(basis: Awaited<ReturnType<CourseService['readAgentGeneration']>>, operationId: string) {
  return { operationId, basisId: basis.basisId, stage: 'lesson' as const,
    title: '四选一数据选择', outcome: '能解释低有效使能与选择信号，并独立计算一个通道的输出。',
    intro: '本主题只讨论表中 G 低（Gbar=0）这一通道。B、A 是选择输入，令 S1=B、S0=A；C0、C1、C2、C3 分别记作数据输入 I0、I1、I2、I3；输出 Y 记作 Z。G 低是低有效使能条件，此时选择输入决定哪一路数据传到输出。G 高时表中 Y=L，因此本主题的四选一选择规则仅在 Gbar=0 时使用。',
    derivation: '00→C0，01→C1，10→C2，11→C3；其余数据位为 X。' + '将选择码的四种情况分别乘上对应数据输入并相加，输出等于被选中的输入。'.repeat(3),
    formula: 'Z=¬S1·¬S0·I0+¬S1·S0·I1+S1·¬S0·I2+S1·S0·I3',
    example: { problem: 'S1=0、S0=1、I1=1 时，单通道输出 Z 是多少？', steps: '01 对应 C1，也就是 I1；其余输入是 X，不决定本次输出。', answer: 'Z=1，因为选中的 I1=1。', inputs: { S1:0,S0:1,I0:0,I1:1,I2:0,I3:0 }, output: 1 },
    exercise: { problem: 'S1=1、S0=0、I2=1 时，单通道输出 Z 是多少？', hint: '先把选择码 10 对应到一个 C 输入，再读该输入值。', answer: 'Z=1，因为 10 选 C2=I2，而 I2=1。', inputs: { S1:1,S0:0,I0:0,I1:0,I2:1,I3:0 }, output: 1 },
    evidence: basis.evidenceIds };
}
export function practice(basis:Awaited<ReturnType<CourseService['readAgentGeneration']>>,operationId:string){
  return {operationId,basisId:basis.basisId,stage:'practice' as const,
    exercise:{problem:'S1=1、S0=1、I3=0 时，单通道输出 Z 是多少？',hint:'11 选择 C3=I3。',answer:'Z=0，因为所选 I3=0。',inputs:{S1:1,S0:1,I0:1,I1:1,I2:1,I3:0},output:0},
    evidence:{enable:[],selection:[],formula:[],example:[],exercise:basis.evidenceIds.exercise}};
}

