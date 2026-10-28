import { dialog,ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CourseService } from '../core/course-service';
import type { LearningHost } from './learning-host';

export function registerUpgradeIPC(core:CourseService,host:LearningHost){
 const current=(event:Electron.IpcMainInvokeEvent,request:any)=>{
  const view=host.sender(event);if(!request||typeof request.sessionId!=='string'||Object.keys(request).some(k=>k!=='sessionId')||view.sessionId!==request.sessionId)throw new Error('升级课程会话无效');return view;
 };
 ipcMain.handle('upgrade:info',async(event,request)=>{const view=current(event,request),[format,status]=await Promise.all([core.format.inspect({directory:view.directory}),core.upgrade.status({directory:view.directory})]);return {courseFormat:format.courseFormat,directory:view.directory,decision:status.decision};});
 ipcMain.handle('upgrade:choose',async(event,request)=>{
  const view=current(event,request),sourceDirectory=view.directory;
  const selected=await dialog.showSaveDialog(view.window,{title:'选择升级后的新课程目录',buttonLabel:'备份并升级',defaultPath:'升级后的课程.yizhi'});if(selected.canceled||!selected.filePath)return null;
  const saveBarrier=await host.freezeForUpgrade(event),upgradeId=randomUUID();
  try{
   await core.upgrade.prepare({sessionId:request.sessionId,directory:selected.filePath,backupDirectory:selected.filePath+'.before-upgrade',upgradeId,saveBarrier});
   const decision=await core.upgrade.publish({sessionId:request.sessionId,upgradeId});await host.enterUpgradedCourse(event,decision.targetDirectory);return decision;
  }catch(e){
   const status=await core.upgrade.status({directory:sourceDirectory});
   if(status.decision?.phase==='published'){
    const recovered=await core.upgrade.recover({directory:sourceDirectory});await host.enterUpgradedCourse(event,recovered.directory);return recovered.decision;
   }
   await host.resumeAfterUpgradeError(event);throw e;
  }
 });
 ipcMain.handle('upgrade:chooseRecover',async event=>{
  const view=host.sender(event),selected=await dialog.showOpenDialog(view.window,{title:'选择原课程或升级后课程的当前位置',properties:['openDirectory']});if(selected.canceled||!selected.filePaths[0])return false;
  const recovered=await core.upgrade.recover({directory:selected.filePaths[0]});await host.show(recovered.directory);return true;
 });
}
