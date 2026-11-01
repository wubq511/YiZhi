import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CourseGraph } from '../src/shared';
import { aggregateThemeRelations, BOARD_LAYOUT_POLICY_VERSION, planInitialLayout, planIncrementalLayout, projectBoard, themeTitleSpace } from '../src/board-layout';
import type { BoardNode, BoardScene } from '../src/board-layout';
import { routeIntersectsViewport } from '../src/board-layout/visibility';
import { readingWidth } from '../src/layout';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeLayout } from '../src/core/local-layout';
import { prepareLayoutArrangement, commitLayoutArrangement } from '../src/core/layout-arrangement';

function graph(sizes:number[]):CourseGraph {
  const groups=sizes.map((_,i)=>({id:`t${i}`,name:`Theme ${i}`}));
  const nodes=groups.flatMap((g,i)=>Array.from({length:sizes[i]},(_,j)=>({id:`u${i}-${j}`,name:`Unit ${i}-${j}`,kind:'unit',themeId:g.id,themeName:g.name,stars:1})));
  return {groups,nodes,edges:[],requirementGroups:[],conditions:{},layout:{nodes:[],groups:[]}};
}
function edge(g:CourseGraph,id:string,from:string,to:string,type='requires',directed=true,view='main') {
  g.edges.push({id,fromUnitId:from,toUnitId:to,type,directed,view,value:'',sourceRefs:[]});
}
function overlap(a:BoardNode,b:BoardNode) {return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;}
function segmentCrosses(a:{x:number;y:number},b:{x:number;y:number},r:{x:number;y:number;width:number;height:number}) {
  if(a.x===b.x) return a.x>r.x&&a.x<r.x+r.width&&Math.max(a.y,b.y)>r.y&&Math.min(a.y,b.y)<r.y+r.height;
  assert.equal(a.y,b.y,'route must be orthogonal');
  return a.y>r.y&&a.y<r.y+r.height&&Math.max(a.x,b.x)>r.x&&Math.min(a.x,b.x)<r.x+r.width;
}
function assertAvoids(scene:BoardScene, routeId:string, blockers:Array<{x:number;y:number;width:number;height:number}>) {
  const r=scene.edges.find(e=>e.id===routeId)!;assert.ok(r);assert.ok(r.points.length>=2);
  for(let i=1;i<r.points.length;i++) for(const b of blockers) assert.equal(segmentCrosses(r.points[i-1],r.points[i],b),false,`${routeId} crosses an obstacle`);
}
function sharedCorridors(routes:BoardScene['edges']) {
  const segments=routes.flatMap(route=>route.points.slice(1).map((b,i)=>({id:route.id,a:route.points[i],b})));
  let shared=0,longest=0,total=0;
  for(const segment of segments)total+=Math.abs(segment.a.x-segment.b.x)+Math.abs(segment.a.y-segment.b.y);
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++) {
    const a=segments[i],b=segments[j];if(a.id===b.id)continue;
    const vertical=a.a.x===a.b.x;if(vertical!==(b.a.x===b.b.x))continue;
    if(Math.abs((vertical?a.a.x:a.a.y)-(vertical?b.a.x:b.a.y))>1e-6)continue;
    const ar=vertical?[a.a.y,a.b.y]:[a.a.x,a.b.x],br=vertical?[b.a.y,b.b.y]:[b.a.x,b.b.x];
    const overlap=Math.max(0,Math.min(Math.max(...ar),Math.max(...br))-Math.max(Math.min(...ar),Math.min(...br)));
    shared+=overlap;longest=Math.max(longest,overlap);
  }
  return {shared,longest,total};
}

test('a route remains visible when its detour crosses the viewport with both endpoints offscreen',()=>{
  const viewport={left:0,top:0,right:100,bottom:100};
  assert.equal(routeIntersectsViewport({points:[{x:-40,y:-50},{x:50,y:-50},{x:50,y:150},{x:140,y:150}]},viewport),true);
  assert.equal(routeIntersectsViewport({points:[{x:-40,y:-50},{x:-20,y:-50},{x:-20,y:150}]},viewport),false);
  assert.equal(routeIntersectsViewport({kind:'theme',points:[{x:-40,y:10},{x:-40,y:150},{x:140,y:150},{x:140,y:90}]},viewport),true);
});

