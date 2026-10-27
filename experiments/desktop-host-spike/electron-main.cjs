const { app, BrowserWindow, ipcMain, screen, utilityProcess } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root=__dirname, temp=process.env.SPIKE_TEMP, url=process.env.SPIKE_URL;
app.setPath('userData',path.join(temp,'electron-userData'));
app.setPath('sessionData',path.join(temp,'electron-sessionData'));
app.setPath('logs',path.join(temp,'electron-logs'));
const out={capturedAt:new Date().toISOString(),versions:process.versions,checks:[],windows:[],console:[],events:[],
  configuration:{show:true,headless:false,backgroundThrottling:false,explicitAppAndWebContentsFocus:true,contextIsolation:true,nodeIntegration:false,sandbox:true,freshUserData:true}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,pass,evidence)=>out.checks.push({name,pass:Boolean(pass),evidence});
let task=null,worker,starts=0,win,exiting=false;
const guard=setTimeout(()=>{out.failure='Host 70s timeout';app.quit();},70000);
function status() {return {...task,workerPid:worker?.pid,starts};}
ipcMain.handle('spike:task-status',event=>{
  if (!win || event.sender!==win.webContents || event.senderFrame.url!==url) throw new Error('Unexpected sender');
  return status();
});
app.on('window-all-closed',()=>out.events.push({event:'window-all-closed',at:new Date().toISOString(),windows:BrowserWindow.getAllWindows().length}));
async function openWindow(label) {
  win=new BrowserWindow({title:'Desktop host spike — isolated experiment',width:1440,height:1000,useContentSize:true,show:true,
    webPreferences:{preload:path.join(root,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,target)=>{if(target!==url) event.preventDefault();});
  win.webContents.on('console-message',event=>out.console.push({level:event.level,message:event.message}));
  win.webContents.on('render-process-gone',(_event,details)=>out.events.push({event:'render-process-gone',details}));
  await win.loadURL(url);app.focus({steal:true});win.show();win.focus();win.webContents.focus();
  out.windows.push({label,id:win.id,visible:win.isVisible(),focused:win.isFocused(),bounds:win.getBounds(),
    contentBounds:win.getContentBounds(),webContentsFocused:win.webContents.isFocused(),userAgent:win.webContents.getUserAgent(),backgroundThrottling:win.webContents.getBackgroundThrottling()});
  return win;
}
app.whenReady().then(async()=>{
  out.display=screen.getPrimaryDisplay();
  try {
    out.nodeCapabilities={main:require('./sqlite-capability.cjs')()};
    // A bounded capability-only utility, separate from the ongoing deterministic task.
    try {
      const utility=utilityProcess.fork(path.join(root,'sqlite-capability.cjs'),[],{serviceName:'sqlite-capability'});
      out.nodeCapabilities.utility=await new Promise(resolve=>{
        const timeout=setTimeout(()=>{utility.kill();resolve({failure:'3s capability timeout'});},3000);
        utility.once('message',value=>{clearTimeout(timeout);resolve(value);});
        utility.once('exit',code=>{clearTimeout(timeout);resolve({failure:'Exited before capability message',code});});
      });
      out.nodeCapabilities.utilityPid=utility.pid;
      if(utility.pid) {
        const exited=new Promise(resolve=>utility.once('exit',code=>{out.nodeCapabilities.utilityExit=code;resolve();}));
        utility.kill();await exited;
      }
    }catch(error){out.nodeCapabilities.utility={failure:String(error)};}
    worker=spawn('python3',['-u',path.join(root,'worker.py')],{stdio:['ignore','pipe','pipe']}); starts++;
    let buffered='';worker.stdout.on('data',data=>{buffered+=data;const lines=buffered.split('\n');buffered=lines.pop();for(const line of lines)if(line)task=JSON.parse(line);});
    worker.stderr.on('data',data=>out.events.push({event:'worker-stderr',text:String(data)}));
    worker.on('error',error=>out.failure=String(error));
    worker.on('exit',(code,signal)=>{out.workerExit={code,signal,lastStatus:status()};});
    await openWindow('initial');
    out.renderer=await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,'renderer-probe.js'),'utf8'),true);
    app.focus({steal:true});win.focus();win.webContents.focus();
    await win.webContents.executeJavaScript(`probe.manual();probe.setViewport({x:95,y:35,zoom:.7});window.spikeMathfield?.focus();window.spikeMathfield?.executeCommand('moveToMathfieldEnd');`);
    await delay(250);
    const before=await win.webContents.executeJavaScript('window.spikeMathfield?.value');
    win.webContents.sendInputEvent({type:'char',keyCode:'7'});await delay(250);
    const after=await win.webContents.executeJavaScript('({value:window.spikeMathfield?.value,focused:document.activeElement===window.spikeMathfield})');
    out.syntheticNativeMathInput={before,after,windowFocused:win.isFocused(),webContentsFocused:win.webContents.isFocused(),mechanism:'webContents.sendInputEvent char 7; not physical keyboard/IME'};
    check('Electron synthetic native char edits focused MathLive',after.value===before+'7' && after.focused,out.syntheticNativeMathInput);
    // Bring actual course text back into the viewport for the saved visual evidence.
    await win.webContents.executeJavaScript('window.spikeMathfield?.blur();probe.manual();probe.setViewport({x:95,y:35,zoom:.7})');await delay(300);
    fs.writeFileSync(path.join(root,'electron-content.png'),(await win.webContents.capturePage()).toPNG());
    const preClose=await win.webContents.executeJavaScript('desktopSpike.getTaskStatus()');
    const oldWindowId=win.id, closed=new Promise(r=>win.once('closed',r));win.close();await closed;
    const zeroWindows=BrowserWindow.getAllWindows().length;
    const atClose=status();await delay(1200);const afterClosed=status();
    out.lifecycle={oldWindowId,preClose,atClose,zeroWindows,afterClosed};
    check('real BrowserWindow closes; same worker advances with zero windows',zeroWindows===0 && afterClosed.tick>atClose.tick &&
      afterClosed.workerPid===atClose.workerPid && afterClosed.jobId===preClose.jobId && starts===1,out.lifecycle);
    await openWindow('reopened');
    const reopened=await win.webContents.executeJavaScript(`(async()=>{
      const value=await desktopSpike.getTaskStatus();
      const panel=document.createElement('div');panel.id='host-task-status';panel.style='position:fixed;z-index:99999;top:80px;right:16px;padding:16px;background:white;border:2px solid green;color:black';
      panel.textContent='已有模拟任务 '+value.jobId+' · tick '+value.tick+' · starts '+value.starts;document.body.append(panel);
      return {status:value,text:panel.textContent,apiKeys:Object.keys(desktopSpike),nodeRequire:typeof require};
    })()`);
    out.lifecycle.reopened={windowId:win.id,...reopened};
    check('new window reads existing job via finite read-only IPC without recreation',win.id!==oldWindowId &&
      reopened.status.jobId===preClose.jobId && reopened.status.workerPid===preClose.workerPid &&
      reopened.status.tick>preClose.tick && reopened.status.starts===1 && reopened.apiKeys.join(',')==='getTaskStatus' && reopened.nodeRequire==='undefined',reopened);
    check('worker checksum matches deterministic progress',reopened.status.checksum===17*reopened.status.tick*(reopened.status.tick+1)/2,reopened.status);
    await delay(800);
    fs.writeFileSync(path.join(root,'electron-reopened.png'),(await win.webContents.capturePage()).toPNG());
  } catch(e) { out.failure=String(e.stack||e); }
  finally { out.explicitQuitRequested=true;app.quit(); }
});
app.on('before-quit',event=>{
  if(exiting)return;
  event.preventDefault();exiting=true;clearTimeout(guard);
  (async()=>{
    out.beforeQuit=status();
    if(worker && worker.exitCode===null && worker.signalCode===null){
      const ended=new Promise(r=>worker.once('exit',r));worker.kill('SIGTERM');
      const fallback=setTimeout(()=>worker.kill('SIGKILL'),1500);await ended;clearTimeout(fallback);
    }
    out.finalTask=status();
    check('explicit app quit awaits managed subprocess exit',Boolean(out.workerExit),out.workerExit);
    fs.writeFileSync(path.join(temp,'electron.json'),JSON.stringify(out,null,2));app.quit();
  })().catch(e=>{out.failure=String(e);fs.writeFileSync(path.join(temp,'electron.json'),JSON.stringify(out,null,2));app.exit(1);});
});
