import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

interface Fixture {
  repoRoot: string;
  write: (name: string, content: string) => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-staging-e2e-'));
  await exec('git', ['init', '-q', '-b', 'main', repoRoot]);
  // 真实用户仓库会有提交身份配置（仓库级）；正式实现不注入伪造身份
  await exec('git', ['config', 'user.name', 'Branchroom Test'], {cwd: repoRoot});
  await exec('git', ['config', 'user.email', 'branchroom@example.invalid'], {cwd: repoRoot});
  await writeFile(join(repoRoot, 'a.ts'), 'a-v1\n', 'utf8');
  await writeFile(join(repoRoot, 'b.ts'), 'b-v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: repoRoot});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: repoRoot});
  await writeFile(join(repoRoot, 'a.ts'), 'a-v2\n', 'utf8');
  await writeFile(join(repoRoot, 'b.ts'), 'b-v2\n', 'utf8');
  await writeFile(join(repoRoot, '新文件.md'), '新增内容\n', 'utf8');
  return {
    repoRoot,
    write: async (name, content) => {
      await writeFile(join(repoRoot, name), content, 'utf8');
    }
  };
}

async function launchApp(userData: string): Promise<{app: ElectronApplication; page: Page}> {
  const app = await _electron.launch({
    args: [join(process.cwd(), 'out/main/index.js')],
    env: {...process.env, BRANCHROOM_USER_DATA_DIR: userData}
  });
  const page = await app.firstWindow();
  await page.waitForSelector('main.app-shell');
  return {app, page};
}

test.describe('暂存与提交（BR-006 验收流程）', () => {
  test('暂存 → 提交预览 → 提交已暂存 → git 历史可查；提交目标明确为本地仓库', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-staging-e2e-userdata-'));
    const fixture = await createFixture();
    const {app, page} = await launchApp(userData);
    try {
      await app.evaluate(
        ({dialog}, path) => {
          const fake = async (): Promise<{canceled: boolean; filePaths: string[]}> => ({
            canceled: false,
            filePaths: [path]
          });
          (dialog as unknown as {showOpenDialog: unknown}).showOpenDialog = fake;
        },
        fixture.repoRoot
      );
      await page.getByRole('button', {name: '打开本地仓库…'}).click();
      await page.waitForSelector('[data-testid="workspace"]');

      // 暂存其中两个文件
      await page.locator('[data-testid="file-item"]', {hasText: 'a.ts'}).getByRole('button', {name: '暂存'}).click();
      await page.locator('[data-testid="file-item"]', {hasText: '新文件.md'}).getByRole('button', {name: '暂存'}).click();
      // 暂存后 a.ts 出现取消暂存入口
      await expect(
        page.locator('[data-testid="file-item"]', {hasText: 'a.ts'}).getByRole('button', {name: '取消暂存'})
      ).toBeVisible();

      // 提交预览反映暂存集合
      const commitBar = page.locator('section[aria-label="提交"]');
      await expect(commitBar).toContainText('将提交 2 个已暂存文件');

      await commitBar.locator('.commit-message').fill('e2e：提交 a 与新文档');
      await commitBar.getByRole('button', {name: '提交已暂存'}).click();
      await expect(commitBar.locator('.commit-result')).toContainText('已提交', {timeout: 10_000});

      // git 历史真实存在；未提交文件仍在工作区
      const {stdout: log} = await exec('git', ['log', '--format=%s', '-1'], {cwd: fixture.repoRoot});
      expect(log.trim()).toBe('e2e：提交 a 与新文档');
      const status = await exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'], {cwd: fixture.repoRoot});
      expect(status.stdout).toContain('b.ts');
      expect(status.stdout).not.toContain('a.ts');
      expect(status.stdout).not.toContain('新文件.md');

      // 提交后快照刷新：a.ts / 新文件.md 不再出现在变更列表
      await expect(page.locator('[data-testid="file-item"]', {hasText: 'a.ts'})).toHaveCount(0);
      await expect(page.locator('[data-testid="file-item"]', {hasText: 'b.ts'})).toBeVisible();
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
      await rm(fixture.repoRoot, {recursive: true, force: true});
    }
  });

  test('提交所选文件直接提交该文件当前内容；空信息被禁用', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-staging-e2e-userdata-'));
    const fixture = await createFixture();
    const {app, page} = await launchApp(userData);
    try {
      await app.evaluate(
        ({dialog}, path) => {
          const fake = async (): Promise<{canceled: boolean; filePaths: string[]}> => ({
            canceled: false,
            filePaths: [path]
          });
          (dialog as unknown as {showOpenDialog: unknown}).showOpenDialog = fake;
        },
        fixture.repoRoot
      );
      await page.getByRole('button', {name: '打开本地仓库…'}).click();
      await page.waitForSelector('[data-testid="workspace"]');

      await page.locator('[data-testid="file-item"]', {hasText: 'b.ts'}).click();
      const commitBar = page.locator('section[aria-label="提交"]');

      // 空信息必须禁用（明确要求非空提交信息）
      await expect(commitBar.getByRole('button', {name: '提交所选文件'})).toBeDisabled();

      await commitBar.locator('.commit-message').fill('e2e：文件级提交 b');
      await commitBar.getByRole('button', {name: '提交所选文件'}).click();
      await expect(commitBar.locator('.commit-result')).toContainText('已提交', {timeout: 10_000});

      const {stdout: names} = await exec('git', ['show', '--name-only', '--format='], {cwd: fixture.repoRoot});
      expect(names.trim()).toBe('b.ts');
      const status = await exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'], {cwd: fixture.repoRoot});
      expect(status.stdout).toContain('a.ts');
      expect(status.stdout).not.toContain('b.ts');
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
      await rm(fixture.repoRoot, {recursive: true, force: true});
    }
  });
});
