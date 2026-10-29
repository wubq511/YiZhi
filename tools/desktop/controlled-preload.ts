import '../../desktop/src/host/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { commandClient, type CommandAPI } from '../../desktop/src/command-api';
declare global { interface Window { yizhiControlled: CommandAPI } }
contextBridge.exposeInMainWorld('yizhiControlled', commandClient((channel, payload) => ipcRenderer.invoke(channel, payload)));
