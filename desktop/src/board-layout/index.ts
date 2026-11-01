import type { CourseGraph } from '../shared';
import { readingWidth, THEME_HEADER, THEME_PADDING, THEME_TITLE_SPACE, THEME_TITLE_MAX } from '../layout';

export type BoardNode = { unitId:string; x:number; y:number; width:number; height:number };
export type BoardTheme = { themeId:string; title:string; x:number; y:number; width:number; height:number; units:BoardNode[] };
export type BoardRoute = { id:string; source:string; target:string; type:string; directed:boolean; memberIds:string[]; points:Array<{x:number;y:number}>; label:string; kind:'theme'|'unit'|'internal'; unrouted?:true };
export type BoardScene = { themes:BoardTheme[]; units:BoardNode[]; edges:BoardRoute[] };
export const BOARD_LAYOUT_POLICY_VERSION = 4;

type Point = { x:number; y:number };
type Rect = { x:number; y:number; width:number; height:number };
type Edge = CourseGraph['edges'][number];
const WIDTH = 620, HEIGHT = 320, GAP = 100, PAD = THEME_PADDING, HEADER = THEME_HEADER, THEME_GAP = 220;
const THEME_ROW_GAP = THEME_TITLE_MAX + 160, THEME_COLUMN_GAP = 5200, THEME_TITLE_WIDTH = 4200;
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
    let score=Math.abs(Math.log(aspect/2.2))+.05*cols;
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

/** Schedule themes in published order subject to component prerequisites.
 * Components of at most four themes share a column; larger ones may split. */
