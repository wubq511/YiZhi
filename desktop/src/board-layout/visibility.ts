import type { BoardRoute } from './index';

export interface BoardViewportRect { left:number; top:number; right:number; bottom:number }

/** Route geometry, not the endpoint bounding box, determines whether a detour is visible. */
export function routeIntersectsViewport(route:Pick<BoardRoute,'points'> & Partial<Pick<BoardRoute,'kind'>>,rect:BoardViewportRect):boolean {
  for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1],b=route.points[i];
    if(a.x===b.x && a.x>=rect.left && a.x<=rect.right && Math.max(a.y,b.y)>=rect.top && Math.min(a.y,b.y)<=rect.bottom)return true;
    if(a.y===b.y && a.y>=rect.top && a.y<=rect.bottom && Math.max(a.x,b.x)>=rect.left && Math.min(a.x,b.x)<=rect.right)return true;
  }
  // A theme route may be drawn as a direct cubic inside the hull of its
  // obstacle-safe detour, even when none of that detour enters the viewport.
  if(route.kind==='theme'&&route.points.length>=2){
    const xs=route.points.map(p=>p.x),ys=route.points.map(p=>p.y);
    return Math.max(...xs)>=rect.left&&Math.min(...xs)<=rect.right&&Math.max(...ys)>=rect.top&&Math.min(...ys)<=rect.bottom;
  }
  return false;
}
