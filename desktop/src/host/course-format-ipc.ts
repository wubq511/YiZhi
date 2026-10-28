import { BrowserWindow,dialog,ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { realpathSync,existsSync } from 'node:fs';
import { resolve,relative,dirname,basename,join,sep } from 'node:path';
import type { CourseService } from '../core/course-service';
import { understoodText } from '../format-api';

/** Readonly fallback stays bound to this host window's selected course, without writable admission. */
export function registerCourseFormatIPC(core:CourseService,sender:(event:Electron.IpcMainInvokeEvent)=>{directory:string}){
 ipcMain.handle('courseFormat:inspect',event=>core.format.inspect({directory:sender(event).directory}));
 for(const method of ['readUnit','exportText'] as const)ipcMain.handle('courseFormat:'+method,async(event,request)=>{
  const view=sender(event);
  if(!request||typeof request.unitId!=='string'||Object.keys(request).some(k=>k!=='unitId'))throw new Error('只读范围请求无效');
  const unit=await core.format.readUnit({directory:view.directory,unitId:request.unitId});
  if(method==='readUnit')return unit;
  const owner=BrowserWindow.fromWebContents(event.sender);if(!owner)throw new Error('课程窗口已关闭');
  const selected=await dialog.showSaveDialog(owner,{title:'导出已支持的文本与公式',defaultPath:unit.id+'-文本与公式.txt',buttonLabel:'导出文本与公式'});
  if(selected.canceled||!selected.filePath)return false;
  const requested=resolve(selected.filePath),output=existsSync(requested)?realpathSync(requested):join(realpathSync(dirname(requested)),basename(requested)),path=relative(realpathSync(view.directory),output);
  if(path!=='..'&&!path.startsWith('..'+sep))throw new Error('请将文本导出到课程目录之外，保留原课程数据');
  await writeFile(output,understoodText(unit),'utf8');return true;
 });
}
