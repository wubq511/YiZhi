import { searchClient } from '../search-api';
import { annotationClient } from '../annotation-api';
import {extensionsClient} from '../extensions-api';
import { experimentsClient } from '../experiments-api';
import { agentClient } from '../agent-api';
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared';
import { parsingBridge } from '../parsing-api';
import { relationClient } from '../relation-api';
import { commandClient } from '../command-api';
import { sourceBridge } from '../sources-api';
async function invoke(channel: string, argument?: unknown) {
  try { return await ipcRenderer.invoke(channel, argument); }
  catch (error) {
    // Remove Electron transport decoration; keep the meaningful course/storage error.
    throw new Error((error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
  }
}
const bridge: DesktopBridge = {
  search: searchClient(invoke),
  annotations: annotationClient(invoke),
  extensions: (() => { const {resource, ...api}=extensionsClient(invoke); return api; })(),
  experiments: experimentsClient(invoke),
  agent: { ...agentClient(invoke), status: () => invoke('agent:status') },
  parsing: parsingBridge(invoke),
  sources: sourceBridge(invoke),
  commands: commandClient(invoke),
  relations: relationClient(invoke),
  open: () => invoke('course:open'),
  graph: sessionId => invoke('course:graph', sessionId),
  readUnit: (sessionId, unitId) => ipcRenderer.invoke('course:read-unit', sessionId, unitId),
  setLayout: (sessionId, updates) => ipcRenderer.invoke('course:set-layout', sessionId, updates),
  projectLayout: (sessionId, sizes, fixed) => ipcRenderer.invoke('course:project-layout', sessionId, sizes, fixed),
  readingState: sessionId => invoke('course:reading-state', sessionId),
  setReadingState: (sessionId, state) => ipcRenderer.invoke('course:set-reading-state', sessionId, state),
  reviewStates: sessionId => invoke('course:review-states', sessionId),
  setReviewStatus: (sessionId, unitId, status) => invoke('course:set-review-status', { sessionId, unitId, status }),
  confirmReviewPrompt: (sessionId, promptId, adjust) => invoke('course:confirm-review-prompt', { sessionId, promptId, adjust }),
  save: command => invoke('course:save', command),
  saveDraft: input => invoke('course:saveDraft', input),
  commitEdit: command => invoke('course:commitEdit', command),
  queryOperation: (sessionId, operationId) => invoke('course:queryOperation', { sessionId, operationId }),
  readEvents: (sessionId, after, limit = 64) => invoke('course:readEvents', { sessionId, after, limit }),
  read: sessionId => invoke('course:read', { sessionId }),
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
