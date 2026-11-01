import type { CourseGraph } from '../shared';
import { readingWidth, THEME_HEADER, THEME_PADDING, THEME_TITLE_SPACE } from '../layout';

export type BoardNode = { unitId:string; x:number; y:number; width:number; height:number };
export type BoardTheme = { themeId:string; title:string; x:number; y:number; width:number; height:number; units:BoardNode[] };
export type BoardRoute = { id:string; source:string; target:string; type:string; directed:boolean; memberIds:string[]; points:Array<{x:number;y:number}>; label:string; kind:'theme'|'unit'|'internal'; unrouted?:true };
export type BoardScene = { themes:BoardTheme[]; units:BoardNode[]; edges:BoardRoute[] };
export const BOARD_LAYOUT_POLICY_VERSION = 1;

type Point = { x:number; y:number };
type Rect = { x:number; y:number; width:number; height:number };
type Edge = CourseGraph['edges'][number];
const WIDTH = 620, HEIGHT = 320, GAP = 100, PAD = THEME_PADDING, HEADER = THEME_HEADER, THEME_GAP = 220;
const finiteRect = (r:Rect) => [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 && r.width <= 2400 && r.height <= 1e7 && Math.abs(r.x) <= 1e9 && Math.abs(r.y) <= 1e9;
const intersects = (a:Rect,b:Rect,gap=0) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;

function validate(graph:CourseGraph) {
  const groups = new Map<string,CourseGraph['groups'][number]>();
  const nodes = new Map<string,CourseGraph['nodes'][number]>();
  const edges = new Set<string>();
  const edgeById = new Map<string,Edge>();
  for (const group of graph.groups) {
    if (!group.id || groups.has(group.id)) throw new Error('主题身份无效或重复');
    groups.set(group.id,group);
  }
  for (const node of graph.nodes) {
    if (!node.id || nodes.has(node.id) || !groups.has(node.themeId)) throw new Error('单元身份或主题归属无效');
    nodes.set(node.id,node);
  }
  for (const edge of graph.edges) {
    if (!edge.id || edges.has(edge.id) || !nodes.has(edge.fromUnitId) || !nodes.has(edge.toUnitId) || edge.fromUnitId === edge.toUnitId || typeof edge.directed !== 'boolean' || !edge.type || !edge.view) throw new Error('关系身份或端点无效');
    edges.add(edge.id);
    edgeById.set(edge.id,edge);
  }
  const routeGroups=new Set<string>(), groupedEdges=new Set<string>();
  for(const group of graph.requirementGroups) {
    if(!group.id||routeGroups.has(group.id)||!nodes.has(group.targetUnitId)||!['all','any'].includes(group.mode)||!group.unitIds.length||group.unitIds.length!==group.relationIds.length||new Set(group.unitIds).size!==group.unitIds.length||new Set(group.relationIds).size!==group.relationIds.length) throw new Error('前置路线组无效');
    routeGroups.add(group.id);
    const units=new Set(group.unitIds),seenUnits=new Set<string>();
    for(const id of group.relationIds) {
      const e=edgeById.get(id);
      if(!e||e.type!=='requires'||e.requirementGroupId!==group.id||e.toUnitId!==group.targetUnitId||!units.has(e.fromUnitId)||seenUnits.has(e.fromUnitId)||groupedEdges.has(id)) throw new Error('前置路线组成员无效');
      groupedEdges.add(id);seenUnits.add(e.fromUnitId);
    }
  }
  for(const edge of graph.edges) if(edge.requirementGroupId&&!groupedEdges.has(edge.id)) throw new Error('前置关系引用了无效路线组');
  const degree = new Map(graph.nodes.map(n=>[n.id,0]));
  const successors = new Map(graph.nodes.map(n=>[n.id,[] as string[]]));
  for(const e of graph.edges) if(e.type==='requires') {
    if(!e.directed) throw new Error('前置关系必须有方向');
    successors.get(e.fromUnitId)!.push(e.toUnitId);
    degree.set(e.toUnitId,degree.get(e.toUnitId)!+1);
  }
  const queue=graph.nodes.filter(n=>degree.get(n.id)===0).map(n=>n.id);
  for(let i=0;i<queue.length;i++) for(const id of successors.get(queue[i])!) {
    const d=degree.get(id)!-1;degree.set(id,d);if(d===0) queue.push(id);
  }
  if(queue.length!==nodes.size) throw new Error('单元前置关系存在环');
  return {groups,nodes};
}

/** Keep the published sequence readable while using real links to choose a compact column count. */
function unitColumns(ids:string[],edges:Edge[]):number {
  if(ids.length<=1)return 1;
  const position=new Map(ids.map((id,i)=>[id,i]));
  const min=Math.max(1,Math.floor(Math.sqrt(ids.length)));
  const max=Math.min(ids.length,Math.max(min,Math.ceil(Math.sqrt(ids.length)*1.6)));
  let best=min,bestScore=Infinity;
  for(let cols=min;cols<=max;cols++) {
    const rows=Math.ceil(ids.length/cols), aspect=(cols*(WIDTH+GAP))/(rows*(HEIGHT+GAP));
    let score=Math.abs(Math.log(aspect/1.6));
    for(const edge of edges) {
      const a=position.get(edge.fromUnitId),b=position.get(edge.toUnitId);
      if(a===undefined||b===undefined)continue;
      const ax=a%cols,bx=b%cols,ay=Math.floor(a/cols),by=Math.floor(b/cols);
      if(edge.type==='requires'&&ax>bx)score+=1;
      score+=(Math.abs(ax-bx)+Math.abs(ay-by))*0.025;
    }
    if(score<bestScore-1e-9) {best=cols;bestScore=score;}
  }
  return best;
}

/** Stable topological order: published order decides between currently available units. */
function orderedUnits(ids:string[], edges:Edge[]):string[] {
  const order=new Map(ids.map((id,i)=>[id,i])),degree=new Map(ids.map(id=>[id,0]));
  const next=new Map(ids.map(id=>[id,[] as string[]]));
  for(const edge of edges) if(edge.type==='requires') {
    next.get(edge.fromUnitId)!.push(edge.toUnitId);
    degree.set(edge.toUnitId,degree.get(edge.toUnitId)!+1);
  }
  const ready=ids.filter(id=>degree.get(id)===0), result:string[]=[];
  while(ready.length) {
    ready.sort((a,b)=>order.get(a)!-order.get(b)!);
    const id=ready.shift()!;result.push(id);
    for(const to of next.get(id)!) {const d=degree.get(to)!-1;degree.set(to,d);if(d===0)ready.push(to);}
  }
  if(result.length!==ids.length) throw new Error('单元前置关系存在环');
  return result;
}

/** Condense only theme-level cycles; individual edges and unit facts remain untouched. */
function themeRanks(ids:string[],links:Array<[string,string]>) {
  const position=new Map(ids.map((id,i)=>[id,i])),adj=ids.map(()=>[] as number[]);
  for(const [a,b] of links) adj[position.get(a)!].push(position.get(b)!);
  let serial=0,count=0;const index=ids.map(()=>-1),low=ids.map(()=>0),component=ids.map(()=>-1),stack:number[]=[],active=new Set<number>();
  function visit(v:number) {
    index[v]=low[v]=serial++;stack.push(v);active.add(v);
    for(const w of adj[v]) {if(index[w]===-1){visit(w);low[v]=Math.min(low[v],low[w]);}else if(active.has(w))low[v]=Math.min(low[v],index[w]);}
    if(low[v]===index[v]) {let w:number;do {w=stack.pop()!;active.delete(w);component[w]=count;}while(w!==v);count++;}
  }
  ids.forEach((_,i)=>{if(index[i]===-1)visit(i);});
  const outgoing=Array.from({length:count},()=>new Set<number>()),incoming=Array.from({length:count},()=>new Set<number>()),degree=Array<number>(count).fill(0),rank=Array<number>(count).fill(0);
  adj.forEach((targets,i)=>targets.forEach(j=>{const a=component[i],b=component[j];if(a!==b&&!outgoing[a].has(b)){outgoing[a].add(b);incoming[b].add(a);degree[b]++;}}));
  const queue:number[]=[];degree.forEach((n,i)=>{if(n===0)queue.push(i);});
  for(let i=0;i<queue.length;i++) for(const to of outgoing[queue[i]]) {rank[to]=Math.max(rank[to],rank[queue[i]]+1);if(--degree[to]===0)queue.push(to);}
  return { ranks:new Map(ids.map((id,i)=>[id,rank[component[i]]])), components:new Map(ids.map((id,i)=>[id,component[i]])), incoming, outgoing };
}

function bounds(nodes:BoardNode[], themeId:string, title:string): BoardTheme {
  if (!nodes.length) return {themeId,title,x:0,y:0,width:WIDTH+2*PAD,height:HEADER+HEIGHT+PAD,units:[]};
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const n of nodes) {x=Math.min(x,n.x); y=Math.min(y,n.y); right=Math.max(right,n.x+n.width); bottom=Math.max(bottom,n.y+n.height);}
  return {themeId,title,x:x-PAD,y:y-HEADER,width:right-x+2*PAD,height:bottom-y+HEADER+PAD,units:nodes};
}
function layoutGroup(theme:BoardTheme) {
  const {themeId,title,x,y,width,height}=theme;
  return {elementId:`VE-G-${themeId}`,themeId,title,x,y,width,height};
}

