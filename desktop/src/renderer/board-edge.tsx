import { ViewportPortal, type Viewport } from '@xyflow/react';
import { useId, useMemo, useRef } from 'react';
import rough from 'roughjs';
import { themeTitleSpace, themeTitleWidth, type BoardRoute, type BoardScene } from '../board-layout';
import { routeIntersectsViewport } from '../board-layout/visibility';
import { directCurve, organicRoute, unionObstacles, type StrokeObstacle } from './board-stroke';
import { observation } from '../acceptance-observation';

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
const touchesSegment=(rect:Rect,a:Point,b:Point,pad=5)=>{
  return Math.max(a.x,b.x)>rect.left-pad&&Math.min(a.x,b.x)<rect.right+pad&&
    Math.max(a.y,b.y)>rect.top-pad&&Math.min(a.y,b.y)<rect.bottom+pad;
};

const generator=rough.generator();
type Point={x:number;y:number};
type End={point:Point;angle:number;room:number};
type RouteInk={start?:End;end?:End;marks:string[]};
type StrokeDrawing={ink:string[];path:string;direct:boolean;samples?:Point[]};
const routeSeed=(id:string)=>[...id].reduce((n,c)=>(Math.imul(n,31)+c.charCodeAt(0))>>>0,1)%2147483646+1;

// Keep each symbol on its actual terminal segment and shrink it when the
// segment is shorter than its normal screen-sized mark.
function endpoint(point:Point,neighbor:Point):End {
  const dx=point.x-neighbor.x,dy=point.y-neighbor.y;
  return {point,angle:Math.atan2(dy,dx)*180/Math.PI,room:Math.hypot(dx,dy)/10};
}

function makeInk(route:BoardRoute):RouteInk {
  const points=route.points,first=points[0],last=points.at(-1);
  if(!first||!last)return {marks:[]};
  const next=points.find(p=>p.x!==first.x||p.y!==first.y);
  const previous=[...points].reverse().find(p=>p.x!==last.x||p.y!==last.y);
  if(!next||!previous)return {marks:[]};
  const seed=routeSeed(route.id);
  const options={seed,roughness:.55,maxRandomnessOffset:.3,disableMultiStroke:true,preserveVertices:true};
  const shape=route.type==='inverse'&&!route.directed
    ? generator.ellipse(-4.5,0,5,5,options)
    : route.type==='constructs' ? generator.path('M -9 -3.5 L -1.5 0 L -9 3.5',options)
    : route.type==='improves' ? generator.path('M -9 -3.5 L -3 0 L -9 3.5 M -6.5 -3.5 L -1.5 0 L -6.5 3.5',options)
    : generator.path('M -9 -3.5 L -1.5 0 L -9 3.5 Z',options);
  return {start:endpoint(first,next),end:endpoint(last,previous),marks:generator.toPaths(shape).map(path=>path.d)};
}

