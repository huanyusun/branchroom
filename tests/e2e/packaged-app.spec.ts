import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {join} from 'node:path';

const exec = promisify(execFile);
const packagedBinary = join(process.cwd(), 'dist/mac/Branchroom.app/Contents/MacOS/Branchroom');
const packagedAvailable = existsSync(packagedBinary);

test.describe('打包产物验证', () => {
  test.skip(!packagedAvailable, '未找到 dist/mac/Branchroom.app，先运行 bun run package:mac');

  /** 对正式打包的应用做一次真实启动：打开仓库 → 关闭 → 重开。 */
  test('packaged app launches, opens a repository, and relaunches', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-packaged-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-打包验证-'));
    await exec('git', ['init', '-q', repoRoot]);

    const launch = async (): Promise<{app: ElectronApplication; page: Page}> => {
      const app = await _electron.launch({
        executablePath: packagedBinary,
        args: [],
        env: {...process.env, BRANCHROOM_USER_DATA_DIR: userData}
      });
      const page = await app.firstWindow();
      await page.waitForSelector('main.app-shell');
      return {app, page};
    };

    let app: ElectronApplication | null = null;
    try {
      const first = await launch();
      app = first.app;
      const page = first.page;
      await app.evaluate(
        ({dialog}, path) => {
          const fake = async (): Promise<{canceled: boolean; filePaths: string[]}> => ({
            canceled: false,
            filePaths: [path]
          });
          (dialog as unknown as {showOpenDialog: unknown}).showOpenDialog = fake;
        },
        repoRoot
      );
      await page.getByRole('button', {name: '打开本地仓库…'}).click();
      await expect(page.locator('[aria-label="仓库身份摘要"]')).toBeVisible();
      await expect(page.locator('[aria-label="仓库身份摘要"]')).toContainText('branchroom-打包验证-');
      // 打包环境下应通过自定义协议加载，而不是远程脚本
      expect(page.url().startsWith('branchroom://app/')).toBe(true);
      await app.close();
      app = null;

      // 重开后最近列表保留该仓库
      const second = await launch();
      app = second.app;
      const reopened = second.page;
      await expect(reopened.locator('section[aria-label="最近仓库"]')).toBeVisible();
      await expect(reopened.locator('section[aria-label="最近仓库"]')).toContainText('branchroom-打包验证-');
    } finally {
      if (app) await app.close().catch(() => undefined);
      await rm(userData, {recursive: true, force: true});
      await rm(repoRoot, {recursive: true, force: true});
    }
  });
});