type ThemeAggregate = { source:string; target:string; type:string; directed:boolean; memberIds:string[]; edge:Edge };
function aggregate(graph:CourseGraph, nodes:Map<string,CourseGraph['nodes'][number]>,view:string):ThemeAggregate[] {
  const groups=new Map<string,ThemeAggregate>();
  for(const edge of graph.edges) {
    if(view!=='all' && edge.view!==view) continue;
    let source=nodes.get(edge.fromUnitId)!.themeId,target=nodes.get(edge.toUnitId)!.themeId;
    if(source===target) continue;
    if(!edge.directed&&source>target) [source,target]=[target,source];
    const key=JSON.stringify([source,target,edge.type,edge.directed]);
    let group=groups.get(key);
    if(!group) {group={source,target,type:edge.type,directed:edge.directed,memberIds:[],edge};groups.set(key,group);}
    group.memberIds.push(edge.id);
  }
  for(const group of groups.values()) group.memberIds.sort();
  return [...groups.values()];
}

export function aggregateThemeRelations(graph:CourseGraph):NonNullable<CourseGraph['themeEdges']> {
  const {nodes}=validate(graph);
  return aggregate(graph,nodes,'all').map(g=>({fromThemeId:g.source,toThemeId:g.target,type:g.type,directed:g.directed,relationIds:g.memberIds,count:g.memberIds.length}));
}

