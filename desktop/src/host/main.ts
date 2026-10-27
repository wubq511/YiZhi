import { drawingMethods } from '../drawing-api';
import { searchMethods } from '../search-api';
import { annotationMethods } from '../annotation-api';
import {registerExtensionProtocol,extensionNavigation} from './extension-protocol';
import { AgentRuntime } from '../agent/executor';
import { registerAgentIPC } from './agent-ipc';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol } from 'electron';
import { join, resolve } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { CourseService } from '../core/course-service';
import type { SaveParagraph } from '../shared';
import { registerSourceProtocols } from './source-protocol';
import { registerSourceIPC } from './source-ipc';

protocol.registerSchemesAsPrivileged(['yizhi-app', 'yizhi-resource', 'yizhi-extension'].map(scheme => ({ scheme,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } })));

app.setName('绎知');
if (process.env.YIZHI_DATA_HOME) {
  const profile = resolve(process.env.YIZHI_DATA_HOME);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
const initialCourse = process.argv.find(arg => arg.startsWith('--course='))?.slice(9);
let courseDirectory: string;
let core: CourseService;
let agent: AgentRuntime;
let window: BrowserWindow | undefined;
let quitRequested = false;
let exiting = false;
let recoveringRenderer = false;
let closeSequence = 0;
let pendingClose: number | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let activeSessionId: string | undefined;
function detachView() {
  if (core && activeSessionId) void core.commands.releaseView({ sessionId: activeSessionId })
    .then(() => core.commands.recheck({ sessionId: activeSessionId! })).catch(() => { /* Durable drafts remain guarded, including after renderer death. */ });
}

// Acquire before creating Worker or touching any course. Secondary launch rejoins this host.
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', (_event, argv) => {
    const requested = argv.find(arg => arg.startsWith('--course='))?.slice(9);
    // T01 owns one course window. Never silently switch an active editor to another course.
    const canonical = (directory: string) => {
      try { return realpathSync(directory); } catch { return resolve(directory); }
    };
    if (requested && courseDirectory && canonical(requested) !== canonical(courseDirectory)) {
      void dialog.showMessageBox({ type: 'info', message: '当前正在阅读另一课程',
        detail: '请先退出当前课程，再用指定课程启动绎知。' });
    }
    void showWindow();
  });
  app.whenReady().then(async () => {
    courseDirectory = resolve(initialCourse ?? join(app.getPath('userData'), 'courses/digital-logic-t01'));
    core = new CourseService(join(__dirname, 'worker.cjs'));
    agent = new AgentRuntime(core, { directory: join(app.getPath('userData'), 'agent-runtime'), cliPath: process.env.YIZHI_CODEX_PATH });
    void agent.detect();
    const checkSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('未知课程窗口');
    };
    registerExtensionProtocol(core);
    registerSourceProtocols(core, join(__dirname, 'renderer'));
    registerSourceIPC(core, checkSender);
    registerAgentIPC(core, agent, checkSender);
    for (const method of ['start','continue','stop','get','list','artifact','artifacts','correct','query'] as const) {
      ipcMain.handle(`parsing:${method}`, (event, request) => { checkSender(event); return core.parsing[method](request); });
    }
    for (const method of drawingMethods) ipcMain.handle(`drawings:${method}`, (event, request) => { checkSender(event); return core.drawings[method](request); });
    for (const method of searchMethods) ipcMain.handle(`search:${method}`, (event, request) => { checkSender(event); return core.search[method](request); });
    for (const method of annotationMethods) ipcMain.handle(`annotations:${method}`, (event, request) => { checkSender(event); return core.annotations[method](request); });
    for (const method of ['open','read','act'] as const) ipcMain.handle(`extensions:${method}`, (event,payload) => {checkSender(event);return core.extensions[method](payload);});
    ipcMain.handle('course:open', async event => { checkSender(event); const opened = await core.open(courseDirectory); activeSessionId = opened.sessionId; return opened; });
    ipcMain.handle('course:graph', async (event, sessionId: string) => { checkSender(event); return core.graph(sessionId); });
    ipcMain.handle('course:read-unit', async (event, sessionId: string, unitId: string) => { checkSender(event); return core.readUnit(sessionId, unitId); });
    ipcMain.handle('course:set-layout', async (event, sessionId: string, updates) => { checkSender(event); return core.setLayout(sessionId, updates); });
    ipcMain.handle('course:project-layout', async (event, sessionId: string, sizes, fixed) => { checkSender(event); return core.projectLayout(sessionId, sizes, fixed); });
    ipcMain.handle('course:reading-state', async (event, sessionId: string) => { checkSender(event); return core.readingState(sessionId); });
    ipcMain.handle('course:set-reading-state', async (event, sessionId: string, state) => { checkSender(event); return core.setReadingState(sessionId, state); });
    ipcMain.handle('course:review-states', async (event, sessionId: string) => { checkSender(event); return core.reviewStates(sessionId); });
    ipcMain.handle('course:set-review-status', async (event, input) => { checkSender(event); return core.setReviewStatus(input.sessionId, input.unitId, input.status); });
    ipcMain.handle('course:confirm-review-prompt', async (event, input) => { checkSender(event); return core.confirmReviewPrompt(input.sessionId, input.promptId, input.adjust); });
    ipcMain.handle('course:save', async (event, command: SaveParagraph) => { checkSender(event); return core.save(command); });
    ipcMain.handle('course:saveDraft', (event, input) => { checkSender(event); return core.saveDraft(input); });
    ipcMain.handle('course:commitEdit', (event, command) => { checkSender(event); return core.commitEdit(command); });
    ipcMain.handle('course:queryOperation', (event, input) => { checkSender(event); return core.queryOperation(input.sessionId, input.operationId); });
    ipcMain.handle('course:readEvents', (event, input) => { checkSender(event); return core.readEvents(input.sessionId, input.after, input.limit); });
    ipcMain.handle('course:read', (event, input) => { checkSender(event); return core.read(input.sessionId); });
    for (const method of ['open', 'read', 'snapshot', 'act', 'pauseAll'] as const) {
      ipcMain.handle(`experiments:${method}`, (event, payload) => { checkSender(event); return core.experiments[method](payload); });
    }
    for (const method of ['protect', 'releaseView', 'recheck', 'resolveInput', 'resolveCandidate', 'startAttempt', 'read', 'commit', 'stop', 'query', 'candidates', 'history'] as const) {
      ipcMain.handle(`commands:${method}`, (event, payload) => { checkSender(event); return core.commands[method](payload); });
    }
    for (const method of ['read', 'commit', 'query', 'prerequisites'] as const) {
      ipcMain.handle(`relations:${method}`, (event, payload) => { checkSender(event); return core.relations[method](payload); });
    }
    ipcMain.on('window:close-result', async (event, result) => {
      checkSender(event);
      if (!result || result.requestId !== pendingClose || typeof result.saved !== 'boolean') return;
      clearTimeout(closeTimer); pendingClose = undefined;
      if (!result.saved) { quitRequested = false; return; }
      if (quitRequested) {
        try { await agent.close(); await core.close(); exiting = true; app.quit(); }
        catch (error) {
          quitRequested = false;
          void dialog.showErrorBox('退出未完成', (error as Error).message);
        }
      } else window?.destroy();
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '绎知', submenu: [{ role: 'about' }, { type: 'separator' },
        { label: '退出绎知', accelerator: 'Cmd+Q', click: () => app.quit() }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { label: '继续阅读', click: () => void showWindow() }, {label:'恢复无响应窗口',click:()=>void recoverRenderer()}] },
    ]));
    await showWindow();
  }).catch(error => { dialog.showErrorBox('无法打开绎知', String(error)); app.exit(1); });
  app.on('activate', () => { if (core && !exiting) void showWindow(); });
  // A learning window is a client; closing it must not end the host-owned core.
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    if (exiting) return;
    event.preventDefault(); quitRequested = true;
    if (window) requestClose();
    else if (core) void agent.close().then(() => core.close()).then(() => { exiting = true; app.quit(); }).catch(error => {
      quitRequested = false; dialog.showErrorBox('退出未完成', String(error));
    });
  });
}
/** This runs in the host even if every script in the learning renderer is stuck. */
async function recoverRenderer() {
  if(!window||recoveringRenderer||exiting)return;
  recoveringRenderer=true;
  try {
    const {response}=await dialog.showMessageBox(window,{type:'warning',message:'学习窗口没有响应',detail:'从已保存的正文、草稿与实验确认现场恢复。未确认的实验计算不会作为保存结果。',buttons:['恢复窗口','暂不恢复'],defaultId:0,cancelId:1});
    if(response!==0||!window)return;
    // Revoke all browser callbacks before creating another process. Core/Agent/parser stay owned by the host.
    await core.recoverExtensionRenderers();
    clearTimeout(closeTimer);pendingClose=undefined;quitRequested=false;
    const failed=window,bounds=failed.getBounds();
    failed.webContents.forcefullyCrashRenderer();
    failed.destroy();
    await showWindow(bounds);
  }catch(error){dialog.showErrorBox('窗口恢复未完成',String(error));}
  finally{recoveringRenderer=false;}
}
function requestClose() {
  if (!window || pendingClose !== undefined) return;
  pendingClose = ++closeSequence;
  window.webContents.send('window:prepare-close', pendingClose);
  closeTimer = setTimeout(() => {
    pendingClose = undefined; quitRequested = false;
    dialog.showErrorBox('尚未确认保存', '窗口没有返回最新输入的保存确认。窗口仍保留，请检查后重试。');
  }, 15_000);
}
async function showWindow(bounds?: Electron.Rectangle) {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1280, height: 900, ...bounds, minWidth: 660, minHeight: 500,
    title: '绎知 · 数字逻辑', backgroundColor: '#ffffff',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true } });
  window.webContents.on('unresponsive',()=>void recoverRenderer());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', detachView);
  window.webContents.on('will-frame-navigate', event => { if(event.isMainFrame || !extensionNavigation(event.url)) event.preventDefault(); });
  window.on('close', event => { if (!exiting) { event.preventDefault(); requestClose(); } });
  window.on('closed', () => { detachView(); window = undefined; pendingClose = undefined; clearTimeout(closeTimer); });
  await window.loadURL('yizhi-app://app/index.html');
}
