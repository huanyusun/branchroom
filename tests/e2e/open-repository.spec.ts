import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';

const exec = promisify(execFile);

interface DialogResult {
  canceled: boolean;
  filePaths: string[];
}

/** 在主进程内替换系统目录对话框；不向生产 renderer 添加任何测试后门。 */
async function mockOpenDialog(app: ElectronApplication, result: DialogResult): Promise<void> {
  await app.evaluate(
    ({dialog}, mocked) => {
      const fake = async (): Promise<DialogResult> => mocked;
      (dialog as unknown as {showOpenDialog: unknown}).showOpenDialog = fake;
    },
    result
  );
}

async function launchApp(userDataDir: string): Promise<{app: ElectronApplication; page: Page}> {
  const app = await _electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    env: {...process.env, BRANCHROOM_USER_DATA_DIR: userDataDir}
  });
  const page = await app.firstWindow();
  await page.waitForSelector('main.app-shell');
  return {app, page};
}

test.describe('打开仓库（BR-001 验收流程）', () => {
  test('显示暗色空状态与打开入口', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const {app, page} = await launchApp(userData);
    try {
      await expect(page.locator('.app-title')).toHaveText('Branchroom');
      await expect(page.getByRole('button', {name: '打开本地仓库…'})).toBeVisible();
      await expect(page.locator('section[aria-label="欢迎"] h1')).toHaveText('打开一个本地 Git 仓库开始审查');
      await expect(page.locator('section[aria-label="仓库身份"]')).toHaveCount(0);
      await expect(page.locator('.error-banner')).toHaveCount(0);
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
    }
  });

  test('取消选择不报错，停留在空状态', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const {app, page} = await launchApp(userData);
    try {
      await mockOpenDialog(app, {canceled: true, filePaths: []});
      await page.getByRole('button', {name: '打开本地仓库…'}).click();
      await expect(page.locator('section[aria-label="欢迎"]')).toBeVisible();
      await expect(page.locator('.error-banner')).toHaveCount(0);
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
    }
  });

  test('打开有效仓库显示真实身份，最近列表可重新打开', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    // 中文 + 空格路径是明确验收项
    const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-评审 仓库-'));
    await exec('git', ['init', '-q', repoRoot]);
    const {app, page} = await launchApp(userData);
    try {
      await mockOpenDialog(app, {canceled: false, filePaths: [repoRoot]});
      await page.getByRole('button', {name: '打开本地仓库…'}).click();

      const identity = page.locator('[aria-label="仓库身份摘要"]');
      await expect(identity).toBeVisible();
      const expectedName = basename((await exec('git', ['rev-parse', '--show-toplevel'], {cwd: repoRoot})).stdout.trim());
      await expect(identity).toContainText(expectedName);
      await expect(identity).toContainText('尚未创建提交'); // 分支真实但无 HEAD
      await expect(identity).toContainText('尚无提交');
      await app.close();

      // 重启后通过最近列表重新打开，回到工作区
      const second = await launchApp(userData);
      try {
        const recent = second.page.locator('section[aria-label="最近仓库"]');
        await expect(recent).toBeVisible();
        await expect(recent).toContainText(expectedName);
        await mockOpenDialog(second.app, {canceled: true, filePaths: []});
        await recent.getByRole('button', {name: '打开', exact: true}).click();
        await expect(second.page.locator('[data-testid="workspace"]')).toBeVisible();
        await expect(second.page.locator('[aria-label="仓库身份摘要"]')).toContainText(expectedName);
      } finally {
        await second.app.close().catch(() => undefined);
      }
    } finally {
      await app.close().catch(() => undefined);
      await rm(userData, {recursive: true, force: true});
      await rm(repoRoot, {recursive: true, force: true});
    }
  });

  test('非 Git 目录给出明确错误且不进入最近列表', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const notGit = await mkdtemp(join(tmpdir(), 'branchroom-e2e-notgit-'));
    const {app, page} = await launchApp(userData);
    try {
      await mockOpenDialog(app, {canceled: false, filePaths: [notGit]});
      await page.getByRole('button', {name: '打开本地仓库…'}).click();

      const banner = page.locator('.error-banner');
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('不是 Git 仓库');
      await expect(banner).toContainText('not_git_repository');
      await expect(page.locator('section[aria-label="仓库身份"]')).toHaveCount(0);
      await expect(page.locator('section[aria-label="最近仓库"]')).toHaveCount(0);
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
      await rm(notGit, {recursive: true, force: true});
    }
  });

  test('已删除路径在最近列表中标记失效，且可以被移除', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-即将删除-'));
    await exec('git', ['init', '-q', repoRoot]);
    const apps: ElectronApplication[] = [];
    const launch = async (): Promise<Page> => {
      const {app, page} = await launchApp(userData);
      apps.push(app);
      return page;
    };

    try {
      const first = await launch();
      await mockOpenDialog(apps[0]!, {canceled: false, filePaths: [repoRoot]});
      await first.getByRole('button', {name: '打开本地仓库…'}).click();
      await expect(first.locator('[aria-label="仓库身份摘要"]')).toBeVisible();
      await apps[0]!.close();

      // 目录从磁盘消失后重新启动
      await rm(repoRoot, {recursive: true, force: true});
      const second = await launch();
      const recent = second.locator('section[aria-label="最近仓库"]');
      await expect(recent).toBeVisible();
      const missingItem = recent.locator('li.missing');
      await expect(missingItem).toContainText('路径已失效');
      // 已失效条目仍能移除
      await missingItem.getByRole('button', {name: '移除'}).click();
      await expect(recent).toHaveCount(0);
      await apps[apps.length - 1]!.close();

      // 移除后重启不再出现
      const third = await launch();
      await expect(third.locator('section[aria-label="最近仓库"]')).toHaveCount(0);
    } finally {
      for (const app of apps.reverse()) await app.close().catch(() => undefined);
      await rm(userData, {recursive: true, force: true});
    }
  });

  test('renderer 没有任意系统调用入口，只有类型化 bridge', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const {app, page} = await launchApp(userData);
    try {
      const security = await page.evaluate(() => ({
        require: typeof (window as {require?: unknown}).require,
        process: typeof (window as {process?: unknown}).process,
        ipcRenderer: typeof (window as {ipcRenderer?: unknown}).ipcRenderer,
        electron: typeof (window as {electron?: unknown}).electron,
        bridgeKeys: Object.keys((window as {branchroom?: Record<string, unknown>}).branchroom ?? {})
      }));
      expect(security.require).toBe('undefined');
      expect(security.process).toBe('undefined');
      expect(security.ipcRenderer).toBe('undefined');
      expect(security.electron).toBe('undefined');
      expect([...security.bridgeKeys].sort()).toEqual([
        'chooseRepository',
        'clearDraft',
        'getSnapshot',
        'listRepositories',
        'listRepositoryEntries',
        'listReviewEntries',
        'openRepositoryPath',
        'removeRepository',
        'saveDraft',
        'saveReview'
      ]);
      const url = page.url();
      expect(url.startsWith('branchroom://app/')).toBe(true);
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
    }
  });
});