export function planInitialLayout(graph:CourseGraph,options:{preserveExistingSizes?:boolean}={}):CourseGraph['layout'] {
  const {nodes}=validate(graph);
  const saved=new Map<string,BoardNode>();
  if(options.preserveExistingSizes) {
    for(const p of graph.layout.nodes) {
      if(!nodes.has(p.unitId)||saved.has(p.unitId)||!Number.isFinite(p.width)||p.width<160||p.width>2400) throw new Error('已有单元宽度无效');
      saved.set(p.unitId,p);
    }
    if(saved.size!==nodes.size) throw new Error('已有单元布局不完整');
  }
  const byTheme = new Map(graph.groups.map(g=>[g.id,[] as typeof graph.nodes]));
  for(const n of graph.nodes) byTheme.get(n.themeId)!.push(n);
  const localEdges=new Map(graph.groups.map(g=>[g.id,[] as Edge[]]));
  const themeLinks:Array<[string,string]>=[];
  for(const e of graph.edges) {const a=nodes.get(e.fromUnitId)!.themeId,b=nodes.get(e.toUnitId)!.themeId;if(a===b)localEdges.get(a)!.push(e);else if(e.type==='requires')themeLinks.push([a,b]);}
  const localThemes=graph.groups.map(g=>{
    const members=byTheme.get(g.id)!, links=localEdges.get(g.id)!;
    const ids=orderedUnits(members.map(n=>n.id),links),cols=unitColumns(ids,links);
    const sizes=ids.map(id=>{const p=saved.get(id),width=p?.width??WIDTH;
      return {width,height:p&&Number.isFinite(p.height)&&p.height>0&&p.height<=1e7?Math.max(HEIGHT,p.height):HEIGHT,effectiveWidth:readingWidth(width)};});
    const columnWidths=Array<number>(cols).fill(0),rowHeights=Array<number>(Math.ceil(ids.length/cols)).fill(0);
    sizes.forEach((size,i)=>{columnWidths[i%cols]=Math.max(columnWidths[i%cols],size.effectiveWidth);rowHeights[Math.floor(i/cols)]=Math.max(rowHeights[Math.floor(i/cols)],size.height);});
    const xOffsets:number[]=[],yOffsets:number[]=[];
    columnWidths.reduce((x,width,i)=>(xOffsets[i]=x,x+width+GAP),PAD);
    rowHeights.reduce((y,height,i)=>(yOffsets[i]=y,y+height+GAP),HEADER);
    const placed=ids.map((id,i)=>({unitId:id,x:xOffsets[i%cols],y:yOffsets[Math.floor(i/cols)],width:sizes[i].width,height:sizes[i].height}));
    const theme=bounds(placed.map((n,i)=>({...n,width:sizes[i].effectiveWidth})),g.id,g.name);
    theme.units=placed;return theme;
  });
  const {ranks,components,incoming,outgoing}=themeRanks(graph.groups.map(g=>g.id),themeLinks),connected=new Set(themeLinks.flat());
  const count=Math.max(1,Math.ceil(Math.sqrt(localThemes.length)),...Array.from(ranks.values(),r=>r+1));
  const assignment=new Map<number,number>(),heights=Array<number>(count).fill(0),weights=new Map<number,number>();
  for(const theme of localThemes) {
    let col=ranks.get(theme.themeId)!;
    if(!connected.has(theme.themeId)) {col=0;for(let i=1;i<count;i++)if(heights[i]<heights[col])col=i;}
    const component=components.get(theme.themeId)!;
    assignment.set(component,col);weights.set(component,(weights.get(component)??0)+theme.height+THEME_GAP);
    heights[col]+=theme.height+THEME_GAP;
  }
  // A rank may have many independent branches. Spread its components into
  // available later columns when this shortens the board, while every real
  // prerequisite still remains to the left of its dependent component.
  if(themeLinks.length) for(let pass=0;pass<localThemes.length*count;pass++) {
    let best:{component:number;from:number;to:number;improvement:number}|undefined;
    for(const [component,weight] of weights) {
      if(!incoming[component].size&&!outgoing[component].size)continue;
      const from=assignment.get(component)!;
      const low=Math.max(0,...[...incoming[component]].map(id=>assignment.get(id)!+1));
      const high=Math.min(count-1,...[...outgoing[component]].map(id=>assignment.get(id)!-1));
      for(let to=low;to<=high;to++) if(to!==from) {
        const improvement=heights[from]**2+heights[to]**2-(heights[from]-weight)**2-(heights[to]+weight)**2;
        if(improvement>1e-7&&(!best||improvement>best.improvement+1e-7))best={component,from,to,improvement};
      }
    }
    if(!best)break;
    const weight=weights.get(best.component)!;heights[best.from]-=weight;heights[best.to]+=weight;assignment.set(best.component,best.to);
  }
  const columns=Array.from({length:count},()=>[] as BoardTheme[]);
  for(const theme of localThemes)columns[assignment.get(components.get(theme.themeId)!)!].push(theme);
  let x=0;
  for(const column of columns) {
    let y=0,width=0;
    for(const theme of column) {
      for(const n of theme.units){n.x+=x;n.y+=y;}
      theme.x+=x;theme.y+=y;y+=theme.height+THEME_GAP;width=Math.max(width,theme.width);
    }
    if(column.length)x+=width+THEME_GAP;
  }
  const placed=new Map(localThemes.flatMap(t=>t.units.map(n=>[n.unitId,n] as const)));
  return {...graph.layout,nodes:graph.nodes.map(n=>placed.get(n.id)!),groups:localThemes.map(layoutGroup)};
}