test('initial layout uses real prerequisites, published order and variable theme sizes deterministically',()=>{
  const g=graph([6,1,3,0]);
  edge(g,'e1','u0-0','u0-2');edge(g,'e2','u0-2','u0-5');
  edge(g,'other','u0-5','u0-1','constructs');
  const before=structuredClone(g), first=planInitialLayout(g);
  assert.deepEqual(first,planInitialLayout(g)); assert.deepEqual(g,before);
  const local=first.nodes.filter(p=>p.unitId.startsWith('u0-'));
  assert.deepEqual([...local].sort((a,b)=>a.y-b.y||a.x-b.x).map(p=>p.unitId),g.nodes.filter(n=>n.themeId==='t0').map(n=>n.id));
  assert.ok(first.groups[0].width*first.groups[0].height>first.groups[1].width*first.groups[1].height);
  for(let i=0;i<first.nodes.length;i++) for(let j=i+1;j<first.nodes.length;j++) assert.equal(overlap(first.nodes[i],first.nodes[j]),false);
  const unordered=graph([5]);const positions=planInitialLayout(unordered).nodes;
  assert.deepEqual([...positions].sort((a,b)=>a.y-b.y||a.x-b.x).map(p=>p.unitId),unordered.nodes.map(n=>n.id));
  assert.deepEqual(first.groups.map(group=>group.themeId),g.groups.map(group=>group.id));
});

test('a prerequisite contrary to directory order puts its source in the earlier column',()=>{
  const g=graph([1,1]);edge(g,'reverse','u1-0','u0-0');
  const reversed=planInitialLayout(g);
  assert.ok(reversed.groups[1].x<reversed.groups[0].x);
  const actual=projectBoard(g,reversed.nodes,'themes','all').edges[0];
  assert.deepEqual([actual.source,actual.target,actual.directed],['t1','t0',true]);
  g.edges[0].fromUnitId='u0-0';g.edges[0].toUnitId='u1-0';
  const forward=planInitialLayout(g);assert.ok(forward.groups[0].x<forward.groups[1].x);
});

test('a prerequisite contrary to published unit order does not silently reorder the directory',()=>{
  const g=graph([4]);edge(g,'requires','u0-3','u0-0');
  const result=planInitialLayout(g).nodes;
  const order=[...result].sort((a,b)=>a.y-b.y||a.x-b.x).map(n=>n.unitId);
  assert.deepEqual(order,['u0-0','u0-1','u0-2','u0-3']);
  const actual=projectBoard(g,result,'units','all').edges[0];
  assert.deepEqual([actual.source,actual.target,actual.directed],['u0-3','u0-0',true]);
});

test('arranging an existing layout preserves widths and reserves measured or conservative reading dimensions',()=>{
  const g=graph([4,1]);
  g.layout.nodes=g.nodes.map((n,i)=>({unitId:n.id,x:5000+i*10,y:5000,width:[200,650,900,1800,400][i],height:[86,850,100,1200,500][i]}));
  const before=structuredClone(g), result=planInitialLayout(g,{preserveExistingSizes:true});
  assert.deepEqual(g,before);
  assert.deepEqual(result.nodes.map(n=>n.width),g.layout.nodes.map(n=>n.width));
  for(const p of result.nodes) {
    const old=g.layout.nodes.find(n=>n.unitId===p.unitId)!;
    assert.ok(p.height>=old.height&&p.height>=320);
  }
  for(let i=0;i<result.nodes.length;i++) for(let j=i+1;j<result.nodes.length;j++) {
    const a=result.nodes[i],b=result.nodes[j];assert.equal(overlap({...a,width:readingWidth(a.width)},{...b,width:readingWidth(b.width)}),false);
  }
  for(let i=0;i<result.groups.length;i++) for(let j=i+1;j<result.groups.length;j++) assert.equal(overlap(result.groups[i],result.groups[j]),false);
  for(const group of result.groups) for(const n of result.nodes.filter(n=>g.nodes.find(node=>node.id===n.unitId)!.themeId===group.themeId)) {
    assert.ok(n.x>=group.x&&n.y>=group.y&&n.x+readingWidth(n.width)<=group.x+group.width&&n.y+n.height<=group.y+group.height);
  }
});

