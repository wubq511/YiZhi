import { ViewportPortal, type Viewport } from '@xyflow/react';
import { useMemo } from 'react';
import type { BoardRoute, BoardScene } from '../board-layout';
import { routeIntersectsViewport } from '../board-layout/visibility';

const meanings:Record<string,string>={requires:'前置',constructs:'构造',improves:'优化',inverse:'互逆'};
export function boardRouteLabel(route:BoardRoute) {
  const meaning=meanings[route.type]??route.type;
  if(route.kind==='theme')return route.memberIds.length>1?`${meaning} · ${route.memberIds.length}`:meaning;
  if(route.label.includes('（或）'))return `${meaning} · 或`;
  if(route.label.includes('（且）'))return `${meaning} · 且`;
  return meaning;
}
type Label={x:number;y:number;text:string};
type Rect={left:number;top:number;right:number;bottom:number};
const overlaps=(a:Rect,b:Rect)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;

/** Use the longest segment and keep labels out of content and other labels at this zoom. */
function labelsFor(routes:BoardRoute[],scene:BoardScene,viewport:Viewport):Map<string,Label> {
  const z=viewport.zoom, occupied:Rect[]=[], labels=new Map<string,Label>();
  const obstacles=scene.units.map(n=>({left:viewport.x+n.x*z,top:viewport.y+n.y*z,right:viewport.x+(n.x+n.width)*z,bottom:viewport.y+(n.y+n.height)*z}));
  for(const theme of scene.themes)obstacles.push({left:viewport.x+theme.x*z,top:viewport.y+theme.y*z-16,right:viewport.x+(theme.x+theme.width)*z,bottom:viewport.y+(theme.y+80)*z});
  for(const route of routes) {
    // Individual relations stay visible as lines in overview; selecting them
    // or entering the unit view reveals their complete meaning.
    if(route.kind==='internal')continue;
    let segment=0,length=-1;
    for(let i=1;i<route.points.length;i++) {const a=route.points[i-1],b=route.points[i],candidate=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);if(candidate>length){length=candidate;segment=i-1;}}
    if(length*z<36)continue;
    const a=route.points[segment],b=route.points[segment+1],x=(a.x+b.x)/2,y=(a.y+b.y)/2,text=boardRouteLabel(route);
    const sx=viewport.x+x*z,sy=viewport.y+y*z,width=Math.max(24,[...text].reduce((sum,c)=>sum+(/[^\x00-\x7f]/.test(c)?12:7),0));
    const rect={left:sx-width/2-3,right:sx+width/2+3,top:sy-20,bottom:sy-3};
    if(obstacles.some(item=>overlaps(rect,item))||occupied.some(item=>overlaps(rect,item)))continue;
    occupied.push(rect);labels.set(route.id,{x,y,text});
  }
  return labels;
}

/** The shared scene owns paths; viewport culling follows their actual geometry. */
export function BoardRoutes({scene,viewport,width,height,selectedUnitId,selectedThemeId,onActivate}:{scene:BoardScene|undefined;viewport:Viewport;width:number;height:number;selectedUnitId?:string;selectedThemeId?:string;onActivate(ids:string[],pointer:boolean):void}) {
  const routes=useMemo(()=>{
    if(!scene||width<=0||height<=0)return [];
    const margin=32/viewport.zoom, rect={left:-viewport.x/viewport.zoom-margin,top:-viewport.y/viewport.zoom-margin,
      right:(width-viewport.x)/viewport.zoom+margin,bottom:(height-viewport.y)/viewport.zoom+margin};
    return scene.edges.filter(route=>routeIntersectsViewport(route,rect));
  },[scene,viewport,width,height]);
  const labels=useMemo(()=>scene?labelsFor(routes,scene,viewport):new Map<string,Label>(),[routes,scene,viewport]);
  const themeByUnit=useMemo(()=>new Map(scene?.themes.flatMap(theme=>theme.units.map(unit=>[unit.unitId,theme.themeId] as const))??[]),[scene]);
  if(!scene)return null;
  const scale=1/viewport.zoom;
  return <ViewportPortal><svg className="board-route-layer" aria-label="知识关系">
    {routes.map(route=>{
      const points=route.points.map(point=>`${point.x},${point.y}`).join(' '),last=route.points.at(-1)!;
      const previous=[...route.points].reverse().find(point=>point.x!==last.x||point.y!==last.y);
      const angle=previous?Math.atan2(last.y-previous.y,last.x-previous.x)*180/Math.PI:0;
      const label=labels.get(route.id),name=boardRouteLabel(route);
      const related=selectedThemeId && (route.kind==='theme' ? route.source===selectedThemeId||route.target===selectedThemeId
        : route.kind==='internal' ? themeByUnit.get(route.source)===selectedThemeId : route.source===selectedUnitId||route.target===selectedUnitId);
      return <g key={route.id} className="react-flow__edge board-route-group" role="button" tabIndex={0}
        data-related={related?'':undefined}
        aria-label={`查看关系 ${name}，${route.memberIds.length} 条`}
        onClick={event=>{event.stopPropagation();onActivate(route.memberIds,event.detail>0);}}
        onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();onActivate(route.memberIds,false);}}}>
        <polyline className="board-route" data-kind={route.kind} data-members={JSON.stringify(route.memberIds)} points={points} vectorEffect="non-scaling-stroke" />
        <polyline className="board-route-hit" points={points} vectorEffect="non-scaling-stroke" />
        {route.directed&&previous&&<path className="board-route-arrow" d="M 0 0 L -9 -4 L -9 4 Z" transform={`translate(${last.x} ${last.y}) rotate(${angle}) scale(${scale})`} />}
        {label&&<g className="board-route-label" transform={`translate(${label.x} ${label.y}) scale(${scale})`}><text textAnchor="middle" y="-5">{label.text}</text></g>}
      </g>;
    })}
  </svg></ViewportPortal>;
}