export function planIncrementalLayout(graph:CourseGraph,unitId:string):CourseGraph['layout'] {
  const {nodes}=validate(graph), target=nodes.get(unitId);
  if(!target) throw new Error('新增单元不存在');
  const existing=new Map<string,BoardNode>();
  for(const n of graph.layout.nodes) {if(!nodes.has(n.unitId)||existing.has(n.unitId)||!finiteRect(n)) throw new Error('已有布局无效'); existing.set(n.unitId,n);}
  if(existing.has(unitId)||existing.size!==graph.nodes.length-1) throw new Error('增量布局必须恰好缺少目标单元');
  const byTheme=new Map(graph.groups.map(g=>[g.id,[] as BoardNode[]]));
  // Collision checks use the width actually shown for legacy narrow cards;
  // the returned baseline still retains every existing saved width.
  for(const n of existing.values()) byTheme.get(nodes.get(n.unitId)!.themeId)!.push({...n,width:readingWidth(n.width)});
  const peers=byTheme.get(target.themeId)!;
  const others=graph.groups.filter(g=>g.id!==target.themeId && byTheme.get(g.id)!.length).map(g=>bounds(byTheme.get(g.id)!,g.id,g.name));
  const all=[...byTheme.values()].flat();
  const reference=peers.length?bounds(peers,target.themeId,target.themeName):all.length?bounds(all,'',''):{x:0,y:0,width:0,height:0};
  const anchor=peers.length?{x:reference.x+reference.width,y:reference.y+HEADER}:all.length?{x:reference.x+reference.width+THEME_GAP+PAD,y:reference.y+HEADER}:{x:PAD,y:HEADER};
  const candidates:Point[]=[];
  for(const p of peers) candidates.push({x:p.x+p.width+GAP,y:p.y},{x:p.x,y:p.y+p.height+GAP},{x:p.x-WIDTH-GAP,y:p.y},{x:p.x,y:p.y-HEIGHT-GAP});
  candidates.push(anchor);
  let chosen:BoardNode|undefined;
  const tryCandidates=(batch:Point[])=>{
    batch.sort((a,b)=>Math.hypot(a.x-anchor.x,a.y-anchor.y)-Math.hypot(b.x-anchor.x,b.y-anchor.y)||a.y-b.y||a.x-b.x);
    for(const p of batch) {
      const n={unitId,x:p.x,y:p.y,width:WIDTH,height:HEIGHT}; if(!finiteRect(n)||all.some(q=>intersects(n,q,GAP/2))) continue;
      if(others.some(t=>intersects(n,t,THEME_GAP/4))) continue;
      const expanded=bounds([...peers,n],target.themeId,target.themeName);
      if(others.some(t=>intersects(expanded,t,THEME_GAP/4) && (!peers.length || !intersects(reference,t,THEME_GAP/4)))) continue;
      return n;
    }
  };
  chosen=tryCandidates(candidates);
  // Expand only as far as necessary; existing content is never moved.
  for(let ring=1;!chosen && ring<=all.length+2;ring++) {
    const batch:Point[]=[];
    for(let d=-ring;d<=ring;d++) batch.push({x:anchor.x+ring*(WIDTH+GAP),y:anchor.y+d*(HEIGHT+GAP)},{x:anchor.x-ring*(WIDTH+GAP),y:anchor.y+d*(HEIGHT+GAP)}, {x:anchor.x+d*(WIDTH+GAP),y:anchor.y+ring*(HEIGHT+GAP)},{x:anchor.x+d*(WIDTH+GAP),y:anchor.y-ring*(HEIGHT+GAP)});
    chosen=tryCandidates(batch);
  }
  if(!chosen) throw new Error('无法为新增单元找到有效位置');
  const theme=bounds([...peers,chosen],target.themeId,target.themeName);
  const oldGroup=graph.layout.groups.find(g=>g.themeId===target.themeId);
  const groups=graph.layout.groups.map(g=>g.themeId===target.themeId?{...g,...layoutGroup(theme)}:{...g});
  if(!oldGroup) groups.push(layoutGroup(theme));
  return {...graph.layout,nodes:[...graph.layout.nodes.map(n=>({...n})),chosen],groups};
}

