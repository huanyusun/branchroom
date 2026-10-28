import { app, BrowserWindow, ipcMain } from 'electron';
import { join, resolve } from 'node:path';
import {
  applyContentSecurityPolicy,
  registerBranchroomProtocol,
  registerBranchroomScheme
} from './protocol';
import { registerRepositoryHandlers } from './ipc/handlers';
import { createRecentStore } from './services/recent-store';
import { RepositoryRegistry } from './services/repositories';

const isDev = !app.isPackaged;
const rendererRoot = join(import.meta.dirname, '../renderer');

// 自动化测试与 CI 可用此环境变量隔离 userData，避免污染真实用户数据。
// 仅影响主进程的存储位置，不改变 renderer 的安全边界。
const userDataOverride = process.env.BRANCHROOM_USER_DATA_DIR;
if (userDataOverride) {
  app.setPath('userData', resolve(userDataOverride));
}

registerBranchroomScheme();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 860,
    minHeight: 560,
    title: 'Branchroom',
    backgroundColor: '#1e1f22',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('page-title-updated', (event) => event.preventDefault());

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void window.loadURL('branchroom://app/index.html');
  }
  return window;
}

app.whenReady().then(() => {
  applyContentSecurityPolicy(isDev);
  registerBranchroomProtocol(rendererRoot);
  registerRepositoryHandlers(ipcMain, {
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    recentStore: createRecentStore(join(app.getPath('userData'), 'recent-repositories.json')),
    registry: new RepositoryRegistry(),
    isDev
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