function themeLayers(themes:BoardTheme[],edges:Edge[],nodes:Map<string,CourseGraph['nodes'][number]>):BoardTheme[][] {
  const order=new Map(themes.map((t,i)=>[t.themeId,i]));
  const outgoing=themes.map(()=>new Set<number>());
  for(const edge of edges) if(edge.type==='requires') {
    const a=order.get(nodes.get(edge.fromUnitId)!.themeId)!,b=order.get(nodes.get(edge.toUnitId)!.themeId)!;
    if(a!==b)outgoing[a].add(b);
  }
  // Kosaraju's algorithm uses an explicit stack so large courses do not depend
  // on the JavaScript call-stack limit. Sorted neighbours make ties stable.
  const forward=outgoing.map(s=>[...s].sort((a,b)=>a-b));
  const reverse=themes.map(()=>[] as number[]);
  forward.forEach((next,a)=>next.forEach(b=>reverse[b].push(a)));
  const seen=new Set<number>(),finished:number[]=[];
  for(let root=0;root<themes.length;root++) {
    if(seen.has(root))continue;
    const stack:Array<{node:number;next:number}>=[{node:root,next:0}];seen.add(root);
    while(stack.length) {
      const frame=stack[stack.length-1],children=forward[frame.node];
      if(frame.next<children.length) {const child=children[frame.next++];if(!seen.has(child)){seen.add(child);stack.push({node:child,next:0});}}
      else {finished.push(frame.node);stack.pop();}
    }
  }
  const component=Array<number>(themes.length).fill(-1),members:number[][]=[];
  for(const root of finished.reverse()) {
    if(component[root]!==-1)continue;
    const id=members.length,stack=[root],items:number[]=[];component[root]=id;
    while(stack.length) {const node=stack.pop()!;items.push(node);for(const child of reverse[node])if(component[child]===-1){component[child]=id;stack.push(child);}}
    members.push(items);
  }
  for(const items of members) items.sort((a,b)=>a-b);
  const next=members.map(()=>new Set<number>()),indegree=members.map(()=>0);
  forward.forEach((children,a)=>children.forEach(b=>{const from=component[a],to=component[b];if(from!==to&&!next[from].has(to)){next[from].add(to);indegree[to]++;}}));
  // Give each prerequisite the priority of its earliest dependent. This moves
  // a later prerequisite ahead of that dependent without needlessly moving
  // intervening, unrelated themes ahead of it as well.
  const remaining=[...indegree],topological=members.map((_,i)=>i).filter(i=>remaining[i]===0);
  for(let cursor=0;cursor<topological.length;cursor++)for(const to of next[topological[cursor]])if(--remaining[to]===0)topological.push(to);
  const priority=members.map(items=>items[0]),dependentPriority=members.map(()=>Infinity);
  for(let i=topological.length-1;i>=0;i--)for(const to of next[topological[i]]) {
    const id=topological[i];dependentPriority[id]=Math.min(dependentPriority[id],priority[to]);
    priority[id]=Math.min(priority[id],priority[to]);
  }
  const ready=members.map((_,i)=>i).filter(i=>indegree[i]===0);
  const offsets=members.map(()=>0),layers:BoardTheme[][]=[],columnComponents=new Set<number>();
  let column:BoardTheme[]=[];
  const flush=()=>{if(column.length)layers.push(column);column=[];columnComponents.clear();};
  while(ready.length) {
    const key=(id:number)=>Math.min(members[id][offsets[id]],dependentPriority[id]);
    ready.sort((a,b)=>key(a)-key(b)||members[a][offsets[a]]-members[b][offsets[b]]);
    let id=ready[0];
    // Reserve room for all remaining members of every small cycle already
    // started here. Intervening themes retain their order whenever they fit.
    const pending=[...columnComponents].filter(c=>members[c].length>1&&members[c].length<=4&&offsets[c]<members[c].length);
    const reserved=pending.reduce((sum,c)=>sum+members[c].length-offsets[c],0);
    const startsSmall=offsets[id]===0&&members[id].length>1&&members[id].length<=4;
    const cost=startsSmall?members[id].length:1;
    const conflicts=[...columnComponents].some(parent=>next[parent].has(id));
    const nextPending=pending.length?Math.min(...pending.map(c=>members[c][offsets[c]])):Infinity;
    if(pending.length&&!pending.includes(id)&&(conflicts||pending.some(c=>members[c].length===4)||column.length+reserved+cost>3||members[id][offsets[id]]>nextPending)) {
      pending.sort((a,b)=>members[a][offsets[a]]-members[b][offsets[b]]);id=pending[0];
    }
    const items=members[id];
    // A predecessor cannot share this physical column, even indirectly: every
    // path's final edge has a predecessor in a strictly earlier column.
    const dependsOnColumn=[...columnComponents].some(parent=>next[parent].has(id));
    const fourthOwnCycle=column.length===3&&items.length>=4&&columnComponents.size===1&&columnComponents.has(id);
    const smallStart=offsets[id]===0&&items.length>1&&items.length<=4;
    const noRoomForSmall=smallStart&&(items.length===4?column.length>0:column.length+items.length>3);
    // Only ready themes can appear between members of this cycle: dependents
    // must wait until the whole component is placed. Reserve a fresh column
    // when that keeps the available intervening themes in course order.
    const intervening=smallStart&&ready.some(other=>other!==id&&members[other].slice(offsets[other])
      .some(index=>index>items[0]&&index<items[items.length-1]));
    const preserveInterval=smallStart&&items.length===2&&intervening&&column.length+items.length+1>3;
    if(dependsOnColumn||noRoomForSmall||preserveInterval||(items.length>4&&offsets[id]===0&&column.length>0)||(column.length>=3&&!fourthOwnCycle))flush();
    column.push(themes[items[offsets[id]++]]);columnComponents.add(id);
    if(offsets[id]===items.length) {
      ready.splice(ready.indexOf(id),1);
      for(const to of next[id]) if(--indegree[to]===0)ready.push(to);
    }
  }
  flush();
  return layers;
}

function bounds(nodes:BoardNode[], themeId:string, title:string): BoardTheme {
  if (!nodes.length) return {themeId,title,x:0,y:0,width:WIDTH+2*PAD,height:HEADER+HEIGHT+PAD,units:[]};
  let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
  for(const n of nodes) {x=Math.min(x,n.x); y=Math.min(y,n.y); right=Math.max(right,n.x+n.width); bottom=Math.max(bottom,n.y+n.height);}
  return {themeId,title,x:x-PAD,y:y-HEADER,width:right-x+2*PAD,height:bottom-y+HEADER+PAD,units:nodes};
}

/** Titles can extend into free horizontal space without covering the next column. */
const estimatedTitleWidth=(title:string)=>[...title].reduce((sum,char)=>sum+(/[^\x00-\x7f]/.test(char)?500:300),0);
export function themeTitleWidth(theme:BoardTheme,themes:BoardTheme[]):number {
  const next=Math.min(...themes.filter(other=>other.x>theme.x).map(other=>other.x));
  const estimated=estimatedTitleWidth(theme.title);
  return Math.max(theme.width,Math.min(THEME_TITLE_WIDTH,estimated,next-theme.x-160));
}

