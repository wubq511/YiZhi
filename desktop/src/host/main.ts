import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { join, resolve } from 'node:path';
import { mkdirSync, realpathSync } from 'node:fs';
import { CourseService } from '../core/course-service';
import type { SaveParagraph } from '../shared';

app.setName('绎知');
if (process.env.YIZHI_DATA_HOME) {
  const profile = resolve(process.env.YIZHI_DATA_HOME);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
const initialCourse = process.argv.find(arg => arg.startsWith('--course='))?.slice(9);
let courseDirectory: string;
let core: CourseService;
let window: BrowserWindow | undefined;
let quitRequested = false;
let exiting = false;
let closeSequence = 0;
let pendingClose: number | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

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
    const checkSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('未知课程窗口');
    };
    ipcMain.handle('course:open', async event => { checkSender(event); return core.open(courseDirectory); });
    ipcMain.handle('course:save', async (event, command: SaveParagraph) => { checkSender(event); return core.save(command); });
    ipcMain.handle('course:saveDraft', (event, input) => { checkSender(event); return core.saveDraft(input); });
    ipcMain.handle('course:commitEdit', (event, command) => { checkSender(event); return core.commitEdit(command); });
    ipcMain.handle('course:queryOperation', (event, input) => { checkSender(event); return core.queryOperation(input.sessionId, input.operationId); });
    ipcMain.handle('course:readEvents', (event, input) => { checkSender(event); return core.readEvents(input.sessionId, input.after, input.limit); });
    ipcMain.handle('course:read', (event, input) => { checkSender(event); return core.read(input.sessionId); });
    for (const method of ['startAttempt', 'read', 'commit', 'stop', 'query', 'candidates', 'history'] as const) {
      ipcMain.handle(`commands:${method}`, (event, payload) => { checkSender(event); return core.commands[method](payload); });
    }
    ipcMain.on('window:close-result', async (event, result) => {
      checkSender(event);
      if (!result || result.requestId !== pendingClose || typeof result.saved !== 'boolean') return;
      clearTimeout(closeTimer); pendingClose = undefined;
      if (!result.saved) { quitRequested = false; return; }
      if (quitRequested) {
        try { await core.close(); exiting = true; app.quit(); }
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
      { label: '窗口', submenu: [{ role: 'minimize' }, { label: '继续阅读', click: () => void showWindow() }] },
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
    else if (core) void core.close().then(() => { exiting = true; app.quit(); }).catch(error => {
      quitRequested = false; dialog.showErrorBox('退出未完成', String(error));
    });
  });
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
async function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1280, height: 900, minWidth: 660, minHeight: 500,
    title: '绎知 · 数字逻辑', backgroundColor: '#ffffff',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!exiting) { event.preventDefault(); requestClose(); } });
  window.on('closed', () => { window = undefined; pendingClose = undefined; clearTimeout(closeTimer); });
  await window.loadFile(join(__dirname, 'renderer/index.html'));
}
