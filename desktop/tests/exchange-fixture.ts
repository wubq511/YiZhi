import { createHash } from 'node:crypto';
import { sourceFixture } from './source-fixture';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { legacyFixture } from './migration-fixture';
export async function exchangeFixture(directory: string, lastId = 'KU-086') {
  await legacyFixture(directory);
  const path = join(directory, 'data/map.json');
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.units[1].reading.blocks[1].children.pop();
  data.units[1].reading.blocks.push({
    id: 'portable-diagram',
    kind: 'figure',
    payload: {
      alt: '可交换结构图',
      config: {
        nodes: [
          { id: 'A', label: '输入', x: 50, y: 50 },
          { id: 'B', label: '输出', x: 200, y: 50 },
        ],
        edges: [{ from: 'A', to: 'B' }],
      },
    },
  });
  data.units[0].reading.blocks = data.units[0].reading.blocks.filter((b: any) => b.kind !== 'knowledge-reference');
  if (lastId !== 'KU-086') {
    data.units[1].id = lastId;
    data.units[1].name = '已有的独立单元';
    const rename = (bs: any[]) => {
      for (const b of bs) {
        b.id += '-other';
        if (b.children) rename(b.children);
      }
    };
    rename(data.units[1].reading.blocks);
    data.mappings[0].unitId = lastId;
    const layout = JSON.parse(await readFile(join(directory, 'data/layout.json'), 'utf8'));
    layout.nodes[1].unitId = lastId;
    await writeFile(join(directory, 'data/layout.json'), JSON.stringify(layout));
  }
  data.relations = [
    {
      id: 'REL-EXCHANGE',
      fromUnitId: 'KU-001',
      toUnitId: 'KU-086',
      type: 'constructs',
      directed: true,
      view: 'main',
      value: '交换包正式关系',
      sourceRefs: [{ sourceId: 'SRC-TEST', versionId: 'VER-TEST', pdfPages: [1] }],
    },
  ];
  if (lastId !== 'KU-086') data.relations = [];
  else {
    const originalName = '新增 Fixed Source.PDF';
    await sourceFixture(join(directory, originalName), 'Independent fixed source');
    const sha256 = createHash('sha256')
      .update(await readFile(join(directory, originalName)))
      .digest('hex');
    data.sources.push({
      id: 'SRC-EXTRA',
      title: '独立新增固定来源',
      path: originalName,
      totalPages: 2,
      versions: [{ id: 'VER-EXTRA', sha256, path: originalName, totalPages: 2 }],
    });
    const changeRefs = (v: any) => {
      if (Array.isArray(v)) v.forEach(changeRefs);
      else if (v && typeof v === 'object') {
        if (v.sourceRefs)
          for (const r of v.sourceRefs) {
            r.sourceId = 'SRC-EXTRA';
            r.versionId = 'VER-EXTRA';
          }
        Object.values(v).forEach(changeRefs);
      }
    };
    changeRefs(data.units[1]);
    data.units[1].reading.blocks[2].payload.asset = '/source-pages/SRC-EXTRA/VER-EXTRA/1.png';
  }
  await writeFile(path, JSON.stringify(data));
}
