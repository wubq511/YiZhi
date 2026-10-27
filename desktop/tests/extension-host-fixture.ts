/** A real Electron host with NO Playwright/CDP attachment, used only on disposable courses.
 * Failure injection is at the generated DOM boundary; production recovery code is unchanged. */
import {app,BrowserWindow,dialog} from 'electron';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const output=process.env.YIZHI_RECOVERY_EVIDENCE!;
let loads=0,first:any,events=0,oldPid=0;
const diagnostics:any[]=[];
const finish=(value:unknown,code=0)=>{writeFileSync(output,JSON.stringify(value,null,2));app.exit(code);};
const deadline=setTimeout(()=>finish({error:'native recovery deadline',loads,events,diagnostics},1),45000);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
dialog.showMessageBox=async(...args:any[])=>{diagnostics.push({dialog:args.at(-1)});return {response:0,checkboxChecked:false};};
dialog.showErrorBox=(title,content)=>finish({error:title,content,loads,events,diagnostics},1);
app.on('browser-window-created',(_event,w:BrowserWindow)=>{
 const wc=w.webContents;wc.on('unresponsive',()=>{events++;diagnostics.push({unresponsive:true});});
 wc.on('render-process-gone',(_e,d)=>diagnostics.push({gone:d.reason}));
 wc.on('did-start-loading',()=>diagnostics.push({loading:true}));
 wc.on('did-fail-load',(_e,code,desc)=>diagnostics.push({loadFailed:code,desc}));
 wc.on('did-finish-load',()=>{void(async()=>{
  if(++loads===1){
   for(let i=0;i<100;i++){
    if(await wc.executeJavaScript(`!!document.querySelector('button[aria-label="数制与数制转换"]')`))break;
    await delay(100);if(i===99)throw Error('course UI not loaded');
   }
   await wc.executeJavaScript(`document.querySelector('button[aria-label="数制与数制转换"]').click()`);
   for(let i=0;i<100;i++){
    if(await wc.executeJavaScript(`!![...document.querySelectorAll('button')].find(x=>x.textContent==='奇偶校验扩展实验')`))break;
    await delay(100);if(i===99)throw Error('extension entry not loaded');
   }
   await wc.executeJavaScript(`(async()=>{const b=window.yizhi,c=await b.open();await b.save({sessionId:c.sessionId,operationId:'native-recovery-editor',inputSeq:1,baseRevision:c.revision,blockId:c.editableBlockId,text:'Persisted before native renderer failure.'});document.querySelectorAll('button').forEach(x=>{if(x.textContent==='奇偶校验扩展实验')x.click();});})()`);
   for(let i=0;i<100;i++){
    if(await wc.executeJavaScript(`document.querySelector('[aria-label="扩展保存状态"]')?.textContent==='现场已保存'`))break;
    await delay(100);if(i===99)throw Error('extension never became ready');
   }
   await wc.executeJavaScript(`document.querySelector('input[aria-label="C"]').click()`);
   for(let i=0;i<100;i++){
    first=await wc.executeJavaScript(`(async()=>{const b=window.yizhi,c=await b.open();return b.extensions.read({sessionId:c.sessionId});})()`);
    if(first.state.output===1)break;await delay(100);if(i===99)throw Error('input confirmation missing');
   }
   oldPid=wc.getOSProcessId();
   const frame=wc.mainFrame.frames.find(f=>f.url.startsWith('yizhi-extension:'))!;
   if(frame.processId!==wc.mainFrame.processId)throw Error('test requires shared renderer');
   void frame.executeJavaScript('while(true){}').catch(()=>{});
   // Actual input is now unanswered; no fake unresponsive event or product fault switch.
   wc.sendInputEvent({type:'mouseDown',x:400,y:300,button:'left',clickCount:1});
   wc.sendInputEvent({type:'mouseUp',x:400,y:300,button:'left',clickCount:1});
  }else if(loads===2){
   const restored=await wc.executeJavaScript(`(async()=>{const b=window.yizhi,c=await b.open(),v=await b.extensions.open({sessionId:c.sessionId});return {v,text:c.unit.reading.blocks.find(x=>x.id===c.editableBlockId).payload.text};})()`);
   clearTimeout(deadline);finish({events,loads,oldPid,newPid:wc.getOSProcessId(),diagnostics,before:first,after:restored.v,text:restored.text,runtime:process.versions});
  }
 })().catch(error=>finish({error:String(error),loads,events},1));});
});
require(join(__dirname,'../main.cjs'));
