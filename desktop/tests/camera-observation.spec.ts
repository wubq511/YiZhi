import {test,expect,_electron as electron} from '@playwright/test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readCameraTransform} from './board-test-helpers';

test('the browser camera observation retains precision through a stable CSS transform with large fractional coordinates',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-camera-observation-')),host=join(root,'camera-host.cjs');
 // This regression observes browser CSS numeric representations. Use the same
 // locked Electron engine without unrelated course startup/quit barriers.
 await writeFile(host,`const {app,BrowserWindow}=require('electron');
 app.setPath('userData',${JSON.stringify(join(root,'profile'))});
 app.whenReady().then(()=>new BrowserWindow({width:1024,height:600,webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadURL('data:text/html,<title>Camera observation</title><body></body>'));
 app.on('window-all-closed',()=>app.quit());`);
 const app=await electron.launch({args:[host]});
 try{
  const page=await app.firstWindow();await expect(page).toHaveTitle('Camera observation');
  const result=await page.evaluate(async()=>{
   const el=document.createElement('div'),raw={x:14.95123456789,y:-1007.0391288795561,zoom:0.85123456789};el.id='camera-observation';el.style.transform=`translate(${raw.x}px,${raw.y}px) scale(${raw.zoom})`;document.body.append(el);
   const samples=[];for(let i=0;i<3;i++){await new Promise<void>(r=>requestAnimationFrame(()=>r()));const m=new DOMMatrixReadOnly(el.style.transform),typed=(el as any).attributeStyleMap.get('transform'),t=typed.toMatrix();samples.push({inline:el.style.transform,cssom:{x:m.e,y:m.f,zoom:m.a},typed:{x:t.e,y:t.f,zoom:t.a},components:[...typed].map((v:any)=>({name:v.constructor.name,x:v.x?.value,y:v.y?.value}))});}return {raw,samples};
  });
  await writeFile(test.info().outputPath('camera-precision.json'),JSON.stringify(result,null,2));
  // This would fail with the original inline-string/DOMMatrix observation by
  // exactly the hosted difference, regardless of how many paint frames elapse.
  const observations=[];for(let i=0;i<3;i++){await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>r())));observations.push(await readCameraTransform(page.locator('#camera-observation')));}
  for(const actual of observations){expect(actual.x).toBeCloseTo(result.raw.x,3);expect(actual.y).toBeCloseTo(result.raw.y,3);expect(actual.zoom).toBeCloseTo(result.raw.zoom,6);expect(actual).toEqual(result.raw);}
 }finally{
  let forced=false;const timer=setTimeout(()=>{forced=true;app.process().kill('SIGKILL');},5000);
  try{await app.close();expect(forced,'the isolated CSS observation host must close normally').toBe(false);}
  finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});}
 }
});
