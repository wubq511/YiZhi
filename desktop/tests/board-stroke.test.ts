import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directCurve, organicRoute, type StrokePoint } from '../src/renderer/board-stroke';

test('a shallow lane change flows continuously instead of making a tiny right-angle step',()=>{
  const route=[{x:0,y:100},{x:32,y:100},{x:32,y:98},{x:260,y:98}];
  for(const transform of [
    (p:StrokePoint)=>p,
    (p:StrokePoint)=>({x:p.y,y:p.x}),
    (p:StrokePoint)=>({x:-p.x,y:p.y}),
  ]) {
    const points=route.map(transform),stroke=organicRoute(points,[],1);
    const forward=transform({x:1,y:0}),origin=transform({x:0,y:0});
    const direction={x:forward.x-origin.x,y:forward.y-origin.y};
    for(let i=1;i<stroke.samples.length;i++) {
      const dx=stroke.samples[i].x-stroke.samples[i-1].x,dy=stroke.samples[i].y-stroke.samples[i-1].y;
      if(Math.hypot(dx,dy)<.001)continue;
      const angle=Math.atan2(Math.abs(dx*direction.y-dy*direction.x),dx*direction.x+dy*direction.y);
      assert.ok(angle<Math.PI/9,`a 2px lane change should stay below 20 degrees, got ${angle*180/Math.PI}`);
    }
    assert.deepEqual(stroke.samples[0],points[0]);
    assert.deepEqual(stroke.samples.at(-1),points.at(-1));
  }
  assert.ok(directCurve(route,[],[]),'a shallow clear corridor is eligible for a continuous curve');
});

test('smoothing a lane change still goes around a nearby content corner',()=>{
  const points=[{x:0,y:100},{x:80,y:100},{x:80,y:112},{x:260,y:112}];
  const obstacle={x:90,y:80,width:80,height:26};
  const stroke=organicRoute(points,[obstacle],5);
  for(const p of stroke.samples)assert.ok(!(p.x>obstacle.x&&p.x<obstacle.x+obstacle.width&&p.y>obstacle.y&&p.y<obstacle.y+obstacle.height));
  assert.deepEqual(stroke,organicRoute(points,[obstacle],5),'the same route keeps the same hand-drawn shape');
});

test('a long curved relation does not skip a narrow obstacle or another line',()=>{
  const points=[{x:0,y:0},{x:100,y:0},{x:100,y:80},{x:1000,y:80}];
  assert.ok(directCurve(points,[],[]));
  const t=.5125,u=1-t;
  const x=3*u*u*t*450+3*u*t*t*550+t*t*t*1000;
  const y=3*u*t*t*80+t*t*t*80;
  assert.equal(directCurve(points,[{x:x-.5,y:y-.5,width:1,height:1}],[]),undefined);
  assert.equal(directCurve(points,[],[[{x:x-1,y:y-1},{x:x+1,y:y+1}]]),undefined);
});

test('a long shallow curve cannot jump across a short neighbouring route between samples',()=>{
  const points=[{x:0,y:0},{x:100,y:0},{x:100,y:6},{x:3000,y:6}];
  assert.ok(directCurve(points,[],[]));
  assert.equal(directCurve(points,[],[[{x:1505,y:1},{x:1505,y:5}]]),undefined);
});
