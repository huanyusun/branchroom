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
import { createReviewStore } from './services/review-store';
import { ReviewService, SnapshotRegistry } from './services/review-service';
import { RunManager } from './services/review-runs';

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

let runManager: RunManager | null = null;

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
  const userData = app.getPath('userData');
  const registry = new RepositoryRegistry();
  const snapshots = new SnapshotRegistry();
  const reviewStore = createReviewStore(join(userData, 'reviews'));
  const reviewService = new ReviewService(reviewStore, snapshots, registry);
  // run 状态推送给所有窗口；renderer 通过 onReviewRun 订阅
  runManager = new RunManager({
    runsDir: join(userData, 'agent-runs'),
    configDir: userData,
    registry,
    snapshots,
    onUpdate: (run) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('branchroom:review-run-event', run);
      }
    }
  });
  void runManager.init().catch((error) => console.warn('[branchroom] run 恢复失败', error));
  registerRepositoryHandlers(ipcMain, {
    getWindow: () => BrowserWindow.getAllWindows()[0] ?? null,
    recentStore: createRecentStore(join(userData, 'recent-repositories.json')),
    registry,
    reviewService,
    runManager,
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

// 生命周期约定（CONTEXT.md 不变量 8）：退出前终止自己创建的整棵 CLI 进程树
app.on('before-quit', () => {
  runManager?.cancelAllActive();
});
