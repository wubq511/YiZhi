import { BrowserWindow,dialog,ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CourseService } from '../core/course-service';

/** Native selection owns paths; renderer cannot submit a filesystem target or a lease. */
export function registerBackupIPC(core:CourseService,checkSender:(event:Electron.IpcMainInvokeEvent)=>void){
 for(const method of ['chooseCreate','chooseResume'] as const)ipcMain.handle('backup:'+method,async(event,request)=>{
  checkSender(event);
  if(!request||typeof request.sessionId!=='string'||Object.keys(request).some(k=>k!=='sessionId'))throw new Error('备份请求无效');
  await core.read(request.sessionId);
  const owner=BrowserWindow.fromWebContents(event.sender);if(!owner)throw new Error('课程窗口已关闭');
  let directory:string;
  if(method==='chooseCreate'){
   const selected=await dialog.showSaveDialog(owner,{title:'新建完整课程备份',buttonLabel:'创建备份',defaultPath:'课程完整备份.yizhi-backup'});
   if(selected.canceled||!selected.filePath)return null;
   directory=selected.filePath;
   await core.backup.create({...request,directory,backupId:randomUUID()});
  }else{
   const selected=await dialog.showOpenDialog(owner,{title:'选择未完成的完整备份',properties:['openDirectory']});
   if(selected.canceled||!selected.filePaths[0])return null;
   directory=selected.filePaths[0];const previous=await core.backup.status({directory});
   await core.backup.resume({...request,directory,backupId:previous.backupId});
  }
  // Verify the archived bytes before returning any UI success.
  return core.backup.verify({directory});
 });
}
