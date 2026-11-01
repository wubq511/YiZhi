export type StrokePoint={x:number;y:number};
export type StrokeObstacle={x:number;y:number;width:number;height:number};

const length=(a:StrokePoint,b:StrokePoint)=>Math.hypot(b.x-a.x,b.y-a.y);
const point=(a:StrokePoint,b:StrokePoint,t:number):StrokePoint=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const coordinate=(n:number)=>Number(n.toFixed(2));
const pair=(p:StrokePoint)=>`${coordinate(p.x)} ${coordinate(p.y)}`;
const blocked=(p:StrokePoint,obstacles:StrokeObstacle[])=>obstacles.some(r=>p.x>r.x-1.2&&p.x<r.x+r.width+1.2&&p.y>r.y-1.2&&p.y<r.y+r.height+1.2);
const segmentHits=(a:StrokePoint,b:StrokePoint,r:StrokeObstacle)=>{
  let low=0,high=1;
  for(const [start,delta,min,max] of [[a.x,b.x-a.x,r.x-1.2,r.x+r.width+1.2],[a.y,b.y-a.y,r.y-1.2,r.y+r.height+1.2]]) {
    if(delta===0){if(start<min||start>max)return false;continue;}
    const first=(min-start)/delta,last=(max-start)/delta;
    low=Math.max(low,Math.min(first,last));high=Math.min(high,Math.max(first,last));
    if(low>high)return false;
  }
  return true;
};
const clears=(points:StrokePoint[],obstacles:StrokeObstacle[])=>points.every((p,i)=>!blocked(p,obstacles)&&
  (i===0||!obstacles.some(rect=>segmentHits(points[i-1],p,rect))));

/** Disjoint rectangles for an even-odd clip, including overlapping legacy content. */
export function unionObstacles(rects:StrokeObstacle[]):StrokeObstacle[] {
  const valid=rects.filter(r=>r.width>0&&r.height>0);
  const xs=[...new Set(valid.flatMap(r=>[r.x,r.x+r.width]))].sort((a,b)=>a-b);
  const result:StrokeObstacle[]=[],previous=new Map<string,StrokeObstacle>();
  for(let i=1;i<xs.length;i++) {
    const left=xs[i-1],right=xs[i];if(left===right)continue;
    const intervals=valid.filter(r=>r.x<right&&r.x+r.width>left).map(r=>[r.y,r.y+r.height] as [number,number]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const merged:Array<[number,number]>=[];
    for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);}
    const current=new Map<string,StrokeObstacle>();
    for(const [top,bottom] of merged){
      const key=`${top},${bottom}`,old=previous.get(key);
      const rect=old&&old.x+old.width===left?old:{x:left,y:top,width:0,height:bottom-top};
      if(rect!==old)result.push(rect);
      rect.width+=right-left;current.set(key,rect);
    }
    previous.clear();for(const [key,rect] of current)previous.set(key,rect);
  }
  return result;
}
const distanceToSegment=(p:StrokePoint,a:StrokePoint,b:StrokePoint)=>{
  const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy;
  const t=d?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)):0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
};
const cubic=(a:StrokePoint,b:StrokePoint,c:StrokePoint,d:StrokePoint,t:number):StrokePoint=>{
  const u=1-t;
  return {x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,
    y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y};
};

/** Protect nearby routes from a decorative bend in screen coordinates. */
function avoidsRoutes(points:StrokePoint[],routes:StrokePoint[][]):boolean {
  const separation=4;
  for(const route of routes)for(let i=1;i<route.length;i++) {
    const a=route[i-1],b=route[i],left=Math.min(a.x,b.x)-separation,right=Math.max(a.x,b.x)+separation;
    const top=Math.min(a.y,b.y)-separation,bottom=Math.max(a.y,b.y)+separation;
    for(const p of points)if(p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom&&distanceToSegment(p,a,b)<separation)return false;
  }
  return true;
}

