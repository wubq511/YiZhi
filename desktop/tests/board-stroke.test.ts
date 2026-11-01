import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directCurve } from '../src/renderer/board-stroke';

test('a long curved relation does not skip a narrow obstacle or another line',()=>{
  const points=[{x:0,y:0},{x:100,y:0},{x:100,y:80},{x:1000,y:80}];
  assert.ok(directCurve(points,[],[]));
  const t=.5125,u=1-t;
  const x=3*u*u*t*450+3*u*t*t*550+t*t*t*1000;
  const y=3*u*t*t*80+t*t*t*80;
  assert.equal(directCurve(points,[{x:x-.5,y:y-.5,width:1,height:1}],[]),undefined);
  assert.equal(directCurve(points,[],[[{x:x-1,y:y-1},{x:x+1,y:y+1}]]),undefined);
});
