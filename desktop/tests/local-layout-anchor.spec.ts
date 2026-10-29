import { test,expect,_electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

test('late upstream measurements compensate a measured reading body but never an unread placeholder',async()=>{
 const root=await mkdtemp(join(tmpdir(),'yizhi-measured-anchor-'));
 try{
  await build({stdin:{contents:`
   import {useRef,useState} from 'react';
   import {createRoot} from 'react-dom/client';
   import {useLocalLayout,ReadingSurface} from './src/renderer/local-layout';
   const graph={layout:{nodes:[
    {unitId:'UPSTREAM',x:0,y:0,width:650,height:100},
    {unitId:'ANCHOR',x:0,y:200,width:268,height:86}
   ]}};
   window.moves=[];
   const camera={compensate(dx,dy){window.moves.push({dx,dy});}};
   function App(){
    const [height,setHeight]=useState(200),[loaded,setLoaded]=useState(false),article=useRef(null);
    const local=useLocalLayout(graph,'ANCHOR',camera,true,true,'ANCHOR');
    window.placements=local.placements;
    window.waitMeasurements=ids=>local.waitForMeasurements(ids);
    return <>
     <div style={{position:'fixed',right:0,top:0,zIndex:1}}>
      <button onClick={()=>setHeight(value=>value+200)}>Grow upstream</button>
      <button onClick={()=>setLoaded(true)}>Load anchor body</button>
     </div>
     {local.placements.filter(node=>node.unitId==='UPSTREAM'||loaded).map(position=><div key={position.unitId}
      style={{position:'absolute',left:position.x,top:position.y}}>
      <ReadingSurface id={position.unitId} name={position.unitId} position={position} baseline={position}
       active={false} articleRef={article} measure={local.measure} gesture={local.gesture} commit={()=>{}} takeover={()=>{}}>
       <p style={{height:position.unitId==='UPSTREAM'?height:100}}>Actual loaded reading body</p>
      </ReadingSurface>
     </div>)}
    </>;
   }
   createRoot(document.getElementById('root')).render(<App/>);
  `,resolveDir:resolve('.'),loader:'tsx'},outfile:join(root,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
   define:{'process.env.NODE_ENV':'"production"'}});
  await writeFile(join(root,'index.html'),'<!doctype html><div id="root"></div><script src="app.js"></script>');
  await writeFile(join(root,'host.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{
   const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});window.loadFile(${JSON.stringify(join(root,'index.html'))});
  });`);
  const app=await electron.launch({args:[join(root,'host.cjs')]});
  try{
   const page=await app.firstWindow();
   const anchor=()=>page.evaluate(()=>(window as any).placements.find((node:any)=>node.unitId==='ANCHOR'));
   await page.waitForFunction(()=>typeof (window as any).waitMeasurements==='function');
   await page.evaluate(()=>(window as any).waitMeasurements(['UPSTREAM']));
   expect((await anchor()).y).toBeGreaterThan(200);
   expect(await page.evaluate(()=>(window as any).moves)).toEqual([]);
   const beforeUnread=await anchor();
   await page.getByRole('button',{name:'Grow upstream'}).click();
   await expect.poll(async()=>(await anchor()).y).toBeGreaterThan(beforeUnread.y);
   await page.evaluate(()=>(window as any).waitMeasurements(['UPSTREAM']));
   expect(await page.evaluate(()=>(window as any).moves)).toEqual([]);
   await page.getByRole('button',{name:'Load anchor body'}).click();
   await page.evaluate(()=>(window as any).waitMeasurements(['UPSTREAM','ANCHOR']));
   expect((await anchor()).height).toBeGreaterThan(86);
   expect(await page.evaluate(()=>(window as any).moves)).toEqual([]);
   const beforeMeasured=await anchor();
   await page.getByRole('button',{name:'Grow upstream'}).click();
   await expect.poll(async()=>(await anchor()).y).toBeGreaterThan(beforeMeasured.y);
   await page.evaluate(()=>(window as any).waitMeasurements(['UPSTREAM','ANCHOR']));
   const after=await anchor(),moves=await page.evaluate(()=>(window as any).moves);
   expect(moves.length).toBeGreaterThan(0);
   expect(moves.reduce((total:number,item:{dx:number})=>total+item.dx,0)).toBe(0);
   expect(moves.reduce((total:number,item:{dy:number})=>total+item.dy,0)).toBe(after.y-beforeMeasured.y);
  }finally{await app.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
