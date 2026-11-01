import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectReadingLayout } from '../src/layout';
import { projectBoard } from '../src/board-layout';
import type { CourseGraph } from '../src/shared';

test('legacy narrow cards use their real reading width for collision and route projection without changing the baseline', () => {
  const baseline = [
    { unitId: 'a', x: -300, y: 200, width: 200, height: 100 },
    { unitId: 'block', x: 0, y: 0, width: 200, height: 150 },
    { unitId: 'b', x: 300, y: 0, width: 200, height: 100 },
  ];
  const saved = structuredClone(baseline), projected = projectReadingLayout(baseline, {});
  assert.deepEqual(baseline, saved);
  assert.ok(projected.every(node => node.width === 650));
  for (let i = 0; i < projected.length; i++) for (let j = i + 1; j < projected.length; j++) {
    const a = projected[i], b = projected[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
  const graph: CourseGraph = {
    groups: [{ id: 'theme', name: 'Theme' }],
    nodes: baseline.map(n => ({ id: n.unitId, name: n.unitId, kind: 'unit', themeId: 'theme', themeName: 'Theme', stars: 1 })),
    edges: [{ id: 'link', fromUnitId: 'a', toUnitId: 'b', type: 'constructs', directed: true, view: 'main', value: '', sourceRefs: [] }],
    requirementGroups: [], conditions: {}, layout: { nodes: baseline, groups: [] },
  };
  const scene = projectBoard(graph, projected, 'units', 'main');
  const block = projected.find(node => node.unitId === 'block')!;
  const points = scene.edges[0].points;
  assert.ok(points.length >= 2);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const crosses = a.x === b.x
      ? a.x > block.x && a.x < block.x + block.width && Math.max(a.y, b.y) > block.y && Math.min(a.y, b.y) < block.y + block.height
      : a.y > block.y && a.y < block.y + block.height && Math.max(a.x, b.x) > block.x && Math.min(a.x, b.x) < block.x + block.width;
    assert.equal(crosses, false);
  }
});