type Obstacle = Rect & { category:'unit'|'theme'|'header'; id:string };
const CELL=1000, CLEARANCE=18;
class ObstacleIndex {
  private cells=new Map<string,Obstacle[]>();
  readonly xChannels:number[];
  readonly yChannels:number[];
  readonly corners:Array<{point:Point; obstacle:Obstacle}>=[];
  constructor(readonly obstacles:Obstacle[]) {
    const xs=new Set<number>(),ys=new Set<number>();
    for(const o of obstacles) {
      for(const padding of [CLEARANCE,0]) {
        const left=o.x-padding,right=o.x+o.width+padding,top=o.y-padding,bottom=o.y+o.height+padding;
        xs.add(left);xs.add(right);ys.add(top);ys.add(bottom);
        for(const point of [{x:left,y:top},{x:right,y:top},{x:left,y:bottom},{x:right,y:bottom}]) this.corners.push({point,obstacle:o});
      }
      const x1=Math.floor(o.x/CELL),x2=Math.floor((o.x+o.width)/CELL),y1=Math.floor(o.y/CELL),y2=Math.floor((o.y+o.height)/CELL);
      // Very large old rectangles stay in the overflow list rather than allocating an unbounded grid.
      if((x2-x1+1)*(y2-y1+1)>10000) {this.overflow.push(o); continue;}
      for(let x=x1;x<=x2;x++) for(let y=y1;y<=y2;y++) {const key=`${x},${y}`, list=this.cells.get(key)??[];list.push(o);this.cells.set(key,list);}
    }
    this.xChannels=[...xs];this.yChannels=[...ys];
  }
  private overflow:Obstacle[]=[];
  clear(a:Point,b:Point,include:(o:Obstacle)=>boolean):boolean {
    const minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x),minY=Math.min(a.y,b.y),maxY=Math.max(a.y,b.y);
    const seen=new Set<Obstacle>();
    const blocked=(o:Obstacle)=>{
      if(seen.has(o)||!include(o)) return false; seen.add(o);
      if(a.x===b.x) return a.x>o.x && a.x<o.x+o.width && maxY>o.y && minY<o.y+o.height;
      return a.y>o.y && a.y<o.y+o.height && maxX>o.x && minX<o.x+o.width;
    };
    if(this.overflow.some(blocked)) return false;
    const x1=Math.floor(minX/CELL),x2=Math.floor(maxX/CELL),y1=Math.floor(minY/CELL),y2=Math.floor(maxY/CELL);
    // For exceptionally long segments, scan the finite obstacle list rather than empty cells.
    if((x2-x1+1)*(y2-y1+1)>10000) return !this.obstacles.some(blocked);
    for(let x=x1;x<=x2;x++) for(let y=y1;y<=y2;y++) for(const o of this.cells.get(`${x},${y}`)??[]) if(blocked(o)) return false;
    return true;
  }
}
function ports(r:Rect,lane:number):Point[] {
  const dx=Math.max(-r.width*.3,Math.min(r.width*.3,lane)),dy=Math.max(-r.height*.3,Math.min(r.height*.3,lane));
  return [{x:r.x+r.width,y:r.y+r.height/2+dy},{x:r.x,y:r.y+r.height/2+dy},{x:r.x+r.width/2+dx,y:r.y+r.height},{x:r.x+r.width/2+dx,y:r.y}];
}
/** On old overlapping baselines the middle of a side can be blocked while another exit is free. */
function availablePorts(r:Rect,index:ObstacleIndex,include:(o:Obstacle)=>boolean):Point[] {
  const result:Point[]=[];
  const side=(vertical:boolean,fixed:number,start:number,end:number)=>{
    const breaks=new Set([start,end]);
    for(const o of index.obstacles) if(include(o)) {
      const low=vertical?o.x:o.y,high=low+(vertical?o.width:o.height);
      if(fixed<=low||fixed>=high) continue;
      const a=vertical?o.y:o.x,b=a+(vertical?o.height:o.width);
      if(b>start&&a<end) {breaks.add(Math.max(start,a));breaks.add(Math.min(end,b));}
    }
    const sorted=[...breaks].sort((a,b)=>a-b);
    const candidates=sorted.flatMap((p,i)=>i+1<sorted.length?[p,(p+sorted[i+1])/2]:[p]);
    for(const p of candidates) {
      const point=vertical?{x:fixed,y:p}:{x:p,y:fixed};
      if(index.clear(point,point,include))result.push(point);
    }
  };
  side(true,r.x,r.y,r.y+r.height);side(true,r.x+r.width,r.y,r.y+r.height);
  side(false,r.y,r.x,r.x+r.width);side(false,r.y+r.height,r.x,r.x+r.width);
  const unique=new Map(result.map(p=>[`${p.x},${p.y}`,p]));return [...unique.values()];
}
function simplify(points:Point[]):Point[] {
  const result:Point[]=[];
  for(const p of points) {
    const last=result[result.length-1]; if(last && last.x===p.x && last.y===p.y) continue;
    const prev=result[result.length-2];
    if(prev && last && ((prev.x===last.x && last.x===p.x)||(prev.y===last.y && last.y===p.y))) result.pop();
    result.push(p);
  }
  return result;
}
class Heap {
  private a:Array<{key:number;score:number}>=[];
  push(key:number,score:number) {const a=this.a;let i=a.length;a.push({key,score});while(i){const p=(i-1)>>1;if(a[p].score<=score)break;a[i]=a[p];i=p;}a[i]={key,score};}
  pop() {const a=this.a,first=a[0],last=a.pop()!;if(a.length){let i=0;while(true){let c=i*2+1;if(c>=a.length)break;if(c+1<a.length&&a[c+1].score<a[c].score)c++;if(a[c].score>=last.score)break;a[i]=a[c];i=c;}a[i]=last;}return first;}
  get length(){return this.a.length;}
}
function route(source:Rect,target:Rect,index:ObstacleIndex,include:(o:Obstacle)=>boolean,lane:number,retry=false):Point[]|undefined {
  const starts=(retry?availablePorts(source,index,include):ports(source,lane)).filter(p=>index.clear(p,p,include));
  const ends=(retry?availablePorts(target,index,include):ports(target,lane)).filter(p=>index.clear(p,p,include));
  const fallback=()=>retry?undefined:route(source,target,index,include,lane,true);
  if(!starts.length||!ends.length) return fallback();
  const clear=(a:Point,b:Point)=>index.clear(a,b,include);
  let best:Point[]|undefined, cost=Infinity;
  for(const a of starts) for(const b of ends) for(const corner of [{x:a.x,y:b.y},{x:b.x,y:a.y}]) {
    if(clear(a,corner)&&clear(corner,b)) {const length=Math.abs(a.x-b.x)+Math.abs(a.y-b.y); if(length<cost){best=simplify([a,corner,b]);cost=length;}}
  }
  if(best && best.length>=2) return best;
  // Reuse shared corridor coordinates. This common detour needs only three segments.
  const centerA={x:source.x+source.width/2,y:source.y+source.height/2},centerB={x:target.x+target.width/2,y:target.y+target.height/2};
  const xChannels=[...index.xChannels].sort((x,y)=>Math.abs(x-centerA.x)+Math.abs(x-centerB.x)-Math.abs(y-centerA.x)-Math.abs(y-centerB.x)||x-y);
  const yChannels=[...index.yChannels].sort((x,y)=>Math.abs(x-centerA.y)+Math.abs(x-centerB.y)-Math.abs(y-centerA.y)-Math.abs(y-centerB.y)||x-y);
  const pairs=starts.flatMap((a,i)=>ends.map((b,j)=>({a,b,i,j})));
  const facing=(p:Point,c:Point,other:Point)=>((p.x-c.x)*(other.x-c.x)+(p.y-c.y)*(other.y-c.y))<0?1000000:0;
  pairs.sort((p,q)=>(facing(p.a,centerA,centerB)+facing(p.b,centerB,centerA))-(facing(q.a,centerA,centerB)+facing(q.b,centerB,centerA))||p.i-q.i||p.j-q.j);
  for(const {a,b} of pairs) {
    const verticalFirst=Math.abs(centerA.x-centerB.x)>=Math.abs(centerA.y-centerB.y);
    const xPath=()=>{for(const x of xChannels) {const p={x,y:a.y},q={x,y:b.y};if(clear(a,p)&&clear(q,b)&&clear(p,q)) {const path=simplify([a,p,q,b]);if(path.length>=2)return path;}}};
    const yPath=()=>{for(const y of yChannels) {const p={x:a.x,y},q={x:b.x,y};if(clear(a,p)&&clear(q,b)&&clear(p,q)) {const path=simplify([a,p,q,b]);if(path.length>=2)return path;}}};
    const path=verticalFirst?(yPath()??xPath()):(xPath()??yPath());if(path) return path;
  }
  // Harder mazes use obstacle corners as sparse waypoints, never an X × Y grid.
  const points=[...starts,...ends,...index.corners.filter(c=>include(c.obstacle)).map(c=>c.point)];
  const distance=new Map<number,number>(),previous=new Map<number,{from:number;corner:Point}>(),heap=new Heap();
  const heuristic=(p:Point)=>Math.min(...ends.map(e=>Math.abs(e.x-p.x)+Math.abs(e.y-p.y)));
  for(let i=0;i<starts.length;i++){distance.set(i,0);heap.push(i,heuristic(points[i]));}
  let found:number|undefined;
  while(heap.length) {
    const current=heap.pop(),a=points[current.key], d=distance.get(current.key)!;
    if(current.score>d+heuristic(a)+1e-7) continue;
    if(current.key>=starts.length&&current.key<starts.length+ends.length){found=current.key;break;}
    for(let i=starts.length;i<points.length;i++) {
      const b=points[i],nd=d+Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
      if(nd >= (distance.get(i)??Infinity)) continue;
      for(const corner of [{x:a.x,y:b.y},{x:b.x,y:a.y}]) if(clear(a,corner)&&clear(corner,b)) {
        distance.set(i,nd);previous.set(i,{from:current.key,corner});heap.push(i,nd+heuristic(b));break;
      }
    }
  }
  if(found===undefined) return fallback();
  let cursor:number=found;
  const reversed:Point[]=[points[cursor]];
  while(previous.has(cursor)) {const step:{from:number;corner:Point}=previous.get(cursor)!;reversed.push(step.corner,points[step.from]);cursor=step.from;}
  const result=simplify(reversed.reverse());if(result.length<2) return fallback();return result;
}

