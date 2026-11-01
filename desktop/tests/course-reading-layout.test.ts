import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { overviewThumbnailPlacements, projectCourseReadingLayout, projectReadingLayout, THEME_TITLE_MAX, THEME_TITLE_SPACE } from '../src/layout';
import type { LayoutNode, LayoutSizes } from '../src/layout';
import { planInitialLayout, projectBoard, themeTitleSpace } from '../src/board-layout';
import type { CourseGraph } from '../src/shared';

function graph(sizes:number[]):CourseGraph {
  const groups=sizes.map((_,i)=>({id:`t${i}`,name:`Theme ${i}`}));
  const nodes=groups.flatMap((g,i)=>Array.from({length:sizes[i]},(_,j)=>({id:`u${i}-${j}`,name:`Unit ${i}-${j}`,kind:'unit',themeId:g.id,themeName:g.name,stars:1})));
  return {groups,nodes,edges:[],requirementGroups:[],conditions:{},layout:{nodes:[],groups:[]}};
}
function bounds(graph:CourseGraph, positions:LayoutNode[]) {
  const nodeTheme=new Map(graph.nodes.map(n=>[n.id,n.themeId])), result=new Map<string,{x:number;y:number;width:number;height:number}>();
  for(const node of positions) {
    const id=nodeTheme.get(node.unitId)!, box=result.get(id);
    const left=node.x-64,top=node.y-112,right=node.x+node.width+64,bottom=node.y+node.height+64;
    if(!box) result.set(id,{x:left,y:top,width:right-left,height:bottom-top});
    else {const x=Math.min(box.x,left),y=Math.min(box.y,top),r=Math.max(box.x+box.width,right),b=Math.max(box.y+box.height,bottom);Object.assign(box,{x,y,width:r-x,height:b-y});}
  }
  return result;
}
function overlap(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number}) {
  return a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
}
function assertNoThemeOverlap(graph:CourseGraph,positions:LayoutNode[]) {
  const all=[...bounds(graph,positions).entries()];
  for(let i=0;i<all.length;i++) for(let j=i+1;j<all.length;j++) assert.equal(overlap(all[i][1],all[j][1]),false,`${all[i][0]} overlaps ${all[j][0]}`);
}
function assertRigidThemes(graph:CourseGraph,actual:LayoutNode[],sizes:LayoutSizes,fixed?:{unitId:string;x:number;y:number;width:number}) {
  const actualMap=new Map(actual.map(n=>[n.unitId,n]));
  for(const group of graph.groups) {
    const ids=new Set(graph.nodes.filter(n=>n.themeId===group.id).map(n=>n.id));
    if(!ids.size) continue;
    const local=projectReadingLayout(graph.layout.nodes.filter(n=>ids.has(n.unitId)),Object.fromEntries(Object.entries(sizes).filter(([id])=>ids.has(id))),fixed&&ids.has(fixed.unitId)?fixed:undefined);
    const first=local[0],moved=actualMap.get(first.unitId)!,dx=moved.x-first.x,dy=moved.y-first.y;
    for(const node of local) {const found=actualMap.get(node.unitId)!;assert.equal(found.x-node.x,dx);assert.equal(found.y-node.y,dy);assert.equal(found.width,node.width);assert.equal(found.height,node.height);}
  }
}
function fixture():CourseGraph {return JSON.parse(readFileSync(resolve('fixtures/graph.json'),'utf8')) as CourseGraph;}

test('legacy short thumbnails gain height only where there is room, without moving the baseline',()=>{
  const g=graph([2,1]);
  const positions=[{unitId:'u0-0',x:0,y:0,width:650,height:86},{unitId:'u0-1',x:0,y:420,width:650,height:86},{unitId:'u1-0',x:0,y:1700,width:650,height:86}];
  const before=structuredClone(positions),result=overviewThumbnailPlacements(g,positions);
  assert.deepEqual(positions,before);
  assert.deepEqual(result.map(n=>[n.x,n.y,n.width]),positions.map(n=>[n.x,n.y,n.width]));
  assert.equal(result[0].height,320);
  assert.equal(result[1].height,86);
  assert.equal(result[2].height,320);
});

