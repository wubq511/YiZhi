import { LearningHost } from './learning-host';
import { DescriptionRuntime } from '../agent/description-search';
import { drawingMethods } from '../drawing-api';
import { registerExchangeIPC } from './exchange-ipc';
import { searchMethods } from '../search-api';
import { annotationMethods } from '../annotation-api';
import {registerExtensionProtocol} from './extension-protocol';
import { AgentRuntime } from '../agent/executor';
import { registerAgentIPC } from './agent-ipc';
import { app, dialog, ipcMain, Menu, protocol } from 'electron';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
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
let description: DescriptionRuntime;
let host: LearningHost;
// Acquire before creating Worker or touching any course. Secondary launch rejoins this host.
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  app.on('second-instance', (_event, argv) => {
    const requested = argv.find(arg => arg.startsWith('--course='))?.slice(9);
    if(host)void host.show(requested);

  });
  app.whenReady().then(async () => {
    courseDirectory = resolve(initialCourse ?? join(app.getPath('userData'), 'courses/digital-logic-t01'));
    core = new CourseService(join(__dirname, 'worker.cjs'));
    agent = new AgentRuntime(core, { directory: join(app.getPath('userData'), 'agent-runtime'), cliPath: process.env.YIZHI_CODEX_PATH });
    description = new DescriptionRuntime(core, { directory: join(app.getPath('userData'), 'search-runtime'), cliPath: process.env.YIZHI_CODEX_PATH });
    void agent.detect();
    host=new LearningHost(core,agent,description,courseDirectory,__dirname);
    const checkSender=host.sender;
    registerExtensionProtocol(core);
    registerSourceProtocols(core, join(__dirname, 'renderer'));
    registerSourceIPC(core, checkSender);
    registerExchangeIPC(core, checkSender);
    registerAgentIPC(core, agent, checkSender);
    ipcMain.handle('description:status', event => { checkSender(event); return description.status(); });
    for (const method of ['start', 'get', 'cancel'] as const) ipcMain.handle(`description:${method}`, (event, request) => { checkSender(event); return description[method](request); });
    for (const method of ['start','continue','stop','get','list','artifact','artifacts','correct','query'] as const) {
      ipcMain.handle(`parsing:${method}`, (event, request) => { checkSender(event);if(method==='start'||method==='continue')host.assertTaskAdmission(); return core.parsing[method](request); });
    }
    for (const method of drawingMethods) ipcMain.handle(`drawings:${method}`, (event, request) => { checkSender(event); return core.drawings[method](request); });
    for (const method of searchMethods) ipcMain.handle(`search:${method}`, (event, request) => { checkSender(event); return core.search[method](request); });
    for (const method of annotationMethods) ipcMain.handle(`annotations:${method}`, (event, request) => { checkSender(event); return core.annotations[method](request); });
    for (const method of ['open','read','act'] as const) ipcMain.handle(`extensions:${method}`, (event,payload) => {checkSender(event);return core.extensions[method](payload);});
    ipcMain.handle('course:open',host.open);
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
    for(const method of ['list','detail','preview','query'] as const)ipcMain.handle(`formalHistory:${method}`,(event,request)=>{checkSender(event);return core.formalHistory[method](request);});
  ipcMain.handle('formalHistory:apply',async(event,request)=>{
    checkSender(event);
    const existing=await core.formalHistory.query({sessionId:request.sessionId,operationId:request.operationId});
    if(!existing&&request.preview.kind==='undo') {
      const current=await core.formalHistory.preview({sessionId:request.sessionId,selection:request.preview.selection});
      for(const taskId of current.runningTaskIds)await agent.stop({sessionId:request.sessionId,taskId});
    }
    return core.formalHistory.apply(request);
  });
  ipcMain.handle('course:commitEdit', (event, command) => { checkSender(event); return core.commitEdit(command); });
    ipcMain.handle('course:queryOperation', (event, input) => { checkSender(event); return core.queryOperation(input.sessionId, input.operationId); });
    ipcMain.handle('course:readEvents', (event, input) => { checkSender(event); return core.readEvents(input.sessionId, input.after, input.limit); });
    ipcMain.handle('course:read', (event, input) => { checkSender(event); return core.read(input.sessionId); });
    for (const method of ['open', 'read', 'snapshot', 'act', 'pauseAll'] as const) {
      ipcMain.handle(`experiments:${method}`, (event, payload) => { checkSender(event); return core.experiments[method](payload); });
    }
    for (const method of ['protect', 'releaseView', 'recheck', 'resolveInput', 'resolveCandidate', 'startAttempt', 'read', 'commit', 'stop', 'query', 'candidates', 'history'] as const) {
      ipcMain.handle(`commands:${method}`, (event, payload) => { checkSender(event);if(method==='startAttempt')host.assertTaskAdmission(); return core.commands[method](payload); });
    }
    for (const method of ['read', 'commit', 'query', 'prerequisites'] as const) {
      ipcMain.handle(`relations:${method}`, (event, payload) => { checkSender(event); return core.relations[method](payload); });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '绎知', submenu: [{ role: 'about' }, { type: 'separator' },
        { label: '退出绎知', accelerator: 'Cmd+Q', click: () => app.quit() }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      {label:'课程',submenu:[{label:'打开课程…',click:()=>void host.chooseCourse()}]},
      { label: '窗口', submenu: [{ role: 'minimize' }, { label: '继续阅读', click: () => void host.show() }, {label:'恢复无响应窗口',click:()=>void host.recover()}] },
    ]));
    await host.show();
  }).catch(error => { dialog.showErrorBox('无法打开绎知', String(error)); app.exit(1); });
  app.on('activate', () => { if (host && !host.exiting) void host.show(); });
  // A learning window is a client; closing it must not end the host-owned core.
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {if(host?.exiting)return;event.preventDefault();if(host)void host.quit();});
}
