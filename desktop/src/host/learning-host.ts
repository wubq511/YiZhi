import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { realpathSync,mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CourseService } from '../core/course-service';
import type { AgentRuntime } from '../agent/executor';
import type { DescriptionRuntime } from '../agent/description-search';
import { extensionNavigation } from './extension-protocol';
interface View {
  directory:string; window:BrowserWindow; id:string; sessionId?:string; recovery?:{unconfirmedTail:boolean;detail:string};
  opening?:Promise<void>; close?:Promise<boolean>; reply?:(saved:boolean)=>void; requestId?:number; saved:boolean; recovering:boolean; detached?:boolean; detaching?:Promise<void>;
}
const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
/** One learning window per canonical course, one host/Core authority across all of them. */
export class LearningHost {
  private views=new Map<string,View>();
  private sequence=0;
  private quitting?:Promise<void>;
  private quiescing=false;
  exiting=false;
  private lastDirectory:string;
  constructor(private core:CourseService,private agent:AgentRuntime,private description:DescriptionRuntime,directory:string,private preloadDirectory:string) {
    this.lastDirectory=directory;
    ipcMain.on('window:close-result',(event,result)=>{
      let view:View;try{view=this.sender(event);}catch{return;}
      if(result?.requestId===view.requestId && typeof result.saved==='boolean')view.reply?.(result.saved);
    });
  }
  assertTaskAdmission(){if(this.quiescing||this.exiting)throw new Error('应用正在退出，不再接纳新任务');}
  sender=(event:Electron.IpcMainInvokeEvent|Electron.IpcMainEvent):View=>{
    const view=[...this.views.values()].find(v=>v.window.webContents===event.sender);
    if(!view || event.senderFrame!==view.window.webContents.mainFrame)throw new Error('未知课程窗口');
    return view;
  };
  open=async(event:Electron.IpcMainInvokeEvent)=>{
    const view=this.sender(event);
    view.opening??=(async()=>{
      const opened=await this.core.open(view.directory);view.sessionId=opened.sessionId;
      view.recovery=await this.core.openLearningView({sessionId:opened.sessionId,viewId:view.id});
    })();
    await view.opening;
    // The Worker may rotate course authority after a committed whole-course recovery.
    const latest=await this.core.open(view.directory);
    if(view.sessionId!==latest.sessionId){view.sessionId=latest.sessionId;view.recovery=await this.core.openLearningView({sessionId:latest.sessionId,viewId:view.id});}
    return {...await this.core.read(view.sessionId!),inputRecovery:view.recovery};
  };
  async restored(event:Electron.IpcMainInvokeEvent){const view=this.sender(event);await this.open(event);view.window.webContents.send('course:generation-changed');}
  async show(directory=this.lastDirectory,bounds?:Electron.Rectangle) {
    if(this.quiescing||this.exiting)return;
    mkdirSync(directory,{recursive:true});directory=canonical(directory);this.lastDirectory=directory;
    const existing=this.views.get(directory);
    if(existing){if(existing.window.isMinimized())existing.window.restore();existing.window.show();existing.window.focus();return;}
    const window=new BrowserWindow({width:1280,height:900,...bounds,minWidth:660,minHeight:500,title:'绎知',backgroundColor:'#ffffff',
      webPreferences:{preload:join(this.preloadDirectory,'preload.cjs'),contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,sandbox:true,
        additionalArguments:process.env.YIZHI_OBSERVE==='1'?['--yizhi-observe']:[]}});
    const view:View={directory,window,id:randomUUID(),saved:false,recovering:false};this.views.set(directory,view);
    window.on('focus',()=>{this.lastDirectory=directory;});
    window.webContents.on('unresponsive',()=>void this.recover(view));
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.on('will-frame-navigate',event=>{if(event.isMainFrame||!extensionNavigation(event.url))event.preventDefault();});
    window.webContents.on('render-process-gone',()=>{void this.detach(view,false).catch(()=>{});view.reply?.(false);});
    window.on('close',event=>{if(!this.exiting){event.preventDefault();if(!this.quiescing)void this.closeView(view);}});
    window.on('closed',()=>{
      this.views.delete(directory);view.reply?.(false);void this.detach(view,view.saved).catch(()=>{});
    });
    await window.loadURL('yizhi-app://app/index.html');
  }
  private detach(view:View,saved:boolean):Promise<void> {
    if(!view.sessionId||!view.recovery||view.detached)return Promise.resolve();
    return view.detaching??=this.core.releaseLearningView({sessionId:view.sessionId,viewId:view.id,saved})
      .then(()=>{view.detached=true;}).finally(()=>{view.detaching=undefined;});
  }
  private barrier(view:View):Promise<boolean> {
    if(view.close)return view.close;
    const pending=new Promise<boolean>(resolve=>{
      const requestId=++this.sequence;view.requestId=requestId;
      const timer=setTimeout(()=>{
        view.reply?.(false);
        dialog.showErrorBox('尚未确认保存','窗口没有返回最新输入的保存确认。窗口仍保留，请检查后重试。');
      },15_000);
      view.reply=saved=>{clearTimeout(timer);view.reply=undefined;view.requestId=undefined;resolve(saved);};
      view.window.webContents.send('window:prepare-close',requestId);
    }).then(async saved=>{
      if(saved && view.sessionId && view.recovery)await this.core.confirmLearningView({sessionId:view.sessionId,viewId:view.id});
      return saved;
    });
    return view.close=pending.finally(()=>{view.close=undefined;});
  }
  private async unfreeze() {
    for(const view of this.views.values()) {
      if(view.sessionId)await this.core.openLearningView({sessionId:view.sessionId,viewId:view.id}).catch(()=>{});
      if(!view.window.isDestroyed())view.window.webContents.send('window:close-cancelled');
    }
  }
  private async closeView(view:View) {
    try {if(await this.barrier(view)){if(!this.quiescing){view.saved=true;view.window.destroy();}}else if(!this.quiescing)await this.unfreeze();}
    catch(error){await this.unfreeze();dialog.showErrorBox('关窗未完成',String(error));}
  }
  quit() {
    if(this.quitting)return this.quitting;
    this.quiescing=true;this.description.prepareQuit();
    return this.quitting=(async()=>{
      // No new Agent admission; the ordered Core revokes future writes before window barriers.
      await this.agent.prepareQuit();
      await Promise.allSettled([...this.views.values()].map(v=>v.opening));
      const views=[...this.views.values()],saved=await Promise.all(views.map(v=>this.barrier(v)));
      if(saved.some(value=>!value))throw new Error('仍有窗口的最新输入未确认保存。请重试保存后再退出。');
      // All asynchronous index/source reads drain in Core.close; no Worker is terminated early.
      await this.description.close();await this.agent.close();await this.core.close();
      this.exiting=true;for(const view of views)view.saved=true;app.quit();
    })().catch(async error=>{
      this.quiescing=false;this.quitting=undefined;this.agent.cancelQuit();this.description.cancelQuit();
      await this.unfreeze();dialog.showErrorBox('退出未完成',String(error));
    });
  }
  async chooseCourse() {
    if(this.quiescing)return;
    const result=await dialog.showOpenDialog({title:'打开课程文件夹',properties:['openDirectory']});
    if(!result.canceled&&result.filePaths[0])await this.show(result.filePaths[0]);
  }
  async recover(view=[...this.views.values()].find(v=>v.window===BrowserWindow.getFocusedWindow())??this.views.get(this.lastDirectory)) {
    if(!view||view.recovering||this.quiescing||this.exiting)return;
    view.recovering=true;
    try {
      const {response}=await dialog.showMessageBox(view.window,{type:'warning',message:'学习窗口没有响应',detail:'从已保存的正文、草稿与实验确认现场恢复。未确认尾部无法保证找回。',buttons:['恢复窗口','暂不恢复'],defaultId:0,cancelId:1});
      if(response!==0||view.window.isDestroyed())return;
      if(view.sessionId)await this.core.recoverExtensionRenderers(view.sessionId);view.reply?.(false);
      const bounds=view.window.getBounds();await this.detach(view,false);
      view.window.webContents.forcefullyCrashRenderer();view.window.destroy();
      await this.show(view.directory,bounds);
    }catch(error){dialog.showErrorBox('窗口恢复未完成',String(error));}
    finally{view.recovering=false;}
  }
}