test('saved layouts keep their positions when two-line titles do not fit',()=>{
  const g=graph([1,1]);
  g.layout.nodes=[{unitId:'u0-0',x:64,y:112,width:620,height:320},{unitId:'u1-0',x:64,y:828,width:620,height:320}];
  const original=structuredClone(g);
  const projected=projectCourseReadingLayout(g,{});
  assert.deepEqual(projected,g.layout.nodes);
  assert.deepEqual(g,original);
  const scene=projectBoard(g,projected,'themes','main');
  assert.equal(themeTitleSpace(scene.themes[1],scene.themes),THEME_TITLE_SPACE);
  const fresh=graph(Array(8).fill(1));fresh.layout=planInitialLayout(fresh);
  const freshScene=projectBoard(fresh,fresh.layout.nodes,'themes','main');
  assert.ok(new Set(freshScene.themes.map(t=>t.y)).size>1);
  assert.ok(freshScene.themes.every(t=>themeTitleSpace(t,freshScene.themes)===THEME_TITLE_MAX));
});

test('the 84-unit legacy fixture projects distinct themes and complete routable relationships without changing the baseline',()=>{
  const g=fixture(), before=structuredClone(g), result=projectCourseReadingLayout(g,{});
  assert.equal(g.groups.length,20);assert.equal(result.length,84);assert.deepEqual(g,before);
  assert.ok(result.every(n=>n.width>=360));assertNoThemeOverlap(g,result);assertRigidThemes(g,result,{});
  for(const level of ['themes','units'] as const) {
    const scene=projectBoard(g,result,level,'all');
    const expected=bounds(g,result);
    for(const theme of scene.themes) assert.deepEqual({x:theme.x,y:theme.y,width:theme.width,height:theme.height},expected.get(theme.themeId));
    assert.deepEqual(scene.edges.flatMap(e=>e.memberIds).sort(),g.edges.map(e=>e.id).sort());
    assert.deepEqual(scene.edges.filter(e=>e.unrouted).map(e=>e.memberIds),[]);
  }
  assert.deepEqual(projectCourseReadingLayout(g,{}),result);
});

test('expanded real content preserves the anchor theme, leaves independent themes alone and is a disposable projection',()=>{
  const g=fixture(),original=structuredClone(g),base=projectCourseReadingLayout(g,{});
  const anchor=g.nodes[0],stored=g.layout.nodes.find(n=>n.unitId===anchor.id)!;
  const sizes:LayoutSizes={[anchor.id]:{width:650,height:stored.height+1200}};
  const local=projectReadingLayout(g.layout.nodes.filter(n=>g.nodes.some(unit=>unit.id===n.unitId&&unit.themeId===anchor.themeId)),sizes);
  const projected=projectCourseReadingLayout(g,sizes,undefined,anchor.id);
  assert.deepEqual(g,original);assertNoThemeOverlap(g,projected);assertRigidThemes(g,projected,sizes);
  for(const node of local) assert.deepEqual(projected.find(n=>n.unitId===node.unitId),node);
  assert.deepEqual(projectCourseReadingLayout(g,{}),base);
  for(const level of ['themes','units'] as const) {
    const scene=projectBoard(g,projected,level,'all');
    assert.equal(scene.edges.reduce((sum,e)=>sum+e.memberIds.length,0),g.edges.length);
    assert.deepEqual(scene.edges.filter(e=>e.unrouted).map(e=>e.memberIds),[]);
  }
});

test('a gesture on the legacy fixture stays fixed while affected themes yield',()=>{
  const g=fixture(),before=structuredClone(g),origin=g.layout.nodes[0];
  const fixed={unitId:origin.unitId,x:origin.x+700,y:origin.y+500,width:origin.width};
  const projected=projectCourseReadingLayout(g,{},fixed,g.nodes[1].id),target=projected.find(n=>n.unitId===fixed.unitId)!;
  assert.equal(target.x,fixed.x);assert.equal(target.y,fixed.y);assert.equal(target.width,650);
  assertNoThemeOverlap(g,projected);assert.deepEqual(g,before);
  for(const level of ['themes','units'] as const) {
    const scene=projectBoard(g,projected,level,'all');
    assert.equal(scene.edges.reduce((sum,e)=>sum+e.memberIds.length,0),g.edges.length);
    assert.deepEqual(scene.edges.filter(e=>e.unrouted).map(e=>e.memberIds),[]);
  }
});

