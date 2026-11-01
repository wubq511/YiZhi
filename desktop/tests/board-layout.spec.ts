import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openFirstUnit } from './shell-actions';

test('fit keeps theme titles below the toolbar and inside the available board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-board-fit-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    const checkFit = async (withPanel = false, requestFit = true) => {
      if (requestFit) await page.getByRole('button', { name: '全图', exact: true }).click();
      await expect.poll(async () => page.evaluate(({ withPanel }) => {
        const board = document.querySelector<HTMLElement>('main.board')!.getBoundingClientRect();
        const toolbar = document.querySelector<HTMLElement>('.canvas-toolbar')!.getBoundingClientRect();
        const controls = [...document.querySelectorAll<HTMLElement>('.canvas-navigation, .react-flow__minimap')]
          .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height);
        const panel = withPanel ? document.querySelector<HTMLElement>('.relations-panel')!.getBoundingClientRect() : undefined;
        const themes = [...document.querySelectorAll<HTMLElement>('.react-flow__node.board-theme')];
        if (themes.length === 0) return false;
        return themes.every(theme => {
          const box = theme.getBoundingClientRect(), title = theme.querySelector('span')!.getBoundingClientRect();
          const clearOfControls = controls.every(control => box.right <= control.left || box.left >= control.right || box.bottom <= control.top || box.top >= control.bottom);
          return title.top >= toolbar.bottom && title.left >= board.left && title.right <= (panel?.left ?? board.right) && box.right <= (panel?.left ?? board.right) && box.bottom <= board.bottom && clearOfControls;
        });
      }, { withPanel })).toBe(true);
      const groupCount = await page.evaluate(async () => {
        const course = await window.yizhi.open();
        return (await window.yizhi.graph(course.sessionId)).groups.length;
      });
      await expect(page.locator('.react-flow__node.board-theme')).toHaveCount(groupCount);
    };
    await checkFit(false, false);
    for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(size);
      await checkFit();
    }
    await page.getByRole('button', { name: '关系', exact: true }).click();
    await page.getByRole('menuitem', { name: '查看与编辑正式关系' }).click();
    await expect(page.getByLabel('关系详情')).toBeVisible();
    await checkFit(true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('overview retains every main relation and opens its real members from the keyboard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-board-scene-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`],
    env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '全图', exact: true }).click();
    for (let i = 0; i < 12 && await page.locator('.board-unit-thumbnail').count() === 0; i++)
      await page.getByRole('button', { name: '缩小画板' }).click();
    await expect(page.locator('.board-unit-thumbnail').first()).toBeAttached();
    const expected = await page.evaluate(async () => {
      const bridge = (window as any).yizhi, course = await bridge.open();
      return (await bridge.graph(course.sessionId)).edges.filter((edge: any) => edge.view === 'main').map((edge: any) => edge.id).sort();
    });
    const actual = await page.locator('.board-route').evaluateAll(elements => elements.flatMap(element => JSON.parse(element.getAttribute('data-members')!)).sort());
    expect(actual).toEqual(expected);
    const first = page.locator('.react-flow__edge').first();
    const members = JSON.parse((await first.locator('.board-route').getAttribute('data-members'))!) as string[];
    await first.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByLabel('关系详情');
    const selected = panel.getByLabel('所选关系成员');
    await expect(selected).toBeVisible();
    await expect(panel.getByText('正式关系审核', { exact: true })).toHaveCount(0);
    await expect(selected.getByRole('button', { name: `审核 ${members[0]}`, exact: true })).toBeVisible();
    await selected.getByRole('button', { name: `审核 ${members[0]}`, exact: true }).click();
    await expect(panel.getByText('正式关系审核', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '关闭关系详情' }).click();
    await page.getByRole('button', { name: '有符号数与补码运算', exact: true }).click();
    await page.getByRole('button', { name: '模运算与补码原理', exact: true }).click();
    await page.getByRole('button', { name: '全图', exact: true }).click();
    await expect(page.locator('.board-route-group[data-related]').first()).toBeAttached();
    await expect.poll(() => page.locator('.board-route').evaluateAll(elements => elements.flatMap(element => JSON.parse(element.getAttribute('data-members')!)).sort())).toEqual(expected);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('overview keeps prerequisites left to right and direction marks visible at both window sizes', async () => {
  const root=await mkdtemp(join(tmpdir(),'yizhi-board-reading-order-'));
  const app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile')}});
  try {
    const page=await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy','false');
    const expected=await page.evaluate(async()=>{
      const course=await window.yizhi.open(),graph=await window.yizhi.graph(course.sessionId);
      const theme=new Map(graph.nodes.map(node=>[node.id,node.themeId]));
      return {ids:graph.groups.map(group=>group.id),edges:graph.edges.filter(edge=>edge.type==='requires').map(edge=>[theme.get(edge.fromUnitId)!,theme.get(edge.toUnitId)!]).filter(([a,b])=>a!==b)};
    });
    for(const size of [{width:1440,height:900},{width:1024,height:768}]) {
      await page.setViewportSize(size);
      await page.getByRole('button',{name:'全图',exact:true}).click();
      await expect.poll(()=>page.locator('.board-theme').count()).toBe(expected.ids.length);
      const positions=await page.locator('.board-theme').evaluateAll(elements=>elements.map(element=>({id:element.getAttribute('data-id')!,x:element.getBoundingClientRect().x})));
      for(const [from,to] of expected.edges)expect(positions.find(p=>p.id===from)!.x).toBeLessThan(positions.find(p=>p.id===to)!.x);
      for(const position of positions)expect(positions.filter(other=>Math.abs(other.x-position.x)<.5).length).toBeLessThanOrEqual(3);
      await expect.poll(()=>page.locator('.board-route-group').evaluateAll(elements=>elements.length?elements.filter(element=>{
        const route=element.querySelector('.board-route');
        return route?.getAttribute('data-directed')==='true'&&!element.querySelector('.board-route-arrow');
      }).length:-1)).toBe(0);
      await expect(page.locator('.board-route-ink').first()).toBeAttached();
    }
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});

test('zooming between reading and overview does not move the measured unit in the course', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-board-zoom-'));
  const app = await electron.launch({ args: [resolve('.'), `--course=${join(root, 'course')}`], env: { ...process.env, YIZHI_DATA_HOME: join(root, 'profile') } });
  try {
    const page = await app.firstWindow(); await openFirstUnit(page);
    const layer = page.locator('.reading-layer[data-unit-id="KU-001"]');
    await expect(layer).toHaveCSS('visibility', 'visible');
    const position = () => page.evaluate(() => {
      const view = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')!).transform);
      const layer = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.reading-layer[data-unit-id="KU-001"]')!).transform);
      return { x: Math.round((layer.e - view.e) / view.a * 100) / 100, y: Math.round((layer.f - view.f) / view.a * 100) / 100 };
    });
    const before = await position();
    for(let i=0;i<4;i++)await page.getByRole('button',{name:'缩小画板'}).click();
    await expect(layer).toHaveCSS('visibility', 'hidden');
    await expect.poll(position).toEqual(before);
    for(let i=0;i<4;i++)await page.getByRole('button',{name:'放大画板'}).click();
    await expect(layer).toHaveCSS('visibility', 'visible');
    await expect.poll(position).toEqual(before);
    await page.getByRole('button',{name:'全图',exact:true}).click();
    await expect.poll(() => page.evaluate(() => {
      const themes = [...document.querySelectorAll<HTMLElement>('.board-theme')];
      const first = themes.find(theme => theme.textContent === '数制与数制转换');
      const second = themes.find(theme => theme.textContent === '有符号数与补码运算');
      return first && second ? first.getBoundingClientRect().height / second.getBoundingClientRect().height : Infinity;
    })).toBeLessThan(3);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('overlapping legacy themes yield temporarily while saved positions and relations remain intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-board-unrouted-'));
  const course = join(root, 'course'), profile = join(root, 'profile');
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${course}`], env: { ...process.env, YIZHI_DATA_HOME: profile } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await app.close();
    const groups = ['A', 'B', 'C'].map(id => ({ id, name: id }));
    const definitions = [
      ['KU-001', 'A', 0, 0], ['KU-002', 'A', 4000, 3000],
      ['KU-003', 'B', 2000, 1500], ['KU-004', 'C', 8000, 1500],
    ] as const;
    const nodes = definitions.map(([id, themeId]) => ({ id, name: id, kind: 'unit', themeId, themeName: themeId, stars: 1 }));
    const placements = definitions.map(([unitId, , x, y]) => ({ unitId, x, y, width: 650, height: 320 }));
    const edges = [
      { id: 'blocked', fromUnitId: 'KU-001', toUnitId: 'KU-003', type: 'constructs', directed: true, view: 'main', value: '', sourceRefs: [] },
      { id: 'valid', fromUnitId: 'KU-001', toUnitId: 'KU-004', type: 'constructs', directed: true, view: 'main', value: '', sourceRefs: [] },
    ];
    const graph = { groups, nodes, edges, requirementGroups: [], conditions: {}, layout: { nodes: placements, groups: [] } };
    const db = new DatabaseSync(join(course, 'course.sqlite'));
    try {
      db.prepare("INSERT INTO metadata VALUES('course-graph',?)").run(JSON.stringify(graph));
      db.exec('DELETE FROM formal_relations; DELETE FROM formal_requirement_groups; DELETE FROM layout_baseline; DELETE FROM reading_state');
      for (const edge of edges) db.prepare('INSERT INTO formal_relations VALUES(?,?)').run(edge.id, JSON.stringify(edge));
    } finally { db.close(); }
    app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '全图', exact: true }).click();
    await expect(page.getByText('部分关系暂时无法连线')).toHaveCount(0);
    await expect.poll(() => page.locator('.board-route').evaluateAll(elements => elements.flatMap(element => JSON.parse(element.getAttribute('data-members')!)).sort())).toEqual(['blocked', 'valid']);
    await expect(page.locator('.board-theme')).toHaveCount(3);
    const saved = await page.evaluate(async () => { const c = await window.yizhi.open(); return (await window.yizhi.graph(c.sessionId)).layout.nodes; });
    expect(saved).toEqual(placements);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a course containing only empty themes can still fit the complete board', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yizhi-empty-board-'));
  const course = join(root, 'course'), profile = join(root, 'profile');
  const launch = () => electron.launch({ args: [resolve('.'), `--course=${course}`], env: { ...process.env, YIZHI_DATA_HOME: profile } });
  let app = await launch();
  try {
    let page = await app.firstWindow(); await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false'); await app.close();
    const graph = { groups: [{ id: 'A', name: '主题 A' }, { id: 'B', name: '主题 B' }], nodes: [], edges: [], requirementGroups: [], conditions: {},
      layout: { nodes: [], groups: [{ themeId: 'A', x: 0, y: 0, width: 600, height: 400 }, { themeId: 'B', x: 2400, y: 1200, width: 600, height: 400 }] } };
    const db = new DatabaseSync(join(course, 'course.sqlite'));
    try {
      db.prepare("INSERT INTO metadata VALUES('course-graph',?)").run(JSON.stringify(graph));
      db.exec('DELETE FROM formal_relations; DELETE FROM formal_requirement_groups; DELETE FROM reading_state');
    } finally { db.close(); }
    app = await launch(); page = await app.firstWindow();
    await expect(page.locator('.workspace')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: '全图', exact: true }).click();
    await expect(page.locator('.board-theme')).toHaveCount(2);
    await expect.poll(() => page.locator('.board-theme').evaluateAll(themes => {
      const board = document.querySelector('main.board')!.getBoundingClientRect();
      return themes.every(theme => { const r = theme.getBoundingClientRect(); return r.left >= board.left && r.right <= board.right && r.top >= board.top && r.bottom <= board.bottom; });
    })).toBe(true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
