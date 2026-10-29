import { ipcMain } from 'electron';
import { join } from 'node:path';
import { startDesktop } from '../../desktop/src/host/desktop-runtime';

// This executable owns the development-only registration. Product main never imports it.
startDesktop({
  runtimeDirectory: __dirname,
  preloadPath: join(__dirname, 'controlled-preload.cjs'),
  rendererDirectory: join(__dirname, 'renderer'),
  registerDevelopmentIPC({ core, checkSender, assertTaskAdmission }) {
    for (const method of ['startAttempt', 'read', 'commit', 'stop'] as const) {
      ipcMain.handle(`commands:${method}`, (event, payload) => {
        checkSender(event);
        if (method === 'startAttempt') assertTaskAdmission();
        return core.commands[method](payload);
      });
    }
  },
});