/** Use one continuous curve when it clears the content and other routes. */
export function directCurve(points:StrokePoint[],obstacles:StrokeObstacle[],foreign:StrokePoint[][]):{path:string;samples:StrokePoint[]}|undefined {
  if(points.length<2)return undefined;
  const a=points[0],b=points[points.length-1],next=points[1],previous=points[points.length-2];
  const dx=b.x-a.x;
  if(dx<30||Math.abs(b.y-a.y)<8||next.x<=a.x||b.x<=previous.x)return undefined;
  const c={x:a.x+dx*.45,y:a.y},d={x:b.x-dx*.45,y:b.y};
  const steps=Math.max(40,Math.min(256,Math.ceil((dx+Math.abs(b.y-a.y))/6)));
  const samples=Array.from({length:steps+1},(_,i)=>{
    const t=i/steps,u=1-t;
    return {x:u*u*u*a.x+3*u*u*t*c.x+3*u*t*t*d.x+t*t*t*b.x,y:u*u*u*a.y+3*u*u*t*c.y+3*u*t*t*d.y+t*t*t*b.y};
  });
  if(!clears(samples.slice(1,-1),obstacles))return undefined;
  for(const p of samples.slice(1,-1)) {
    if(length(p,a)<8||length(p,b)<8)continue;
    for(const route of foreign)for(let i=1;i<route.length;i++)if(distanceToSegment(p,route[i-1],route[i])<4)return undefined;
  }
  return {path:`M ${pair(a)} C ${pair(c)} ${pair(d)} ${pair(b)}`,samples};
}

/** Turn an obstacle-safe route into a soft line in screen units. The candidate
 * curves are sampled against obstacles; tight corners stay on the safe route. */
export function organicRoute(points:StrokePoint[],obstacles:StrokeObstacle[],seed:number,foreign:StrokePoint[][]=[]):{path:string;samples:StrokePoint[]} {
  if(points.length<2)return {path:'',samples:points};
  let result=`M ${pair(points[0])}`,current=points[0];
  const samples:StrokePoint[]=[current];
  const segment=(end:StrokePoint,index:number)=>{
    const start=current,dist=length(start,end);
    if(dist<28){result+=` L ${pair(end)}`;current=end;samples.push(end);return;}
    const normal={x:-(end.y-start.y)/dist,y:(end.x-start.x)/dist};
    const magnitude=Math.min(4,Math.max(2,dist*.04));
    const sign=((seed+index)%2===0?1:-1);
    const curve=(amount:number)=>{
      const offset=(p:StrokePoint)=>({x:p.x+normal.x*amount,y:p.y+normal.y*amount});
      const c1=point(start,end,1/6),c2=offset(point(start,end,1/3)),middle=offset(point(start,end,.5));
      const c3=offset(point(start,end,2/3)),c4=point(start,end,5/6);
      const steps=Math.max(12,Math.min(256,Math.ceil(dist/6)));
      const sampled=Array.from({length:steps+1},(_,i)=>{
        const t=i/steps;
        return t<=.5?cubic(start,c1,c2,middle,t*2):cubic(middle,c3,c4,end,t*2-1);
      });
      return {c1,c2,middle,c3,c4,sampled};
    };
    let chosen:ReturnType<typeof curve>|undefined;
    for(const candidate of [sign*magnitude,-sign*magnitude]) {
      const path=curve(candidate),inside=path.sampled.slice(1,-1);
      if(clears(inside,obstacles)&&avoidsRoutes(inside,foreign)){chosen=path;break;}
    }
    if(!chosen){result+=` L ${pair(end)}`;current=end;samples.push(end);return;}
    result+=` C ${pair(chosen.c1)} ${pair(chosen.c2)} ${pair(chosen.middle)}`;
    result+=` C ${pair(chosen.c3)} ${pair(chosen.c4)} ${pair(end)}`;
    samples.push(...chosen.sampled.slice(1));
    current=end;
  };
  for(let i=1;i<points.length-1;i++) {
    const before=points[i-1],corner=points[i],after=points[i+1],a=length(before,corner),b=length(corner,after);
    if(!a||!b)continue;
    let radius=Math.min(24,a/3,b/3),entry=corner,exit=corner;
    while(radius>=.75) {
      entry=point(corner,before,radius/a);exit=point(corner,after,radius/b);
      const arc=Array.from({length:11},(_,j)=>{const t=j/10,u=1-t;return {x:u*u*entry.x+2*u*t*corner.x+t*t*exit.x,y:u*u*entry.y+2*u*t*corner.y+t*t*exit.y};});
      const safe=clears(arc,obstacles)&&avoidsRoutes(arc.slice(1,-1),foreign);
      if(safe)break;
      radius/=2;
    }
    if(radius<.75){segment(corner,i);continue;}
    segment(entry,i);result+=` Q ${pair(corner)} ${pair(exit)}`;
    for(let j=1;j<=10;j++){const t=j/10,u=1-t;samples.push({x:u*u*entry.x+2*u*t*corner.x+t*t*exit.x,y:u*u*entry.y+2*u*t*corner.y+t*t*exit.y});}
    current=exit;
  }
  segment(points[points.length-1],points.length);
  return {path:result,samples};
}
