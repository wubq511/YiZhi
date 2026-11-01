import type { BoardRoute } from './index';

export interface BoardViewportRect { left:number; top:number; right:number; bottom:number }

/** Route geometry, not the endpoint bounding box, determines whether a detour is visible. */
export function routeIntersectsViewport(route:Pick<BoardRoute,'points'>,rect:BoardViewportRect):boolean {
  for(let i=1;i<route.points.length;i++) {
    const a=route.points[i-1],b=route.points[i];
    if(a.x===b.x && a.x>=rect.left && a.x<=rect.right && Math.max(a.y,b.y)>=rect.top && Math.min(a.y,b.y)<=rect.bottom)return true;
    if(a.y===b.y && a.y>=rect.top && a.y<=rect.bottom && Math.max(a.x,b.x)>=rect.left && Math.min(a.x,b.x)<=rect.right)return true;
  }
  return false;
}
