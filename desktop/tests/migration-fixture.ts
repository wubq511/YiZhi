import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceFixture } from './source-fixture';
export async function legacyFixture(root: string) {
  await mkdir(join(root, '.review-board'), { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, '.review-board/service.lock'), '');
  await writeFile(join(root, 'data/map.json.content.lock'), '');
  await sourceFixture(join(root, '原始 资料.pdf'), 'Fixed legacy source');
  const sha256 = createHash('sha256').update(await readFile(join(root, '原始 资料.pdf'))).digest('hex');
  const first = JSON.parse(await readFile('fixtures/unit-001.json', 'utf8'));
  for (const block of first.reading.blocks) if (block.kind === 'knowledge-reference') block.payload.targetUnitId = 'KU-086';
  const last = { ...structuredClone(first), id: 'KU-086', name: '持久化末单元', themeId: 'TH-20', theme: undefined,
    reading: { schemaVersion: 'review-reading-1', revision: 7, status: 'complete', blocks: [
      { id: 'last-body', kind: 'paragraph', payload: { text: '末单元完整正文' } },
      { id: 'last-material', kind: 'exercise', role: 'material', payload: { title: '末单元练习', problem: '完整题干', answerNature: 'derived-solution' }, children: [
        { id: 'last-answer', kind: 'table', payload: { columns: ['条件', '结论'], rows: [['0', '1']] } },
        { id: 'opaque', kind: 'future-kind', payload: { nested: ['未知原始载荷', { n: 13 }] }, schema: 9 }] },
      { id: 'last-image', kind: 'figure', payload: { asset: '/source-pages/SRC-TEST/VER-TEST/1.png', alt: '实际固定来源第一页' }, sourceRefs: [{sourceId: 'SRC-TEST', versionId: 'VER-TEST', pdfPages: [1]}] }
    ] } };
  delete last.theme;
  const knowledge = { schemaVersion: 'midterm-map-1', course: { id: 'legacy-content-id', title: '课程标题差异' },
    themes: [{ id: 'TH-01', name: '数制与数制转换', rating: { stars: 5 } }, { id: 'TH-20', name: '末主题', rating: { stars: 3 } }], units: [first, last],
    questions: [{ id: 'Q-ROOT', label: '父题' }, { id: 'Q-LEAF', parentId: 'Q-ROOT', stem: '真实小问', solution: '原解', answerNature: 'derived-solution' }],
    referenceItems: [], questionCoverage: [], mappings: [{ id: 'MAP-ONE', unitId: 'KU-086', questionId: 'Q-LEAF', role: 'direct' }], relations: [], requirementGroups: [], retiredUnits: [{ id: 'KU-049', mergedInto: 'KU-046' }],
    sources: [{ id: 'SRC-TEST', title: '固定原件', path: '原始 资料.pdf', totalPages: 99, versions: [{ id: 'VER-TEST', sha256, path: '原始 资料.pdf', totalPages: 99 }] }], extra: { untouched: true } };
  const layout = { schemaVersion: 'midterm-layout-1', groups: [], edges: [], nodes: [
    { unitId: 'KU-001', x: 104, y: 168, width: 650, height: 86 }, { unitId: 'KU-086', x: 900, y: 168, width: 650, height: 86 }] };
  const manifest = { schemaVersion: 'review-course-1', courseId: 'COURSE-FIXTURE', name: '测试课程', knowledge: 'data/map.json', layout: 'data/layout.json', state: '.review-board/state.sqlite3' };
  const localRefs = (value: any) => { if (Array.isArray(value)) value.forEach(localRefs); else if (value && typeof value === 'object') {
    if (Array.isArray(value.sourceRefs)) value.sourceRefs = value.sourceRefs.map((ref: any) => ({ ...ref, sourceId:'SRC-TEST', versionId:'VER-TEST', pdfPages:[1] }));
    Object.values(value).forEach(localRefs);
  } };
  localRefs(knowledge);
  (last.reading.blocks[2] as any).sourceRefs[0].pdfPages = [2,1];
  await writeFile(join(root, '课程.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'data/map.json'), JSON.stringify(knowledge));
  await writeFile(join(root, 'data/layout.json'), JSON.stringify(layout));
  return { knowledge, layout, manifest, first, last };
}
