import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared';
async function invoke(channel: string, argument?: unknown) {
  try { return await ipcRenderer.invoke(channel, argument); }
  catch (error) {
    // Remove Electron transport decoration; keep the meaningful course/storage error.
    throw new Error((error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  }
}
const bridge: DesktopBridge = {
  open: () => invoke('course:open'),
  graph: sessionId => invoke('course:graph', sessionId),
  readUnit: (sessionId, unitId) => ipcRenderer.invoke('course:read-unit', sessionId, unitId),
  readingState: sessionId => invoke('course:reading-state', sessionId),
  setReadingState: (sessionId, state) => ipcRenderer.invoke('course:set-reading-state', sessionId, state),
  save: command => invoke('course:save', command),
  onCloseRequested(listener) {
    const handler = async (_event: Electron.IpcRendererEvent, requestId: number) => {
      let saved = false;
      try { saved = await listener(); } catch { /* Keep the editor and input if flush failed. */ }
      ipcRenderer.send('window:close-result', { requestId, saved });
    };
    ipcRenderer.on('window:prepare-close', handler);
    return () => { ipcRenderer.removeListener('window:prepare-close', handler); };
  },
};
contextBridge.exposeInMainWorld('yizhi', bridge);