export function projectBoard(graph:CourseGraph,placements:BoardNode[],level:'themes'|'units',relationView:string):BoardScene {
  const {nodes}=validate(graph);
  if(level!=='themes'&&level!=='units') throw new Error('显示层级无效');
  if(!['all','main','auxiliary'].includes(relationView)) throw new Error('关系视图无效');
  const byId=new Map<string,BoardNode>(), byTheme=new Map(graph.groups.map(g=>[g.id,[] as BoardNode[]]));
  for(const p of placements) {
    const n=nodes.get(p.unitId);
    if(!n||byId.has(p.unitId)||!finiteRect(p)) throw new Error('单元投影无效');
    const copy={...p};byId.set(p.unitId,copy);byTheme.get(n.themeId)!.push(copy);
  }
  if(byId.size!==nodes.size) throw new Error('单元投影不完整');
  const savedGroups=new Map(graph.layout.groups.map(g=>[g.themeId,g]));
  const themes=graph.groups.map(g=>bounds(byTheme.get(g.id)!,g.id,g.name));
  let emptyX=Math.max(0,...themes.filter(t=>t.units.length).map(t=>t.x+t.width))+THEME_GAP;
  for(const theme of themes) if(!theme.units.length) {
    const saved=savedGroups.get(theme.themeId);
    if(saved && [saved.x,saved.y,saved.width,saved.height].every(Number.isFinite) && saved.width>0 && saved.height>0) Object.assign(theme,{x:saved.x,y:saved.y,width:saved.width,height:saved.height});
    else {theme.x=emptyX;emptyX+=theme.width+THEME_GAP;}
  }
  const themeMap=new Map(themes.map(t=>[t.themeId,t]));
  const obstacles:Obstacle[]=[];
  for(const p of byId.values()) obstacles.push({...p,category:'unit',id:p.unitId});
  for(const t of themes) {
    obstacles.push({x:t.x,y:t.y-THEME_TITLE_SPACE,width:t.width,height:t.height+THEME_TITLE_SPACE,category:'theme',id:t.themeId});
    obstacles.push({x:t.x,y:t.y-THEME_TITLE_SPACE,width:t.width,height:THEME_TITLE_SPACE+HEADER-PAD/2,category:'header',id:t.themeId});
  }
  const index=new ObstacleIndex(obstacles);
  const routes:Array<{id:string;source:string;target:string;type:string;directed:boolean;memberIds:string[];kind:BoardRoute['kind'];edge:Edge}>=[];
  const usedRouteIds=new Set(graph.edges.map(e=>e.id));
  if(level==='themes') for(const g of aggregate(graph,nodes,relationView)) {
    const key=JSON.stringify([g.source,g.target,g.type,g.directed]);
    let id=`theme:${key}`;while(usedRouteIds.has(id)) id+=':';usedRouteIds.add(id);
    routes.push({id,source:g.source,target:g.target,type:g.type,directed:g.directed,memberIds:g.memberIds,kind:'theme',edge:g.edge});
  }
  for(const edge of graph.edges) {
    if(relationView!=='all'&&edge.view!==relationView) continue;
    const a=nodes.get(edge.fromUnitId)!.themeId,b=nodes.get(edge.toUnitId)!.themeId;
    if(level==='themes'&&a!==b) continue;
    routes.push({id:edge.id,source:edge.fromUnitId,target:edge.toUnitId,type:edge.type,directed:edge.directed,memberIds:[edge.id],kind:level==='themes'?'internal':'unit',edge});
  }
  const modes=new Map(graph.requirementGroups.map(g=>[g.id,g.mode]));
  const laneKeyFor=(r:typeof routes[number])=>JSON.stringify([r.kind,...[r.source,r.target].sort()]);
  const laneTotals=new Map<string,number>(),lanes=new Map<string,number>();
  for(const r of routes) {const key=laneKeyFor(r);laneTotals.set(key,(laneTotals.get(key)??0)+1);}
  const edges:BoardRoute[]=routes.map(r=>{
    const a=r.kind==='theme'?themeMap.get(r.source)!:byId.get(r.source)!, b=r.kind==='theme'?themeMap.get(r.target)!:byId.get(r.target)!;
    const ta=r.kind==='theme'?r.source:nodes.get(r.source)!.themeId, tb=r.kind==='theme'?r.target:nodes.get(r.target)!.themeId;
    const include=(o:Obstacle)=>r.kind==='theme'?o.category==='theme':o.category==='unit'?(nodes.get(o.id)!.themeId===ta||nodes.get(o.id)!.themeId===tb):o.category==='header'?(o.id===ta||o.id===tb):(o.id!==ta&&o.id!==tb);
    const laneKey=laneKeyFor(r), n=lanes.get(laneKey)??0;lanes.set(laneKey,n+1);
    const lane=((n+1)/(laneTotals.get(laneKey)!+1)-.5)*Math.min(a.width,a.height,b.width,b.height)*.6;
    const points=route(a,b,index,include,lane);
    const label=r.kind==='theme'?`${r.type} · ${r.memberIds.length} 条已有关系`:r.edge.requirementGroupId?`${r.type} · ${r.edge.requirementGroupId}（${modes.get(r.edge.requirementGroupId)==='any'?'或':'且'}）`:r.type;
    return {id:r.id,source:r.source,target:r.target,type:r.type,directed:r.directed,memberIds:r.memberIds,kind:r.kind,points:points??[],label,...(!points?{unrouted:true as const}:{})};
  });
  return {themes,units:graph.nodes.map(n=>byId.get(n.id)!),edges};
}