test('the explicit arrangement transaction keeps saved widths',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('generation','1');
      CREATE TABLE units(id TEXT PRIMARY KEY,revision INTEGER); CREATE TABLE course_graph_revisions(id INTEGER PRIMARY KEY,version INTEGER);
      CREATE TABLE cg_candidates(id TEXT PRIMARY KEY,digest TEXT,basis TEXT,result TEXT); CREATE TABLE operations(id TEXT PRIMARY KEY);
      CREATE TABLE save_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT); CREATE TABLE cg_history(id TEXT PRIMARY KEY,value TEXT);`);
    initializeLayout(db);
    const g=graph([3]);g.layout.nodes=g.nodes.map((n,i)=>({unitId:n.id,x:5000+i*10,y:5000,width:[200,900,650][i],height:[86,900,420][i]}));
    const persisted=[220,1000,700];
    for(const [i,n] of g.nodes.entries()) {
      db.prepare('INSERT INTO units VALUES(?,1)').run(n.id);
      db.prepare('INSERT INTO layout_baseline VALUES(?,?,?,?)').run(n.id,6000+i*10,5000,persisted[i]);
    }
    const plan=prepareLayoutArrangement(db,g);assert.ok(plan.changes.length);
    for(const c of plan.changes) assert.equal(c.after.width,c.before.width);
    commitLayoutArrangement(db,g,{operationId:'arrange-test',basis:plan.basis});
    const stored=db.prepare('SELECT unit_id,width FROM layout_baseline ORDER BY unit_id').all();
    for(const row of stored) assert.equal(Number(row.width),persisted[g.nodes.findIndex(n=>n.id===row.unit_id)]);
  } finally {db.close();}
});

test('theme cycles preserve all directed edges, internal edges and undirected aggregates',()=>{
  const g=graph([2,2,1]);
  edge(g,'forward','u0-0','u1-0');edge(g,'return','u1-0','u0-1');edge(g,'internal','u0-0','u0-1');
  edge(g,'inverse-a','u0-0','u2-0','inverse',false,'auxiliary');edge(g,'inverse-b','u2-0','u0-1','inverse',false,'auxiliary');
  edge(g,'reverse','u1-1','u0-0','constructs');edge(g,'another-type','u0-0','u1-1','improves');
  const layout=planInitialLayout(g), before=structuredClone(g), scene=projectBoard(g,layout.nodes,'themes','all');
  assert.deepEqual(g,before);
  assert.deepEqual(scene,projectBoard(g,layout.nodes,'themes','all'));
  assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),g.edges.map(e=>e.id).sort());
  const inverse=scene.edges.find(e=>e.memberIds.includes('inverse-a'))!;
  assert.deepEqual(inverse.memberIds,['inverse-a','inverse-b']);assert.equal(inverse.source,'t0');assert.equal(inverse.target,'t2');assert.equal(inverse.directed,false);
  assert.equal(scene.edges.find(e=>e.id==='internal')!.kind,'internal');
  assert.equal(scene.edges.find(e=>e.memberIds.includes('return'))!.source,'t1');
  const main=projectBoard(g,layout.nodes,'themes','main');assert.deepEqual(main.edges.flatMap(e=>e.memberIds).sort(),g.edges.filter(e=>e.view==='main').map(e=>e.id).sort());
  const reordered=structuredClone(g);reordered.edges.reverse();
  assert.deepEqual(projectBoard(reordered,layout.nodes,'themes','all'),scene);
  const detail=projectBoard(g,layout.nodes,'units','all');assert.equal(detail.edges.length,g.edges.length);
  for(const e of detail.edges) {const original=g.edges.find(x=>x.id===e.id)!;assert.equal(e.source,original.fromUnitId);assert.equal(e.target,original.toUnitId);assert.deepEqual(e.memberIds,[e.id]);}
  const aggregates=aggregateThemeRelations(g);
  assert.equal(BOARD_LAYOUT_POLICY_VERSION,3);
  assert.deepEqual(aggregates.map(a=>a.relationIds).sort(),scene.edges.filter(e=>e.kind==='theme').map(e=>e.memberIds).sort());
  const reversed=structuredClone(g);reversed.edges.reverse();
  assert.deepEqual(aggregateThemeRelations(reversed).find(a=>a.relationIds.includes('inverse-a'))!.relationIds,['inverse-a','inverse-b']);
  const inverseAggregate=aggregates.find(a=>a.relationIds.includes('inverse-a'))!;
  assert.equal((inverseAggregate as typeof inverseAggregate & {directed:boolean}).directed,false);
});

test('an aggregate theme cycle shares a column and retains relations leaving it',()=>{
  const g=graph([2,1,1]);
  edge(g,'forward','u0-0','u1-0');edge(g,'back','u1-0','u0-1');edge(g,'after','u0-1','u2-0');
  const layout=planInitialLayout(g);
  assert.equal(layout.groups[0].x,layout.groups[1].x);
  assert.ok(layout.groups[2].x>layout.groups[0].x);
  for(const level of ['themes','units'] as const) {
    const scene=projectBoard(g,layout.nodes,level,'all');
    assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),['after','back','forward']);
    assert.ok(scene.edges.every(e=>!e.unrouted&&e.points.length>=2));
  }
});

test('incremental placement keeps existing coordinates and finds nearby room for existing and new themes',()=>{
  const g=graph([3,1]);g.nodes.pop();g.layout=planInitialLayout(g);
  const newUnit={id:'new',name:'new',kind:'unit',themeId:'t0',themeName:'Theme 0',stars:1};g.nodes.push(newUnit);
  const original=structuredClone(g), next=planIncrementalLayout(g,'new');
  assert.deepEqual(g,original);assert.deepEqual(next.nodes.slice(0,-1),g.layout.nodes);
  const added=next.nodes.at(-1)!, peers=g.layout.nodes;assert.ok(peers.some(p=>Math.abs(p.x-added.x)<1500&&Math.abs(p.y-added.y)<1500));
  for(const p of peers) assert.equal(overlap(p,added),false);
  assert.throws(()=>planIncrementalLayout({...g,layout:next},'new'));
  assert.throws(()=>planIncrementalLayout(g,'missing'));
  const newTheme=graph([1,1]);newTheme.nodes.pop();newTheme.layout=planInitialLayout(newTheme);
  newTheme.nodes.push({id:'new-theme-unit',name:'n',kind:'unit',themeId:'t1',themeName:'Theme 1',stars:1});
  const withNew=planIncrementalLayout(newTheme,'new-theme-unit');assert.equal(withNew.nodes.length,2);assert.equal(overlap(withNew.nodes[0],withNew.nodes[1]),false);
});

test('incremental placement reserves the actual reading width of a legacy narrow card',()=>{
  const g=graph([1]);g.layout=planInitialLayout(g);
  g.layout.nodes[0].width=200;
  const original=structuredClone(g.layout.nodes[0]);
  g.nodes.push({id:'new',name:'new',kind:'unit',themeId:'t0',themeName:'Theme 0',stars:1});
  const next=planIncrementalLayout(g,'new');
  assert.deepEqual(next.nodes[0],original);
  assert.equal(overlap({...original,width:650},next.nodes[1]),false);
});

test('routing avoids unrelated units and themes and keeps endpoints and reverse arrows',()=>{
  const g=graph([1,1,1]);edge(g,'out','u0-0','u2-0');edge(g,'back','u2-0','u0-0','constructs');
  const placements=[{unitId:'u0-0',x:0,y:200,width:200,height:160},{unitId:'u1-0',x:400,y:160,width:200,height:240},{unitId:'u2-0',x:800,y:200,width:200,height:160}];
  const before=structuredClone(placements), scene=projectBoard(g,placements,'themes','all');assert.deepEqual(placements,before);
  const mid=scene.themes.find(t=>t.themeId==='t1')!;
  const title={x:mid.x,y:mid.y-200,width:mid.width,height:200};
  for(const e of scene.edges) {assertAvoids(scene,e.id,[mid,title]);assert.equal(e.directed,true);}
  const forward=scene.edges.find(e=>e.memberIds[0]==='out')!,back=scene.edges.find(e=>e.memberIds[0]==='back')!;
  assert.deepEqual([forward.source,forward.target],['t0','t2']);assert.deepEqual([back.source,back.target],['t2','t0']);
  assert.notDeepEqual(forward.points,[...back.points].reverse());
  const unitScene=projectBoard(g,placements,'units','all');for(const e of unitScene.edges) assertAvoids(unitScene,e.id,[mid,title]);
  const a=unitScene.units[0], b=unitScene.units[2];
  for(const e of unitScene.edges){const first=e.points[0], last=e.points.at(-1)!;const source=e.id==='out'?a:b,target=e.id==='out'?b:a;
    assert.ok(first.x===source.x||first.x===source.x+source.width||first.y===source.y||first.y===source.y+source.height);
    assert.ok(last.x===target.x||last.x===target.x+target.width||last.y===target.y||last.y===target.y+target.height);}
});

test('an impossible route preserves every member and does not discard independently routable edges',()=>{
  const g=graph([2,1,1]);edge(g,'blocked','u0-0','u1-0','constructs');edge(g,'valid','u0-0','u2-0','constructs');
  const p=[{unitId:'u0-0',x:0,y:0,width:100,height:100},{unitId:'u0-1',x:1000,y:600,width:100,height:100},
    {unitId:'u1-0',x:500,y:300,width:100,height:100},{unitId:'u2-0',x:1800,y:300,width:100,height:100}];
  const scene=projectBoard(g,p,'themes','all'), blocked=scene.edges.find(e=>e.memberIds.includes('blocked'))!,valid=scene.edges.find(e=>e.memberIds.includes('valid'))!;
  assert.equal(blocked.unrouted,true);assert.deepEqual(blocked.points,[]);assert.deepEqual(blocked.memberIds,['blocked']);
  assert.equal(valid.unrouted,undefined);assertAvoids(scene,valid.id,scene.themes.filter(t=>t.themeId==='t1'));
  const detail=projectBoard(g,p,'units','all');assert.ok(detail.edges.every(e=>!e.unrouted&&e.points.length>=2));

  const h=graph([4]);edge(h,'blocked','u0-0','u0-1','constructs');edge(h,'valid','u0-0','u0-3','constructs');
  const nested=[{unitId:'u0-0',x:0,y:0,width:100,height:100},{unitId:'u0-1',x:600,y:300,width:100,height:100},
    {unitId:'u0-2',x:550,y:250,width:200,height:200},{unitId:'u0-3',x:1000,y:0,width:100,height:100}];
  for(const level of ['themes','units'] as const) {
    const s=projectBoard(h,nested,level,'all');
    assert.deepEqual(s.edges.flatMap(e=>e.memberIds).sort(),['blocked','valid']);
    assert.equal(s.edges.find(e=>e.id==='blocked')!.unrouted,true);
    assert.deepEqual(s.edges.find(e=>e.id==='blocked')!.points,[]);
    assert.equal(s.edges.find(e=>e.id==='valid')!.unrouted,undefined);
    assertAvoids(s,'valid',[nested[1],nested[2]]);
  }
});

test('routing searches another free port when all four midpoint ports are blocked',()=>{
  const g=graph([6]);edge(g,'reachable','u0-0','u0-1','constructs');
  const p=[{unitId:'u0-0',x:0,y:200,width:200,height:200},{unitId:'u0-1',x:700,y:200,width:200,height:200},
    {unitId:'u0-2',x:-20,y:275,width:40,height:50},{unitId:'u0-3',x:180,y:275,width:40,height:50},
    {unitId:'u0-4',x:75,y:180,width:50,height:40},{unitId:'u0-5',x:75,y:380,width:50,height:40}];
  const scene=projectBoard(g,p,'units','all'),route=scene.edges[0];
  assert.equal(route.unrouted,undefined);assertAvoids(scene,'reachable',p.slice(2));
  assert.ok(![{x:0,y:300},{x:200,y:300},{x:100,y:200},{x:100,y:400}].some(q=>q.x===route.points[0].x&&q.y===route.points[0].y));
});

test('rejects invalid identities, prerequisites and incomplete placements',()=>{
  const g=graph([2]);edge(g,'a','u0-0','u0-1');edge(g,'b','u0-1','u0-0');assert.throws(()=>planInitialLayout(g),/环/);
  g.edges.pop();const l=planInitialLayout(g);assert.throws(()=>projectBoard(g,l.nodes.slice(1),'units','all'),/不完整/);
  assert.throws(()=>projectBoard(g,[l.nodes[0],{...l.nodes[1],width:NaN}],'units','main'),/无效/);
  g.edges[0].toUnitId='missing';assert.throws(()=>planInitialLayout(g),/端点/);assert.throws(()=>projectBoard(g,l.nodes,'units','all'),/端点/);
});

test('retains AND/OR route meaning and rejects dangling group membership',()=>{
  const g=graph([3]);edge(g,'first','u0-0','u0-2');edge(g,'second','u0-1','u0-2');
  for(const e of g.edges) e.requirementGroupId='alternative';
  g.requirementGroups.push({id:'alternative',targetUnitId:'u0-2',mode:'any',unitIds:['u0-0','u0-1'],relationIds:['first','second'],value:''});
  const layout=planInitialLayout(g), scene=projectBoard(g,layout.nodes,'units','all');
  assert.ok(scene.edges.every(e=>e.label.includes('或')));
  assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),['first','second']);
  g.requirementGroups[0].relationIds.pop();assert.throws(()=>planInitialLayout(g),/路线组/);
});

test('empty themes retain saved positions and cannot collide with aggregate route IDs',()=>{
  const g=graph([2,1,0]);edge(g,'cross','u0-0','u1-0');
  edge(g,'theme:["t0","t1","requires",true]','u0-0','u0-1','constructs');
  g.layout=planInitialLayout(g);
  const scene=projectBoard(g,g.layout.nodes,'themes','all'), empty=scene.themes.find(t=>t.themeId==='t2')!;
  assert.equal(empty.x,g.layout.groups[2].x);assert.equal(empty.y,g.layout.groups[2].y);
  assert.equal(new Set(scene.edges.map(e=>e.id)).size,scene.edges.length);
  for(const route of scene.edges) assertAvoids(scene,route.id,[empty]);
});

test('aggregation separates direction even with the same endpoints and relation type',()=>{
  const g=graph([2,2]);
  edge(g,'directed','u0-0','u1-0','custom',true);
  edge(g,'undirected','u1-1','u0-1','custom',false);
  const groups=aggregateThemeRelations(g);
  assert.equal(groups.length,2);
  assert.deepEqual(groups.map(g=>g.relationIds),[['directed'],['undirected']]);
  assert.deepEqual(groups.map(g=>(g as typeof g & {directed:boolean}).directed),[true,false]);
});

test('large synthetic courses preserve complete relations across both projection levels',()=>{
  const g=graph(Array(20).fill(25));
  for(let t=0;t<20;t++) for(let j=0;j<24;j++) edge(g,`chain-${t}-${j}`,`u${t}-${j}`,`u${t}-${j+1}`);
  for(let t=0;t<19;t++) for(let j=0;j<5;j++) edge(g,`cross-${t}-${j}`,`u${t}-${j}`,`u${t+1}-${j}`,'constructs');
  const l=planInitialLayout(g);assert.equal(l.nodes.length,500);
  for(let i=0;i<l.nodes.length;i++) for(let j=i+1;j<l.nodes.length;j++) assert.equal(overlap(l.nodes[i],l.nodes[j]),false);
  for(let i=0;i<l.groups.length;i++) for(let j=i+1;j<l.groups.length;j++) assert.equal(overlap(l.groups[i],l.groups[j]),false);
  const scene=projectBoard(g,l.nodes,'themes','all');
  assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),g.edges.map(e=>e.id).sort());
  assert.deepEqual(planInitialLayout(g),l);
});

test('dense 500-unit detail retains every relation and finite geometry',()=>{
  const g=graph(Array(20).fill(25));
  for(let t=0;t<20;t++) for(let j=0;j<25;j++) for(let d=1;d<=3&&j+d<25;d++) edge(g,`dense-${t}-${j}-${d}`,`u${t}-${j}`,`u${t}-${j+d}`,'constructs');
  const layout=planInitialLayout(g), scene=projectBoard(g,layout.nodes,'units','all');
  assert.equal(scene.edges.length,g.edges.length);
  assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),g.edges.map(e=>e.id).sort());
  assert.ok(scene.edges.every(e=>e.points.length>=2&&e.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))));
});

test('dense theme graphs retain every relation with obstacle-aware routing',()=>{
  const g=graph(Array(9).fill(1));
  for(let i=0;i<9;i++)for(let j=i+1;j<9;j++)edge(g,`dense-theme-${i}-${j}`,`u${i}-0`,`u${j}-0`);
  const layout=planInitialLayout(g),start=performance.now();
  const scene=projectBoard(g,layout.nodes,'themes','main');
  const elapsed=performance.now()-start;
  assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),g.edges.map(e=>e.id).sort());
  assert.ok(scene.edges.every(e=>!e.unrouted&&e.points.length>=2));
  for(const route of scene.edges)assertAvoids(scene,route.id,scene.themes.filter(t=>t.themeId!==route.source&&t.themeId!==route.target));
  console.log(`dense theme projection: ${scene.edges.length} routes in ${elapsed.toFixed(1)} ms`);
});

test('themes without a recorded prerequisite share the first column',()=>{
  const g=graph(Array(20).fill(1));edge(g,'only-prerequisite','u0-0','u1-0');
  const layout=planInitialLayout(g), groups=layout.groups;
  assert.ok(groups[0].x<groups[1].x);
  const counts=new Map<number,number>();for(const group of groups) counts.set(group.x,(counts.get(group.x)??0)+1);
  assert.equal(counts.size,2);assert.deepEqual([...counts.values()].sort((a,b)=>a-b),[1,19]);
  assert.deepEqual(groups.map(group=>group.themeId),g.groups.map(group=>group.id));
  assert.equal(projectBoard(g,layout.nodes,'themes','all').edges.length,1);
});

test('parallel prerequisite branches occupy one subsequent column',()=>{
  const g=graph(Array(7).fill(1));
  for(let i=1;i<7;i++) edge(g,`branch-${i}`,'u0-0',`u${i}-0`);
  const groups=planInitialLayout(g).groups;
  assert.equal(new Set(groups.slice(1).map(group=>group.x)).size,1);
  assert.ok(groups[1].x>groups[0].x);
  assert.deepEqual(groups.slice(1).sort((a,b)=>a.y-b.y).map(group=>group.themeId),g.groups.slice(1).map(group=>group.id));
});

test('fan-out and fan-in routes use separate corridors even when relation identities oppose spatial order',()=>{
  const g=graph(Array(6).fill(1));
  for(let i=1;i<=4;i++) {
    edge(g,`out-${i}`,'u0-0',`u${i}-0`);
    edge(g,`in-${i}`,`u${i}-0`,'u5-0');
  }
  const placements=g.nodes.map((node,i)=>({unitId:node.id,
    x:i===0?0:i===5?12000:6000,
    y:i===0||i===5?3000:(4-i)*1800,
    width:900,height:700}));
  const scene=projectBoard(g,placements,'themes','main');
  const related=scene.edges.filter(route=>route.kind==='theme');
  assert.equal(related.length,8);assert.ok(related.every(route=>!route.unrouted));
  assert.equal(sharedCorridors(related).shared,0,'fan-in and fan-out lines must not merge');
  const shuffled=structuredClone(g);shuffled.edges.reverse();
  assert.deepEqual(projectBoard(shuffled,placements,'themes','main'),scene);
});

test('a dense many-to-many overview keeps relations distinct without depending on input order',()=>{
  const count=8,g=graph(Array(count*2).fill(1));
  for(let a=0;a<count;a++)for(let b=0;b<count;b++)edge(g,`e-${a}-${b}`,`u${a}-0`,`u${count+b}-0`);
  const placements=g.nodes.map((node,i)=>({unitId:node.id,x:i<count?0:10000,
    y:(i%count)*2000,width:900,height:900}));
  const scene=projectBoard(g,placements,'themes','main');
  assert.equal(scene.edges.length,count*count);assert.ok(scene.edges.every(route=>!route.unrouted));
  assert.deepEqual(scene.edges.flatMap(route=>route.memberIds).sort(),g.edges.map(edge=>edge.id).sort());
  const {shared,longest,total}=sharedCorridors(scene.edges);
  assert.ok(shared/total<.005,`dense relations share too much ink: ${shared}/${total}`);
  assert.ok(longest<=500,`a shared segment is too long: ${longest}`);
  const shuffled=structuredClone(g);shuffled.edges.reverse();
  assert.deepEqual(projectBoard(shuffled,placements,'themes','main'),scene);
});

test('a cross-theme route leaves visible space around an unrelated theme when space permits',()=>{
  const g=graph([1,1,1]);edge(g,'skip','u0-0','u2-0');
  const placements=g.nodes.map((node,i)=>({unitId:node.id,x:i*5000,y:2000,width:900,height:700}));
  const scene=projectBoard(g,placements,'themes','main'),middle=scene.themes.find(theme=>theme.themeId==='t1')!;
  const clearance=150;
  assertAvoids(scene,scene.edges[0].id,[{x:middle.x-clearance,y:middle.y-clearance,
    width:middle.width+2*clearance,height:middle.height+2*clearance}]);
});

test('short theme titles leave their unused second line available for relations',()=>{
  const g=graph([1,1]);g.groups[0].name='卡诺图基础与化简';g.groups[1].name='需要两行展示的非常长的主题名称';
  const placements=g.nodes.map((node,i)=>({unitId:node.id,x:0,y:i*4000,width:900,height:700}));
  const scene=projectBoard(g,placements,'themes','main');
  const short=scene.themes[0],long=scene.themes[1];
  assert.ok(themeTitleSpace(short,scene.themes)>=550&&themeTitleSpace(short,scene.themes)<1100);
  assert.equal(themeTitleSpace(long,scene.themes),1100);
});

test('variable theme sizes remain in their prerequisite columns without overlap',()=>{
  const g=graph([5,1,6,2,4,1,3,5,2]);
  edge(g,'first-to-last','u0-0','u8-0');edge(g,'later','u2-0','u6-0');
  const layout=planInitialLayout(g);
  assert.equal(layout.groups[0].x,layout.groups[2].x);
  assert.equal(layout.groups[6].x,layout.groups[8].x);
  assert.ok(layout.groups[6].x>layout.groups[0].x);
  for(let i=0;i<layout.groups.length;i++)for(let j=i+1;j<layout.groups.length;j++)assert.equal(overlap(layout.groups[i],layout.groups[j]),false);
});

test('the course overview follows recorded prerequisites and separates its main relation lanes',()=>{
  const course=JSON.parse(readFileSync(resolve('fixtures/graph.json'),'utf8')) as CourseGraph;
  const layout=planInitialLayout(course,{preserveExistingSizes:true});
  const nodeThemes=new Map(course.nodes.map(node=>[node.id,node.themeId]));
  const groupById=new Map(layout.groups.map(group=>[group.themeId,group]));
  for(const edge of course.edges.filter(edge=>edge.type==='requires')) {
    const a=nodeThemes.get(edge.fromUnitId)!,b=nodeThemes.get(edge.toUnitId)!;
    if(a!==b)assert.ok(groupById.get(a)!.x<groupById.get(b)!.x);
  }
  assert.deepEqual([...new Set(layout.groups.map(group=>group.x))].sort((a,b)=>a-b).map(x=>layout.groups.filter(group=>group.x===x).length),[11,6,2,1]);
  const reordered=structuredClone(course);reordered.edges.reverse();
  assert.deepEqual(planInitialLayout(reordered,{preserveExistingSizes:true}),layout);
  const reading=layout.nodes.map(node=>({...node,width:readingWidth(node.width)}));
  const scene=projectBoard({...course,layout},reading,'themes','main');
  assert.deepEqual(scene.edges.flatMap(route=>route.memberIds).sort(),course.edges.filter(edge=>edge.view==='main').map(edge=>edge.id).sort());
  assert.ok(scene.edges.every(route=>!route.unrouted));
  const segments=scene.edges.flatMap(route=>route.points.slice(1).map((b,i)=>({id:route.id,a:route.points[i],b})));
  let length=0,shared=0;
  for(const segment of segments)length+=Math.abs(segment.a.x-segment.b.x)+Math.abs(segment.a.y-segment.b.y);
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++) {
    const a=segments[i],b=segments[j];if(a.id===b.id)continue;
    if(a.a.x===a.b.x && b.a.x===b.b.x && a.a.x===b.a.x)
      shared+=Math.max(0,Math.min(Math.max(a.a.y,a.b.y),Math.max(b.a.y,b.b.y))-Math.max(Math.min(a.a.y,a.b.y),Math.min(b.a.y,b.b.y)));
    if(a.a.y===a.b.y && b.a.y===b.b.y && a.a.y===b.a.y)
      shared+=Math.max(0,Math.min(Math.max(a.a.x,a.b.x),Math.max(b.a.x,b.b.x))-Math.max(Math.min(a.a.x,a.b.x),Math.min(b.a.x,b.b.x)));
  }
  assert.ok(shared/length<.05,`main relations share too much line: ${shared}/${length}`);
  for(const route of scene.edges.filter(route=>route.kind==='theme'))
    assertAvoids(scene,route.id,scene.themes.filter(theme=>theme.themeId!==route.source&&theme.themeId!==route.target));
});

test('reports reproducible projection timings for 84- and 500-unit synthetic courses',()=>{
  for(const sizes of [[...Array(4).fill(5),...Array(16).fill(4)],Array(20).fill(25)]) {
    const g=graph(sizes);edge(g,'prerequisite','u0-0','u1-0');
    for(let t=0;t<20;t++) {
      for(let j=0;j<sizes[t];j++) {
        if(j+1<sizes[t]) edge(g,`local-${t}-${j}`,`u${t}-${j}`,`u${t}-${j+1}`,'constructs');
        if(j+2<sizes[t]) edge(g,`skip-${t}-${j}`,`u${t}-${j}`,`u${t}-${j+2}`,'improves');
        if(t+1<20 && j<Math.min(sizes[t],sizes[t+1],5)) edge(g,`cross-${t}-${j}`,`u${t}-${j}`,`u${t+1}-${j}`,'constructs');
      }
    }
    const layout=planInitialLayout(g);
    for(const level of ['themes','units'] as const) {
      const start=performance.now(),scene=projectBoard(g,layout.nodes,level,'all'),elapsed=performance.now()-start;
      assert.equal(scene.edges.reduce((sum,e)=>sum+e.memberIds.length,0),g.edges.length);
      const nodeThemes=new Map(g.nodes.map(n=>[n.id,n.themeId]));
      for(const route of scene.edges) {
        const sourceTheme=route.kind==='theme'?route.source:nodeThemes.get(route.source)!;
        const targetTheme=route.kind==='theme'?route.target:nodeThemes.get(route.target)!;
        const blockers=route.kind==='theme'
          ? scene.themes.filter(t=>t.themeId!==sourceTheme&&t.themeId!==targetTheme)
          : [
              ...scene.units.filter(n=>n.unitId!==route.source&&n.unitId!==route.target),
              ...scene.themes.filter(t=>t.themeId!==sourceTheme&&t.themeId!==targetTheme),
              ...scene.themes.filter(t=>t.themeId===sourceTheme||t.themeId===targetTheme).map(t=>({x:t.x,y:t.y,width:t.width,height:80})),
            ];
        assertAvoids(scene,route.id,blockers);
      }
      console.log(`projection-benchmark units=${g.nodes.length} relations=${g.edges.length} level=${level} routes=${scene.edges.length} ms=${elapsed.toFixed(1)}`);
    }
  }
});
