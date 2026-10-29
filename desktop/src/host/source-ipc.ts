import { BrowserWindow, dialog, ipcMain } from 'electron';
import { basename } from 'node:path';
import type { CourseService } from '../core/course-service';
import type { SourceCommand, ImportSource } from '../sources-api';

export function registerSourceIPC(core: CourseService, checkSender: (event: Electron.IpcMainInvokeEvent) => void) {
  for (const method of ['list', 'getVersion', 'page', 'mapPrintedPage', 'locatePrintedPage', 'cite', 'citations', 'setUpdateIntent', 'query', 'context', 'saveContext'] as const) {
    ipcMain.handle(`sources:${method}`, (event, request) => { checkSender(event); return core.sources[method](request); });
  }
  // The selected path stays in the host. An exact retry reuses it without asking the renderer for a path.
  const pending = new Map<string, { identity: string; command: ImportSource | (SourceCommand & { versionId: string; path: string }) }>();
  for (const mode of ['chooseImport', 'chooseRepair'] as const) {
    ipcMain.handle(`sources:${mode}`, async (event, request) => {
      checkSender(event);
      if (!request || typeof request.operationId !== 'string' || !request.operationId.length || request.operationId.length > 200 ||
        !Number.isSafeInteger(request.generation) || typeof request.sessionId !== 'string' ||
        Object.keys(request).some(key => !['sessionId', 'operationId', 'generation', 'sourceId', 'versionId'].includes(key))) throw new Error('无效的文件选择请求');
      // Validate the session before displaying a native chooser.
      await core.sources.list({ sessionId: request.sessionId });
      const key = `${mode}:${request.sessionId}:${request.operationId}`;
      const identity = JSON.stringify([request.generation, request.sourceId ?? null, request.versionId ?? null]);
      const old = pending.get(key);
      if (old && old.identity !== identity) throw new Error('同一操作不能换用不同内容');
      let command = old?.command;
      if (!command) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner || owner.isDestroyed()) throw new Error('学习窗口已关闭，请从当前窗口重新选择资料');
        const result = await dialog.showOpenDialog(owner, { title: mode === 'chooseImport' ? '导入课程原件' : '选择该版本的原件以修复',
          properties: ['openFile'], filters: [{ name: '课程资料', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
        if (result.canceled || !result.filePaths[0]) return null;
        const path = result.filePaths[0];
        command = mode === 'chooseImport' ? { sessionId: request.sessionId, generation: request.generation,
          operationId: request.operationId, sourceId: request.sourceId, path, title: basename(path) } :
          { sessionId: request.sessionId, generation: request.generation, operationId: request.operationId, versionId: request.versionId, path };
        pending.set(key, { identity, command });
        if (pending.size > 16) pending.delete(pending.keys().next().value!);
      }
      return mode === 'chooseImport' ? core.sources.importFile(command as ImportSource) : core.sources.repairFile(command as SourceCommand & { versionId: string; path: string });
    });
  }
}
