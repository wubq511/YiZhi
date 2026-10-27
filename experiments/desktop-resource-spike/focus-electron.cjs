const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const [url,temp,outfile]=process.argv.slice(2);
app.setPath('userData',path.join(temp,'user'));app.setPath('sessionData',path.join(temp,'session'));
app.setPath('logs',path.join(temp,'logs'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const out={host:'Electron',activationAttempts:1,samples:[],backgroundThrottling:true};
  try {
    const win=new BrowserWindow({x:60,y:60,width:1000,height:700,useContentSize:true,show:false,
      title:'One-shot focus diagnostic — Electron',webPreferences:{backgroundThrottling:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});
    await win.loadURL(url);
    app.focus({steal:true});win.show();win.focus();win.webContents.focus();
    for(let i=0;i<20;i++) {
      await sleep(200);
      const row={wallTime:Date.now()/1000,nativeKey:win.isFocused(),nativeWebFocus:win.webContents.isFocused()};
      row.document=await win.webContents.executeJavaScript('({focus:document.hasFocus(),visible:document.visibilityState,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,ready:!!window.probe?.ready})');
      out.samples.push(row);
    }
  }catch(e){out.failure=String(e.stack||e);}
  finally{fs.writeFileSync(outfile,JSON.stringify(out,null,2));app.quit();}
});
