import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

async function mockOpenDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(
    ({dialog}, path) => {
      const fake = async (): Promise<{canceled: boolean; filePaths: string[]}> => ({
        canceled: false,
        filePaths: [path]
      });
      (dialog as unknown as {showOpenDialog: unknown}).showOpenDialog = fake;
    },
    filePath
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

interface Fixture {
  repoRoot: string;
  appendToApp: () => Promise<void>;
}

/** 构造包含修改/未跟踪/删除/二进制的临时仓库；写入都发生在 fixture 内。 */
async function createFixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-changes-'));
  await exec('git', ['init', '-q', '-b', 'main', repoRoot]);
  await mkdir(join(repoRoot, 'src'), {recursive: true});
  await writeFile(join(repoRoot, 'src/app.ts'), '第一行\nfunction app() {\n  return 1;\n}\n', 'utf8');
  await writeFile(join(repoRoot, 'gone.txt'), '将被删除\n', 'utf8');
  await writeFile(join(repoRoot, 'logo.bin'), Buffer.from([0x41, 0x00, 0x42]));
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: repoRoot});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: repoRoot});

  // 工作区变更：修改 + 长中文行、未跟踪文档、已暂存删除、二进制修改
  await writeFile(
    join(repoRoot, 'src/app.ts'),
    '第一行\nfunction app() {\n  return 42; // 修改后的实现，附一段非常长的中文说明文字用于验证换行时左右两侧仍然逐行对齐不会错位\n}\n\nfunction extra() {\n  return 7;\n}\n',
    'utf8'
  );
  await exec('git', ['rm', '-q', 'gone.txt'], {cwd: repoRoot});
  await mkdir(join(repoRoot, 'docs'), {recursive: true});
  await writeFile(join(repoRoot, 'docs/新文档.md'), '# 新文档\n内容行一\n内容行二\n', 'utf8');
  await writeFile(join(repoRoot, 'logo.bin'), Buffer.from([0x41, 0x00, 0x43]));

  return {
    repoRoot,
    appendToApp: async () => {
      await writeFile(
        join(repoRoot, 'src/app.ts'),
        '第一行\nfunction app() {\n  return 42; // 修改后的实现，附一段非常长的中文说明文字用于验证换行时左右两侧仍然逐行对齐不会错位\n}\n\nfunction extra() {\n  return 10086;\n}\n\n// 刷新后新增的行\n',
        'utf8'
      );
    }
  };
}

test.describe('变更阅读（BR-002 验收流程）', () => {
  test('文件列表、对齐 Diff、单栏新增、删除与二进制提示、刷新', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const fixture = await createFixture();
    const {app, page} = await launchApp(userData);
    try {
      await mockOpenDialog(app, fixture.repoRoot);
      await page.getByRole('button', {name: '打开本地仓库…'}).click();

      const workspace = page.locator('[data-testid="workspace"]');
      await expect(workspace).toBeVisible();

      // 文件列表：四个真实变更（含不可审阅但必须显示的二进制），路径含中文
      const items = page.locator('[data-testid="file-item"]');
      await expect(items).toHaveCount(4);
      await expect(items.filter({hasText: 'docs/'})).toContainText('新文档.md');
      await expect(items.filter({hasText: 'gone.txt'})).toContainText('D');
      await expect(items.filter({hasText: 'logo.bin'})).toBeVisible();
      await expect(items.filter({hasText: 'app.ts'})).toContainText('+');

      // 默认选中排序后的第一个：docs/新文档.md → 新增文件单栏，不浪费左半屏
      await expect(page.locator('[data-testid="diff-single"]')).toBeVisible();
      await expect(page.locator('[data-testid="diff-aligned"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="diff-single"]')).toContainText('内容行一');

      // 修改文件 → 对齐双栏，修改行成对出现
      await items.filter({hasText: 'app.ts'}).click();
      const aligned = page.locator('[data-testid="diff-aligned"]');
      await expect(aligned).toBeVisible();
      await expect(aligned).toContainText('return 42');
      await expect(aligned).toContainText('return 1');

      // 删除文件 → 单栏红色基线内容
      await items.filter({hasText: 'gone.txt'}).click();
      await expect(page.locator('[data-testid="diff-single"]')).toBeVisible();
      await expect(page.locator('[data-testid="diff-single"]')).toContainText('将被删除');

      // 二进制文件 → 明确原因，不消失
      await items.filter({hasText: 'logo.bin'}).click();
      await expect(page.locator('.unavailable-notice')).toContainText('二进制');

      // 全文视图
      await items.filter({hasText: 'app.ts'}).click();
      await page.getByRole('button', {name: '全文'}).click();
      await expect(page.locator('[data-testid="diff-fulltext"]')).toContainText('return 42');
      await page.getByRole('button', {name: '对比'}).click();
      await expect(page.locator('[data-testid="diff-aligned"]')).toBeVisible();

      // 刷新读取磁盘上的新修改
      await fixture.appendToApp();
      await page.getByRole('button', {name: '刷新'}).click();
      await expect(page.locator('[data-testid="diff-aligned"]')).toContainText('刷新后新增的行');
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
      await rm(fixture.repoRoot, {recursive: true, force: true});
    }
  });

  test('干净仓库显示无变更，快照时间可见', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-e2e-userdata-'));
    const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-clean-'));
    await exec('git', ['init', '-q', '-b', 'main', repoRoot]);
    await writeFile(join(repoRoot, 'readme.md'), '只有一次提交\n', 'utf8');
    await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: repoRoot});
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'init'], {cwd: repoRoot});

    const {app, page} = await launchApp(userData);
    try {
      await mockOpenDialog(app, repoRoot);
      await page.getByRole('button', {name: '打开本地仓库…'}).click();
      await expect(page.locator('.workspace-status')).toContainText('没有变更');
      await expect(page.locator('.snapshot-meta')).toContainText('0 个变更');
    } finally {
      await app.close();
      await rm(userData, {recursive: true, force: true});
      await rm(repoRoot, {recursive: true, force: true});
    }
  });
});