/** Place labels along the visible curve, clear of content, ink and other labels. */
function labelsFor(routes:BoardRoute[],scene:BoardScene,viewport:Viewport,drawings:Map<string,StrokeDrawing>):Map<string,Label> {
  const z=viewport.zoom, occupied:Rect[]=[], labels=new Map<string,Label>();
  const obstacles=scene.units.map(n=>({left:viewport.x+n.x*z,top:viewport.y+n.y*z,right:viewport.x+(n.x+n.width)*z,bottom:viewport.y+(n.y+n.height)*z}));
  for(const theme of scene.themes)obstacles.push({left:viewport.x+theme.x*z,top:viewport.y+(theme.y-themeTitleSpace(theme,scene.themes))*z,right:viewport.x+(theme.x+themeTitleWidth(theme,scene.themes))*z,bottom:viewport.y+(theme.y+80)*z});
  const paths=new Map(routes.map(route=>[route.id,(drawings.get(route.id)?.samples??route.points.map(p=>({x:p.x*z,y:p.y*z})))
    .map(p=>({x:viewport.x+p.x,y:viewport.y+p.y}))]));
  for(const route of routes) {
    // Individual relations stay visible as lines in overview; selecting them
    // or entering the unit view reveals their complete meaning.
    if(route.kind==='internal')continue;
    const points=paths.get(route.id)!,distances=[0];
    for(let i=1;i<points.length;i++)distances.push(distances[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
    const length=distances.at(-1)??0;if(length<100)continue;
    const text=boardRouteLabel(route),width=Math.max(24,[...text].reduce((sum,c)=>sum+(/[^\x00-\x7f]/.test(c)?12:7),0));
    for(const fraction of [.5,.4,.6,.3,.7]) {
      const distance=length*fraction,index=distances.findIndex(d=>d>=distance),a=points[index-1],b=points[index];
      const t=(distance-distances[index-1])/(distances[index]-distances[index-1]);
      const sx=a.x+(b.x-a.x)*t,sy=a.y+(b.y-a.y)*t;
      const rect={left:sx-width/2-3,right:sx+width/2+3,top:sy-20,bottom:sy-4};
      if(obstacles.some(item=>overlaps(rect,item))||occupied.some(item=>overlaps(rect,item)))continue;
      if([...paths].some(([id,path])=>path.slice(1).some((p,i)=>touchesSegment(rect,path[i],p,id===route.id?1.5:5))))continue;
      occupied.push(rect);labels.set(route.id,{x:(sx-viewport.x)/z,y:(sy-viewport.y)/z,text});break;
    }
  }
  return labels;
}

/** The shared scene owns paths; viewport culling follows their actual geometry. */
export function BoardRoutes({scene,viewport,width,height,selectedUnitId,selectedThemeId,onActivate}:{scene:BoardScene|undefined;viewport:Viewport;width:number;height:number;selectedUnitId?:string;selectedThemeId?:string;onActivate(ids:string[],pointer:boolean):void}) {
  const maskId=useId();
  const visibleMask=useMemo(()=>{
    if(!scene||width<=0||height<=0)return '';
    const margin=32/viewport.zoom, rect={left:-viewport.x/viewport.zoom-margin,top:-viewport.y/viewport.zoom-margin,
      right:(width-viewport.x)/viewport.zoom+margin,bottom:(height-viewport.y)/viewport.zoom+margin};
    return scene.edges.map(route=>routeIntersectsViewport(route,rect)?'1':'0').join('');
  },[scene,viewport,width,height]);
  // A camera translation often leaves the same scene-owned routes visible.
  // Keep that set stable so their ink and label placement can be reused.
  const routes=useMemo(()=>scene?.edges.filter((_,index)=>visibleMask[index]==='1')??[],[scene,visibleMask]);
  const themeByUnit=useMemo(()=>new Map(scene?.themes.flatMap(theme=>theme.units.map(unit=>[unit.unitId,theme.themeId] as const))??[]),[scene]);
  const ink=useMemo(()=>{
    if(!scene)return new Map<string,RouteInk>();
    return new Map(scene.edges.map(route=>[route.id,makeInk(route)]));
  },[scene]);
  const obstacles=useMemo(()=>{
    if(!scene)return [];
    return [
      ...scene.units.map(unit=>({x:unit.x,y:unit.y,width:unit.width,height:unit.height})),
      ...scene.themes.map(theme=>{const title=themeTitleSpace(theme,scene.themes);return {x:theme.x,y:theme.y-title,width:themeTitleWidth(theme,scene.themes),height:title+80};}),
    ];
  },[scene]);
  const clipPath=useMemo(()=>{
    if(!scene)return '';
    const points=scene.edges.flatMap(route=>route.points);
    if(!points.length)return '';
    const margin=32/viewport.zoom,left=Math.min(...points.map(p=>p.x))-margin,right=Math.max(...points.map(p=>p.x))+margin;
    const top=Math.min(...points.map(p=>p.y))-margin,bottom=Math.max(...points.map(p=>p.y))+margin;
    const rectangle=(r:{x:number;y:number;width:number;height:number})=>`M ${r.x} ${r.y} h ${r.width} v ${r.height} h ${-r.width} Z`;
    const holes=unionObstacles(obstacles.filter(r=>r.x<right&&r.x+r.width>left&&r.y<bottom&&r.y+r.height>top));
    return [rectangle({x:left,y:top,width:right-left,height:bottom-top}),...holes.map(rectangle)].join(' ');
  },[scene,obstacles,viewport.zoom]);
  const strokeCache=useRef<{scene?:BoardScene;zoom:number;paths:Map<string,StrokeDrawing>}>({zoom:0,paths:new Map()});
  const strokes=useMemo(()=>{
    if(!scene)return new Map<string,StrokeDrawing>();
    if(strokeCache.current.scene!==scene||strokeCache.current.zoom!==viewport.zoom)
      strokeCache.current={scene,zoom:viewport.zoom,paths:new Map()};
    const cache=strokeCache.current.paths,z=viewport.zoom;
    const scaled=(r:{x:number;y:number;width:number;height:number}):StrokeObstacle=>({x:r.x*z,y:r.y*z,width:r.width*z,height:r.height*z});
    const headers=scene.themes.map(theme=>({id:theme.themeId,rect:scaled({x:theme.x,y:theme.y-themeTitleSpace(theme,scene.themes),width:themeTitleWidth(theme,scene.themes),height:themeTitleSpace(theme,scene.themes)+80})}));
    const draw=(route:BoardRoute)=>{
      let drawing=cache.get(route.id);
      if(!drawing) {
        const points=route.points.map(p=>({x:p.x*z,y:p.y*z}));
        const a=route.kind==='theme'?route.source:themeByUnit.get(route.source),b=route.kind==='theme'?route.target:themeByUnit.get(route.target);
        const candidates=[
          ...headers.map(header=>header.rect),
          ...scene.themes.filter(theme=>theme.themeId!==a&&theme.themeId!==b).map(scaled),
          ...(route.kind==='theme'?[]:scene.units.filter(unit=>unit.unitId!==route.source&&unit.unitId!==route.target).map(scaled)),
        ];
        const left=Math.min(...points.map(p=>p.x))-28,right=Math.max(...points.map(p=>p.x))+28;
        const top=Math.min(...points.map(p=>p.y))-28,bottom=Math.max(...points.map(p=>p.y))+28;
        const nearby=candidates.filter(r=>r.x<right&&r.x+r.width>left&&r.y<bottom&&r.y+r.height>top);
        const nearbyRoute=(path:Point[])=>{
          let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
          for(const p of path){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
          return minX<right&&maxX>left&&minY<bottom&&maxY>top;
        };
        const foreign=route.kind==='theme'?scene.edges.filter(other=>other.id!==route.id&&other.points.length>=2)
          .map(other=>other.points.map(p=>({x:p.x*z,y:p.y*z}))).filter(nearbyRoute):[];
        if(route.kind==='theme')for(const [id,other] of cache)if(id!==route.id&&other.samples&&nearbyRoute(other.samples))foreign.push(other.samples);
        const direct=route.kind==='theme'?directCurve(points,nearby,foreign):undefined;
        const seed=routeSeed(route.id),organic=direct?undefined:organicRoute(points,nearby,seed,foreign);
        const path=direct?.path??organic!.path;
        const shape=generator.path(path,{seed,roughness:.65,bowing:.7,maxRandomnessOffset:.45,preserveVertices:true,disableMultiStroke:true});
        drawing={ink:generator.toPaths(shape).map(item=>item.d),path,direct:!!direct,
          samples:direct?.samples??organic?.samples};cache.set(route.id,drawing);
      }
      return drawing;
    };
    // Resolve overview curves in graph order even when panning reveals routes
    // in another order; their geometry must not change as they enter view.
    for(const route of scene.edges)if(route.kind==='theme'&&route.points.length>=2)draw(route);
    return new Map(routes.map(route=>[route.id,draw(route)] as const));
  },[routes,scene,themeByUnit,viewport.zoom]);
  const labels=useMemo(()=>{
    if(!scene)return new Map<string,Label>();
    // All label candidates and obstacles translate together; calculate in a
    // screen-scaled origin and let the viewport translate the result.
    const result=labelsFor(routes,scene,{x:0,y:0,zoom:viewport.zoom},strokes);
    observation.count('board.labelLayouts');
    return result;
  },[routes,scene,viewport.zoom,strokes]);
  if(!scene)return null;
  const scale=1/viewport.zoom;
  return <ViewportPortal><svg className="board-route-layer" aria-label="知识关系">
    <defs><clipPath id={maskId} clipPathUnits="userSpaceOnUse"><path d={clipPath} fillRule="evenodd" clipRule="evenodd" /></clipPath></defs>
    {routes.map((route,index)=>{
      const points=route.points.map(point=>`${point.x},${point.y}`).join(' '),drawing=ink.get(route.id);
      const inverse=route.type==='inverse'&&!route.directed;
      const markScale=drawing?.start&&drawing.end ? Math.min(scale,inverse?Math.min(drawing.start.room,drawing.end.room):drawing.end.room) : 0;
      const mark=(end:End,side:string)=>{const clipId=`${maskId}-${index}-${side}`,length=end.room*10/markScale;return <g key={side} className="board-route-arrow" data-side={side}
        transform={`translate(${end.point.x} ${end.point.y}) rotate(${end.angle}) scale(${markScale})`}>
        <defs><clipPath id={clipId}><rect x={-length} y="-20" width={length} height="40" /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
        {inverse&&<circle className="board-route-arrow-paper" cx="-4.5" cy="0" r="2.5" />}
        {route.directed&&route.type!=='constructs'&&route.type!=='improves'&&<path className="board-route-arrow-fill" d="M -9 -3.5 L -1.5 0 L -9 3.5 Z" />}
        {drawing?.marks.map((path,i)=><path key={i} d={path} />)}
        </g>
      </g>;};
      const stroke=strokes.get(route.id),label=labels.get(route.id),name=boardRouteLabel(route);
      const related=selectedThemeId && (route.kind==='theme' ? route.source===selectedThemeId||route.target===selectedThemeId
        : route.kind==='internal' ? themeByUnit.get(route.source)===selectedThemeId : route.source===selectedUnitId||route.target===selectedUnitId);
      return <g key={route.id} className="react-flow__edge board-route-group" role="button" tabIndex={0}
        data-related={related?'':undefined}
        aria-label={`查看关系 ${name}，${route.memberIds.length} 条`}
        onClick={event=>{event.stopPropagation();onActivate(route.memberIds,event.detail>0);}}
        onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();onActivate(route.memberIds,false);}}}>
        <polyline className="board-route" data-kind={route.kind} data-type={route.type} data-directed={route.directed} data-members={JSON.stringify(route.memberIds)} points={points} vectorEffect="non-scaling-stroke" />
        <g clipPath={`url(#${maskId})`}>
          {(stroke?.ink??[]).map((path,i)=><path key={i} className="board-route-ink" data-type={route.type} data-curve={stroke?.direct?'direct':'routed'} d={path} transform={`scale(${scale})`} />)}
          {markScale>0&&drawing?.end&&(route.directed||inverse)&&mark(drawing.end,'target')}
          {markScale>0&&inverse&&drawing?.start&&mark(drawing.start,'source')}
        </g>
        {stroke&&<path className="board-route-hit" d={stroke.path} transform={`scale(${scale})`} />}
        {label&&<g className="board-route-label" transform={`translate(${label.x} ${label.y}) scale(${scale})`}><text textAnchor="middle" y="-5">{label.text}</text></g>}
      </g>;
    })}
  </svg></ViewportPortal>;
}
