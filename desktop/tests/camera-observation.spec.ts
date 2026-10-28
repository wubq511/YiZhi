import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {readCameraTransform} from './board-test-helpers';

test('the browser camera observation retains precision through a stable CSS transform with large fractional coordinates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-camera-observation-')),app=await electron.launch({args:[resolve('.'),`--course=${join(root,'course')}`],env:{...process.env,YIZHI_DATA_HOME:join(root,'profile'),YIZHI_CODEX_PATH:join(root,'not-used')}});
 try{
  const page=await app.firstWindow(),result=await page.evaluate(async()=>{
   const el=document.createElement('div'),raw={x:14.95123456789,y:-1007.0391288795561,zoom:0.85123456789};el.id='camera-observation';el.style.transform=`translate(${raw.x}px,${raw.y}px) scale(${raw.zoom})`;document.body.append(el);
   const samples=[];for(let i=0;i<3;i++){await new Promise<void>(r=>requestAnimationFrame(()=>r()));const m=new DOMMatrixReadOnly(el.style.transform),typed=(el as any).attributeStyleMap.get('transform'),t=typed.toMatrix();samples.push({inline:el.style.transform,cssom:{x:m.e,y:m.f,zoom:m.a},typed:{x:t.e,y:t.f,zoom:t.a},components:[...typed].map((v:any)=>({name:v.constructor.name,x:v.x?.value,y:v.y?.value}))});}return {raw,samples};
  });
  await writeFile(test.info().outputPath('camera-precision.json'),JSON.stringify(result,null,2));
  // This would fail with the original inline-string/DOMMatrix observation by
  // exactly the hosted difference, regardless of how many paint frames elapse.
  const observations=[];for(let i=0;i<3;i++){await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));observations.push(await readCameraTransform(page.locator('#camera-observation')));}
  for(const actual of observations){expect(actual.x).toBeCloseTo(result.raw.x,3);expect(actual.y).toBeCloseTo(result.raw.y,3);expect(actual.zoom).toBeCloseTo(result.raw.zoom,6);expect(actual).toEqual(result.raw);}
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