test('a long collision chain moves whole themes, keeps a distant theme still and respects a fixed gesture',()=>{
  const g=graph([...Array(8).fill(2),1]);
  g.layout.nodes=g.nodes.map(n=>{const [theme,unit]=n.id.slice(1).split('-').map(Number);return {unitId:n.id,x:theme===8?9000:unit*700,y:theme===8?0:theme*420,width:450,height:100};});
  const saved=structuredClone(g),base=projectCourseReadingLayout(g,{}),sizes:LayoutSizes={'u0-0':{width:450,height:1800}};
  const moved=projectCourseReadingLayout(g,sizes,undefined,'u0-0');
  assert.deepEqual(g,saved);assertNoThemeOverlap(g,moved);assertRigidThemes(g,moved,sizes);
  assert.deepEqual(moved.find(n=>n.unitId==='u8-0'),base.find(n=>n.unitId==='u8-0'));
  assert.ok(moved.filter(n=>n.unitId.endsWith('-0')&&n.unitId!=='u0-0'&&n.unitId!=='u8-0'&&n.y>base.find(p=>p.unitId===n.unitId)!.y).length>=5);
  const fixed={unitId:'u5-0',x:0,y:0,width:450};
  const gesture=projectCourseReadingLayout(g,{},fixed,'u0-0');
  assert.deepEqual(gesture.find(n=>n.unitId===fixed.unitId),{...g.layout.nodes.find(n=>n.unitId===fixed.unitId)!,...fixed});
  assert.notEqual(gesture.find(n=>n.unitId==='u0-0')!.y,base.find(n=>n.unitId==='u0-0')!.y);
  assertNoThemeOverlap(g,gesture);assertRigidThemes(g,gesture,{},fixed);
  assert.deepEqual(gesture.find(n=>n.unitId==='u8-0'),base.find(n=>n.unitId==='u8-0'));
});

test('a fixed gesture on a legacy narrow unit retains its coordinates and uses the reading width',()=>{
  const g=graph([1]);g.layout.nodes=[{unitId:'u0-0',x:10,y:20,width:200,height:100}];
  const before=structuredClone(g),projected=projectCourseReadingLayout(g,{}, {unitId:'u0-0',x:100,y:200,width:200});
  assert.deepEqual(projected,[{unitId:'u0-0',x:100,y:200,width:650,height:100}]);assert.deepEqual(g,before);
});

test('nonintersecting themes do not move for an independent size change',()=>{
  const g=graph([2,2]);g.layout.nodes=[
    {unitId:'u0-0',x:0,y:0,width:400,height:100},{unitId:'u0-1',x:0,y:500,width:400,height:100},
    {unitId:'u1-0',x:3000,y:0,width:400,height:100},{unitId:'u1-1',x:3000,y:500,width:400,height:100}];
  const base=projectCourseReadingLayout(g,{}),next=projectCourseReadingLayout(g,{'u0-0':{width:400,height:300}});
  assert.deepEqual(next.filter(n=>n.unitId.startsWith('u1-')),base.filter(n=>n.unitId.startsWith('u1-')));
  assert.deepEqual(next.find(n=>n.unitId==='u0-1'),base.find(n=>n.unitId==='u0-1'));
  assertNoThemeOverlap(g,next);
});

test('twenty themes and 500 units resolve expansion without theme overlap',()=>{
  const g=graph(Array(20).fill(25));g.layout=planInitialLayout(g);
  const sizes:LayoutSizes={'u0-0':{width:850,height:3800},'u1-0':{width:620,height:2200}};
  const baseline=projectCourseReadingLayout(g,{});
  const before=structuredClone(g),start=performance.now();
  const result=projectCourseReadingLayout(g,sizes,undefined,'u0-0');
  const elapsed=performance.now()-start;
  assert.equal(result.length,500);assert.deepEqual(g,before);assertNoThemeOverlap(g,result);assertRigidThemes(g,result,sizes);
  assert.ok(result.some((node,i)=>!node.unitId.startsWith('u0-')&&!node.unitId.startsWith('u1-')&&node.y!==baseline[i].y));
  assert.ok(elapsed<5000,`500-unit projection took ${elapsed.toFixed(1)} ms`);
  console.log(`course-reading-projection units=500 themes=20 ms=${elapsed.toFixed(1)}`);
});

test('invalid identities fail explicitly; an immovable empty theme does not cancel a fixed gesture',()=>{
  const g=graph([1,0]);g.layout.nodes=[{unitId:'u0-0',x:0,y:0,width:400,height:100}];
  assert.throws(()=>projectCourseReadingLayout(g,{missing:{width:400,height:100}}),/尺寸/);
  assert.throws(()=>projectCourseReadingLayout(g,{},undefined,'missing'),/锚点/);
  assert.throws(()=>projectCourseReadingLayout(g,{}, {unitId:'missing',x:0,y:0,width:400}),/手势/);
  assert.throws(()=>projectCourseReadingLayout(g,{}, {unitId:'u0-0',x:0,y:1e100,width:400}),/手势/);
  g.layout.groups=[{themeId:'t1',x:-64,y:-112,width:528,height:276}];
  assert.deepEqual(projectCourseReadingLayout(g,{}, {unitId:'u0-0',x:0,y:0,width:400})[0],g.layout.nodes[0]);
  const projected=projectCourseReadingLayout(g,{});assert.ok(projected[0].y>0);
});