/** Older hand-positioned themes keep their one-line title when there is no room above. */
export function themeTitleSpace(theme:BoardTheme,themes:BoardTheme[]):number {
  const width=themeTitleWidth(theme,themes);
  // One line at the maximum overview font needs half the two-line reserve,
  // plus room for glyph overhang. Longer titles retain the full reserve.
  const safeWidth=[...theme.title].reduce((sum,char)=>sum+(/[^\x00-\x7f]/.test(char)?500:600),0);
  const height=safeWidth<=width?THEME_TITLE_MAX/2+50:THEME_TITLE_MAX;
  const title={x:theme.x,y:theme.y-height,width,height};
  return themes.some(other=>other!==theme&&intersects(title,other))?THEME_TITLE_SPACE:height;
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
  const incident=new Map(graph.groups.map(g=>[g.id,new Set<string>()]));
  for(const e of graph.edges) {
    const a=nodes.get(e.fromUnitId)!.themeId,b=nodes.get(e.toUnitId)!.themeId;
    if(a!==b){const key=JSON.stringify([a,b,e.type,e.directed]);incident.get(a)!.add(key);incident.get(b)!.add(key);}
  }
  for(const e of graph.edges) {const a=nodes.get(e.fromUnitId)!.themeId,b=nodes.get(e.toUnitId)!.themeId;if(a===b)localEdges.get(a)!.push(e);}
  const localThemes=graph.groups.map(g=>{
    const members=byTheme.get(g.id)!, links=localEdges.get(g.id)!;
    const ids=members.map(n=>n.id),cols=unitColumns(ids,links);
    const sizes=ids.map(id=>{const p=saved.get(id),width=p?.width??WIDTH;
      return {width,height:p&&Number.isFinite(p.height)&&p.height>0&&p.height<=1e7?Math.max(HEIGHT,p.height):HEIGHT,effectiveWidth:readingWidth(width)};});
    const columnWidths=Array<number>(cols).fill(0),rowHeights=Array<number>(Math.ceil(ids.length/cols)).fill(0);
    sizes.forEach((size,i)=>{columnWidths[i%cols]=Math.max(columnWidths[i%cols],size.effectiveWidth);rowHeights[Math.floor(i/cols)]=Math.max(rowHeights[Math.floor(i/cols)],size.height);});
    const xOffsets:number[]=[],yOffsets:number[]=[];
    columnWidths.reduce((x,width,i)=>(xOffsets[i]=x,x+width+GAP),PAD);
    // Give busy themes enough edge ports to keep their relations distinct.
    const rowGap=Math.max(GAP,Math.min(900,(incident.get(g.id)!.size-2)*280));
    rowHeights.reduce((y,height,i)=>(yOffsets[i]=y,y+height+rowGap),HEADER);
    const placed=ids.map((id,i)=>({unitId:id,x:xOffsets[i%cols],y:yOffsets[Math.floor(i/cols)],width:sizes[i].width,height:sizes[i].height}));
    const theme=bounds(placed.map((n,i)=>({...n,width:sizes[i].effectiveWidth})),g.id,g.name);
    theme.units=placed;return theme;
  });
  const layers=themeLayers(localThemes,graph.edges,nodes);
  let x=0;
  for(const layer of layers) {
    let bottom=-THEME_ROW_GAP, width=0;
    for(const theme of layer) {
      const y=bottom+THEME_ROW_GAP;
      for(const n of theme.units){n.x+=x;n.y+=y;}
      theme.x+=x;theme.y+=y;bottom=y+theme.height;width=Math.max(width,theme.width);
    }
    x+=width+THEME_COLUMN_GAP;
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

type Obstacle = Rect & { category:'unit'|'theme'|'header'|'theme-buffer'; id:string };
const CELL=1000, CLEARANCE=18, THEME_ROUTE_CLEARANCE=180;
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
  const dx=Math.max(-r.width*.47,Math.min(r.width*.47,lane)),dy=Math.max(-r.height*.47,Math.min(r.height*.47,lane));
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
    if(prev && last && ((prev.x===last.x && last.x===p.x)||(prev.y===last.y && last.y===p.y)) &&
      (last.x-prev.x)*(p.x-last.x)+(last.y-prev.y)*(p.y-last.y)>=0) result.pop();
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

type Segment={a:Point;b:Point;vertical:boolean};
type PortLane={offset:number;index:number;count:number};
/** Penalise shared segments and crossings without scanning every previous edge. */
class RouteTraffic {
  private cells=new Map<string,Segment[]>();
  private all:Segment[]=[];
  private overflow:Segment[]=[];
  private readonly separation=320;
  private each(a:Point,b:Point,padding:number,visit:(key:string)=>void):boolean {
    const x1=Math.floor((Math.min(a.x,b.x)-padding)/CELL),x2=Math.floor((Math.max(a.x,b.x)+padding)/CELL);
    const y1=Math.floor((Math.min(a.y,b.y)-padding)/CELL),y2=Math.floor((Math.max(a.y,b.y)+padding)/CELL);
    if((x2-x1+1)*(y2-y1+1)>10000)return false;
    for(let x=x1;x<=x2;x++)for(let y=y1;y<=y2;y++)visit(`${x},${y}`);
    return true;
  }
  add(points:Point[]) {
    for(let i=1;i<points.length;i++) {
      const segment={a:points[i-1],b:points[i],vertical:points[i-1].x===points[i].x};
      this.all.push(segment);
      if(!this.each(segment.a,segment.b,0,key=>{const list=this.cells.get(key)??[];list.push(segment);this.cells.set(key,list);} ))this.overflow.push(segment);
    }
  }
  score(points:Point[]):number {
    let penalty=0;
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],vertical=a.x===b.x,seen=new Set<Segment>();
      const check=(other:Segment)=>{
        if(seen.has(other))return;seen.add(other);
        if(vertical===other.vertical) {
          const distance=Math.abs((vertical?a.x:a.y)-(vertical?other.a.x:other.a.y));
          if(distance>=this.separation)return;
          const first=vertical?[a.y,b.y]:[a.x,b.x],second=vertical?[other.a.y,other.b.y]:[other.a.x,other.b.x];
          const overlap=Math.max(0,Math.min(Math.max(...first),Math.max(...second))-Math.max(Math.min(...first),Math.min(...second)));
          // A shared segment makes two relationships indistinguishable; an
          // isolated crossing is preferable when no clear route exists.
          penalty+=overlap*((1-distance/this.separation)*12+(distance<1e-6?1000:0));
        } else {
          const v=vertical?{a,b}:other,h=vertical?other:{a,b};
          // One clear crossing costs two lane separations, not a detour of
          // arbitrary length. Shared or closely parallel ink remains costly.
          if(v.a.x>Math.min(h.a.x,h.b.x)&&v.a.x<Math.max(h.a.x,h.b.x)&&h.a.y>Math.min(v.a.y,v.b.y)&&h.a.y<Math.max(v.a.y,v.b.y))penalty+=2*this.separation;
        }
      };
      const inGrid=this.each(a,b,this.separation,key=>{for(const segment of this.cells.get(key)??[])check(segment);});
      for(const segment of inGrid?this.overflow:this.all)check(segment);
    }
    return penalty;
  }
}

