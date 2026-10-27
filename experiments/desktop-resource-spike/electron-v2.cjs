const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const [origin,run,temp]=process.argv.slice(2);
app.setPath('userData',path.join(temp,run+'-user'));
app.setPath('sessionData',path.join(temp,run+'-session'));
app.setPath('logs',path.join(temp,run+'-logs'));
const source=fs.readFileSync(path.join(__dirname,'renderer-v2.js'),'utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mark=(kind,phase,data={})=>fetch(origin+'/mark',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({run,kind,phase,...data})});
let win,guard;
const native=()=>({visible:win.isVisible(),focus:win.isFocused(),webFocus:win.webContents.isFocused(),bounds:win.getContentBounds()});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  guard=setTimeout(()=>app.exit(2),65000);
  try {
    await mark('register','setup',{pid:process.pid,versions:process.versions,configuration:{backgroundThrottling:true,contextIsolation:true,nodeIntegration:false,sandbox:true,activation:'once per phase; no retry'}});
    win=new BrowserWindow({width:1000,height:700,useContentSize:true,x:60,y:60,show:true,
      title:'Resource spike v2 — Electron',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:true}});
    for(const mode of ['blank','reading','load']) {
      if(mode!=='load')await win.loadURL(mode==='blank'?origin+'/empty':origin+'/?count=500&mode=managed&dynamic=1');
      win.setContentSize(1000,700);app.focus({steal:true});win.show();win.focus();win.webContents.focus();
      await mark('native',mode,{native:native(),metrics:app.getAppMetrics()});
      await win.webContents.executeJavaScript(source+`;resourceProbe(${JSON.stringify(origin)},${JSON.stringify(run)},${JSON.stringify(mode)})`,true);
      await mark('native',mode+'-end',{native:native(),metrics:app.getAppMetrics()});
    }
    win.close();win=null;
    await sleep(2000);
    await mark('begin','closed',{windows:BrowserWindow.getAllWindows().length,metrics:app.getAppMetrics()});
    await sleep(8000);
    await mark('end','closed',{windows:BrowserWindow.getAllWindows().length,metrics:app.getAppMetrics()});
  }catch(e){await mark('failure','host',{error:String(e.stack||e)}).catch(()=>{});}
  finally{clearTimeout(guard);app.quit();}
});
