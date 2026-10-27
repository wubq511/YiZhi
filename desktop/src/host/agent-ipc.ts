import { ipcMain } from 'electron';
import type { CourseService } from '../core/course-service';
import { AgentRuntime } from '../agent/executor';
export function registerAgentIPC(core: CourseService, runtime: AgentRuntime, checkSender: (event: Electron.IpcMainInvokeEvent) => void) {
  ipcMain.handle('agent:status', event => { checkSender(event); return runtime.status(); });
  for (const method of ['list', 'create', 'get', 'select', 'saveDraft'] as const)
    ipcMain.handle(`agent:${method}`, (event, request) => { checkSender(event); return core.agent[method](request); });
  ipcMain.handle('agent:submit', (event, request) => { checkSender(event); return runtime.submit(request); });
}