function route(source:Rect,target:Rect,index:ObstacleIndex,include:(o:Obstacle)=>boolean,startLane:PortLane,endLane:PortLane,traffic:RouteTraffic,deep:boolean,forward=false,overview=false,retry=false,relaxed=false):Point[]|undefined {
  const startPorts=(retry?availablePorts(source,index,include):ports(source,startLane.offset)).filter(p=>index.clear(p,p,include)&&(!forward||relaxed||p.x===source.x+source.width));
  const endPorts=(retry?availablePorts(target,index,include):ports(target,endLane.offset)).filter(p=>index.clear(p,p,include)&&(!forward||relaxed||p.x===target.x));
  // In a left-to-right prerequisite column, leave and enter horizontally
  // before turning. This prevents a line from following a theme border.
  const room=forward&&!relaxed?Math.max(0,(target.x-source.x-source.width)/3):0;
  const stub=(lane:PortLane)=>{
    const base=Math.min(600,lane.count>1?room/2:room);
    return base+(lane.count>1?lane.index*Math.min(320,(room-base)/(lane.count-1)):0);
  };
  const startPairs=startPorts.map(port=>({port,point:{x:port.x+stub(startLane),y:port.y}})).filter(p=>index.clear(p.port,p.point,include));
  const endPairs=endPorts.map(port=>({port,point:{x:port.x-stub(endLane),y:port.y}})).filter(p=>index.clear(p.port,p.point,include));
  const starts=startPairs.map(pair=>pair.point),ends=endPairs.map(pair=>pair.point);
  const attach=(points:Point[])=>{
    const first=startPairs.find(p=>p.point.x===points[0].x&&p.point.y===points[0].y);
    const last=endPairs.find(p=>p.point.x===points[points.length-1].x&&p.point.y===points[points.length-1].y);
    return simplify([...(first?[first.port]:[]),...points,...(last?[last.port]:[])]);
  };
  const forwardPath=(points:Point[])=>!forward||relaxed||points.every((p,i)=>i===0||p.x>=points[i-1].x);
  const fallback=()=>forward&&!relaxed?route(source,target,index,include,startLane,endLane,traffic,deep,forward,overview,false,true):retry?undefined:route(source,target,index,include,startLane,endLane,traffic,deep,forward,overview,true,relaxed);
  if(!starts.length||!ends.length) return fallback();
  const clear=(a:Point,b:Point)=>index.clear(a,b,include);
  const centerA={x:source.x+source.width/2,y:source.y+source.height/2},centerB={x:target.x+target.width/2,y:target.y+target.height/2};
  const facing=(p:Point,c:Point,other:Point)=>((p.x-c.x)*(other.x-c.x)+(p.y-c.y)*(other.y-c.y))<0?250:0;
  let best:Point[]|undefined, cost=Infinity, bestTraffic=Infinity;
  const consider=(points:Point[])=>{
    const path=attach(simplify(points));if(path.length<2||!forwardPath(path))return;
    let length=0;for(let i=1;i<path.length;i++)length+=Math.abs(path[i].x-path[i-1].x)+Math.abs(path[i].y-path[i-1].y);
    const congestion=traffic.score(path),endsCost=facing(path[0],centerA,centerB)+facing(path[path.length-1],centerB,centerA);
    const score=length+congestion+endsCost+(path.length-2)*40;
    if(score<cost-1e-7){best=path;cost=score;bestTraffic=congestion;}
  };
  for(const a of starts) for(const b of ends) for(const corner of [{x:a.x,y:b.y},{x:b.x,y:a.y}]) {
    if(clear(a,corner)&&clear(corner,b))consider([a,corner,b]);
  }
  if(best && (bestTraffic===0 || (!deep&&!overview))) return best;
  // Try adjacent lanes when a direct path shares a corridor or crosses another edge.
  const xChannels=[...index.xChannels].sort((x,y)=>Math.abs(x-centerA.x)+Math.abs(x-centerB.x)-Math.abs(y-centerA.x)-Math.abs(y-centerB.x)||x-y);
  const yChannels=[...index.yChannels].sort((x,y)=>Math.abs(x-centerA.y)+Math.abs(x-centerB.y)-Math.abs(y-centerA.y)-Math.abs(y-centerB.y)||x-y);
  const pairs=starts.flatMap((a,i)=>ends.map((b,j)=>({a,b,i,j})));
  pairs.sort((p,q)=>(facing(p.a,centerA,centerB)+facing(p.b,centerB,centerA))-(facing(q.a,centerA,centerB)+facing(q.b,centerB,centerA))||p.i-q.i||p.j-q.j);
  // Dense overview maps cannot afford a full graph search for every edge.
  // Still compare several independent corridors before accepting a shared one.
  if(!deep&&overview)for(const {a,b} of pairs.slice(0,4)) {
    const xs=[a.x,b.x,...Array.from({length:15},(_,i)=>a.x+(b.x-a.x)*(i+1)/16),...xChannels.slice(0,8)];
    const ys=[a.y,b.y,...yChannels.slice(0,8),...[-2,-1,1,2].flatMap(n=>[a.y+n*320,b.y+n*320])];
    for(const x of xs) {const p={x,y:a.y},q={x,y:b.y};if(clear(a,p)&&clear(p,q)&&clear(q,b))consider([a,p,q,b]);}
    for(const y of ys) {const p={x:a.x,y},q={x:b.x,y};if(clear(a,p)&&clear(p,q)&&clear(q,b))consider([a,p,q,b]);}
    if(best&&bestTraffic===0)break;
  }
  if(best&&!deep&&overview)return best;
  if(!deep)for(const {a,b} of pairs) {
    const xPath=()=>{for(const x of xChannels) {const p={x,y:a.y},q={x,y:b.y};if(clear(a,p)&&clear(q,b)&&clear(p,q)) {const path=simplify([a,p,q,b]);if(path.length>=2&&forwardPath(attach(path)))return path;}}};
    const yPath=()=>{for(const y of yChannels) {const p={x:a.x,y},q={x:b.x,y};if(clear(a,p)&&clear(q,b)&&clear(p,q)) {const path=simplify([a,p,q,b]);if(path.length>=2&&forwardPath(attach(path)))return path;}}};
    const verticalFirst=Math.abs(centerA.x-centerB.x)>=Math.abs(centerA.y-centerB.y);
    const path=verticalFirst?(yPath()??xPath()):(xPath()??yPath());if(path)return attach(path);
  }
  const nearby=(channels:number[])=>[...new Set(channels.slice(0,18).flatMap(value=>[value,value-64,value+64]))];
  const xs=nearby(xChannels),ys=nearby(yChannels);
  for(const {a,b} of deep?pairs.slice(0,8):[]) {
    for(const x of xs) {const p={x,y:a.y},q={x,y:b.y};if(clear(a,p)&&clear(q,b)&&clear(p,q))consider([a,p,q,b]);}
    for(const y of ys) {const p={x:a.x,y},q={x:b.x,y};if(clear(a,p)&&clear(q,b)&&clear(p,q))consider([a,p,q,b]);}
    // Turning at a clear obstacle corner permits a line to pass beside a
    // theme without sharing its border or crossing neighbouring exits.
    for(const {point:q,obstacle} of index.corners)if(include(obstacle)) {
      const p={x:q.x,y:a.y},r={x:b.x,y:q.y};
      if(clear(a,p)&&clear(p,q)&&clear(q,r)&&clear(r,b))consider([a,p,q,r,b]);
    }
  }
  if(best && (bestTraffic===0 || !deep))return best;
  // Try nearby, distinct traversable corners first. If they cannot connect
  // the ports, search the complete set rather than losing a valid relation.
  const cornerDistance=(p:Point)=>Math.abs(p.x-centerA.x)+Math.abs(p.y-centerA.y)+Math.abs(p.x-centerB.x)+Math.abs(p.y-centerB.y);
  const unique=new Map<string,Point>();
  for(const {point,obstacle} of index.corners)if(include(obstacle))unique.set(`${point.x},${point.y}`,point);
  const corners=[...unique.values()].filter(point=>clear(point,point))
    .sort((a,b)=>cornerDistance(a)-cornerDistance(b)||a.x-b.x||a.y-b.y);
  const heuristic=(p:Point)=>Math.min(...ends.map(e=>Math.abs(e.x-p.x)+Math.abs(e.y-p.y)));
  const search=(candidates:Point[]):Point[]|undefined=>{
    const points=[...starts,...ends,...candidates];
    const distance=new Map<number,number>(),previous=new Map<number,{from:number;corner:Point}>(),heap=new Heap();
    for(let i=0;i<starts.length;i++) {
      const initial=facing(points[i],centerA,centerB);distance.set(i,initial);heap.push(i,initial+heuristic(points[i]));
    }
    let found:number|undefined;
    while(heap.length) {
      const current=heap.pop(),a=points[current.key],d=distance.get(current.key)!;
      if(current.score>d+heuristic(a)+1e-7) continue;
      if(current.key>=starts.length&&current.key<starts.length+ends.length){found=current.key;break;}
      for(let i=starts.length;i<points.length;i++) {
        const b=points[i],length=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
        for(const corner of [{x:a.x,y:b.y},{x:b.x,y:a.y}]) if((!forward||relaxed||(corner.x>=a.x&&b.x>=corner.x))&&clear(a,corner)&&clear(corner,b)) {
          const nd=d+length+(deep?traffic.score(simplify([a,corner,b])):0);
          if(nd >= (distance.get(i)??Infinity))continue;
          distance.set(i,nd);previous.set(i,{from:current.key,corner});heap.push(i,nd+heuristic(b));
        }
      }
    }
    if(found===undefined)return undefined;
    let cursor:number=found;
    const reversed:Point[]=[points[cursor]];
    while(previous.has(cursor)) {const step:{from:number;corner:Point}=previous.get(cursor)!;reversed.push(step.corner,points[step.from]);cursor=step.from;}
    return reversed.reverse();
  };
  let path=search(corners.slice(0,256));
  if(!path&&!best&&corners.length>256)path=search(corners);
  if(path)consider(path);
  return best??fallback();
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
    const titleSpace=themeTitleSpace(t,themes);
    obstacles.push({x:t.x,y:t.y,width:t.width,height:t.height,category:'theme',id:t.themeId});
    obstacles.push({x:t.x-THEME_ROUTE_CLEARANCE,y:t.y-THEME_ROUTE_CLEARANCE,width:t.width+2*THEME_ROUTE_CLEARANCE,
      height:t.height+2*THEME_ROUTE_CLEARANCE,category:'theme-buffer',id:t.themeId});
    obstacles.push({x:t.x,y:t.y-titleSpace,width:themeTitleWidth(t,themes),height:titleSpace+HEADER-PAD/2,category:'header',id:t.themeId});
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
  // Route and allocate lanes in a stable order, independently of how relation
  // records happened to be returned from storage.
  routes.sort((a,b)=>(a.kind==='theme'?0:1)-(b.kind==='theme'?0:1)||(a.id<b.id?-1:a.id>b.id?1:0));
  // Refinement searches multiple alternative lanes. Bound it for dense maps;
  // every relation still gets the normal obstacle-aware route and port lane.
  const themeRouteCount=routes.filter(r=>r.kind==='theme').length;
  // Deep routing considers obstacle corners pairwise. Bound both those
  // corners (three theme obstacles, eight corners each) and the complete
  // traffic set, including internal routes, independently of alignment.
  const refineOverview=themes.length<=20&&index.obstacles.length<=160&&routes.length<=100&&themeRouteCount<=20 && themeRouteCount<=Math.max(8,Math.ceil(themes.length*1.25));
  const modes=new Map(graph.requirementGroups.map(g=>[g.id,g.mode]));
  const endpointKey=(r:typeof routes[number],id:string)=>JSON.stringify([r.kind==='theme'?'theme':'unit',id]);
  const laneTotals=new Map<string,number>(),lanes=new Map<string,number>(),traffic=new RouteTraffic();
  for(const r of routes)for(const id of [r.source,r.target]) {
    const key=endpointKey(r,id);laneTotals.set(key,(laneTotals.get(key)??0)+1);
  }
  const nextLane=(key:string,rect:Rect)=>{
    const n=lanes.get(key)??0;lanes.set(key,n+1);
    const count=laneTotals.get(key)!;
    return {offset:((n+1)/(count+1)-.5)*Math.min(rect.width,rect.height)*.95,index:n,count};
  };
  // Endpoints that share a side follow the other themes' spatial order. An
  // arbitrary relation ID order makes neighbouring lines cross at the port.
  type Incident={routeId:string;start:boolean;rect:Rect;other:Rect;side:'left'|'right'|'top'|'bottom'};
  const incidents=new Map<string,Incident[]>(),themeLanes=new Map<string,PortLane>();
  const addIncident=(r:typeof routes[number],rect:Rect,other:Rect,start:boolean)=>{
    const cy=rect.y+rect.height/2,oy=other.y+other.height/2;
    const side=other.x>=rect.x+rect.width?'right':other.x+other.width<=rect.x?'left':oy>=cy?'bottom':'top';
    const key=JSON.stringify([start?r.source:r.target,side]),entries=incidents.get(key)??[];
    entries.push({routeId:r.id,start,rect,other,side});incidents.set(key,entries);
  };
  for(const r of routes)if(r.kind==='theme') {
    const a=themeMap.get(r.source)!,b=themeMap.get(r.target)!;
    addIncident(r,a,b,true);addIncident(r,b,a,false);
  }
  for(const entries of incidents.values()) {
    const horizontal=entries[0].side==='left'||entries[0].side==='right';
    const stable=(a:Incident,b:Incident)=>(a.routeId<b.routeId?-1:a.routeId>b.routeId?1:0)||Number(a.start)-Number(b.start);
    entries.sort((a,b)=>horizontal
      ?(a.other.y+a.other.height/2)-(b.other.y+b.other.height/2)||(a.other.x+a.other.width/2)-(b.other.x+b.other.width/2)||stable(a,b)
      :(a.other.x+a.other.width/2)-(b.other.x+b.other.width/2)||(a.other.y+a.other.height/2)-(b.other.y+b.other.height/2)||stable(a,b));
    entries.forEach((entry,n)=>{
      const count=entries.length,span=horizontal?entry.rect.height:entry.rect.width;
      themeLanes.set(JSON.stringify([entry.routeId,entry.start]),{offset:((n+1)/(count+1)-.5)*span*.95,index:n,count});
    });
  }
  const drafts=routes.map(r=>{
    const a=r.kind==='theme'?themeMap.get(r.source)!:byId.get(r.source)!, b=r.kind==='theme'?themeMap.get(r.target)!:byId.get(r.target)!;
    const ta=r.kind==='theme'?r.source:nodes.get(r.source)!.themeId, tb=r.kind==='theme'?r.target:nodes.get(r.target)!.themeId;
    const include=(o:Obstacle)=>r.kind==='theme'
      ?o.category==='theme-buffer'?o.id!==ta&&o.id!==tb&&!intersects(o,a)&&!intersects(o,b):o.category==='theme'||o.category==='header'
      :o.category==='theme-buffer'?false:o.category==='unit'?(nodes.get(o.id)!.themeId===ta||nodes.get(o.id)!.themeId===tb):o.category==='header'?true:(o.id!==ta&&o.id!==tb);
    const startLane=r.kind==='theme'?themeLanes.get(JSON.stringify([r.id,true]))!:nextLane(endpointKey(r,r.source),a);
    const endLane=r.kind==='theme'?themeLanes.get(JSON.stringify([r.id,false]))!:nextLane(endpointKey(r,r.target),b);
    const forward=r.kind==='theme'&&r.type==='requires'&&a.x+a.width<b.x;
    let routeInclude=include;
    let points=route(a,b,index,routeInclude,startLane,endLane,traffic,r.kind==='theme'&&refineOverview,forward,r.kind==='theme');
    // A cramped saved layout may not have room for the extra visual buffer.
    // Keep the relationship reachable using the actual content bounds instead.
    if(!points&&r.kind==='theme') {
      routeInclude=o=>o.category!=='theme-buffer'&&include(o);
      points=route(a,b,index,routeInclude,startLane,endLane,traffic,refineOverview,forward,true);
    }
    if(points)traffic.add(points);
    return {r,a,b,include:routeInclude,startLane,endLane,forward,points};
  });
  // A long route laid first may force many later crossings. Give the bounded
  // set of overview routes a chance to move after all lanes are visible.
  const overview=drafts.filter(draft=>draft.r.kind==='theme');
  if(refineOverview||overview.length<=80)for(let pass=0;pass<2;pass++) {
    let changed=false;
    for(const draft of overview) {
      if(!draft.points)continue;
      const occupied=new RouteTraffic();
      for(const other of drafts)if(other!==draft&&other.points)occupied.add(other.points);
      const quality=(path:Point[])=>path.slice(1).reduce((sum,p,i)=>sum+Math.abs(p.x-path[i].x)+Math.abs(p.y-path[i].y),0)
        +(path.length-2)*40+occupied.score(path);
      const before=quality(draft.points);
      const candidate=route(draft.a,draft.b,index,draft.include,draft.startLane,draft.endLane,occupied,refineOverview,draft.forward,true);
      if(candidate && quality(candidate)<before-1e-7){draft.points=candidate;changed=true;}
    }
    if(!changed)break;
  }
  const edges:BoardRoute[]=drafts.map(({r,points})=>{
    const label=r.kind==='theme'?`${r.type} · ${r.memberIds.length} 条已有关系`:r.edge.requirementGroupId?`${r.type} · ${r.edge.requirementGroupId}（${modes.get(r.edge.requirementGroupId)==='any'?'或':'且'}）`:r.type;
    return {id:r.id,source:r.source,target:r.target,type:r.type,directed:r.directed,memberIds:r.memberIds,kind:r.kind,points:points??[],label,...(!points?{unrouted:true as const}:{})};
  });
  return {themes,units:graph.nodes.map(n=>byId.get(n.id)!),edges};
}
