import { dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import type { CourseService } from '../core/course-service';
import type { ExchangePreview } from '../exchange-api';

/** Native paths stay in the host. The renderer can only confirm a checked host selection. */
export function registerExchangeIPC(core: CourseService, checkSender: (event: Electron.IpcMainInvokeEvent) => void) {
  const selections = new Map<string, { sessionId: string; directory: string; preview: ExchangePreview }>();
  const exact = (request: any, allowed: string[]) => {
    if (!request || typeof request.sessionId !== 'string' || Object.keys(request).some((k) => !allowed.includes(k)))
      throw new Error('无效的交换请求');
  };
  for (const method of ['available', 'query'] as const)
    ipcMain.handle(`exchange:${method}`, (event, request) => {
      checkSender(event);
      exact(request, method === 'query' ? ['sessionId', 'operationId'] : ['sessionId']);
      return core.exchange[method](request);
    });
  ipcMain.handle('exchange:chooseExport', async (event, request) => {
    checkSender(event);
    exact(request, ['sessionId', 'unitIds', 'annotations']);
    await core.exchange.available(request);
    const selected = await dialog.showSaveDialog({
      title: '新建内容交换包目录',
      buttonLabel: '导出内容',
      defaultPath: '课程内容.yizhi-exchange',
    });
    if (selected.canceled || !selected.filePath) return null;
    return core.exchange.exportPackage({ ...request, directory: selected.filePath });
  });
  ipcMain.handle('exchange:chooseImport', async (event, request) => {
    checkSender(event);
    exact(request, ['sessionId']);
    await core.exchange.available(request);
    const selected = await dialog.showOpenDialog({ title: '选择内容交换包目录', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const directory = selected.filePaths[0],
      preview = await core.exchange.inspect({ ...request, directory }),
      selectionId = randomUUID();
    selections.set(selectionId, { sessionId: request.sessionId, directory, preview });
    if (selections.size > 16) selections.delete(selections.keys().next().value!);
    return { ...preview, selectionId };
  });
  ipcMain.handle('exchange:confirmImport', (event, request) => {
    checkSender(event);
    exact(request, ['sessionId', 'selectionId', 'operationId']);
    if (typeof request.operationId !== 'string' || !request.operationId.length) throw new Error('无效的导入操作身份');
    const selected = selections.get(request.selectionId);
    if (!selected || selected.sessionId !== request.sessionId) throw new Error('选择已失效，请重新检查交换包');
    return core.exchange.importPackage({
      sessionId: request.sessionId,
      operationId: request.operationId,
      directory: selected.directory,
      basis: selected.preview.basis,
      packageDigest: selected.preview.packageDigest,
    });
  });
}
