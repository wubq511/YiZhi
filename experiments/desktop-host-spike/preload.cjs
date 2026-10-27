const { contextBridge, ipcRenderer } = require('electron');
// The page receives exactly one read-only function. No task creation/restart or arbitrary IPC.
contextBridge.exposeInMainWorld('desktopSpike', {
  getTaskStatus: () => ipcRenderer.invoke('spike:task-status'),
});
