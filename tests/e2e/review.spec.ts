import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
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
  changeFile: (content: string) => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'branchroom-review-e2e-'));
  await exec('git', ['init', '-q', '-b', 'main', repoRoot]);
  await writeFile(join(repoRoot, 'app.ts'), 'v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: repoRoot});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: repoRoot});
  await writeFile(join(repoRoot, 'app.ts'), 'v2\n', 'utf8');
  return {
    repoRoot,
    changeFile: async (content) => {
      await writeFile(join(repoRoot, 'app.ts'), content, 'utf8');
    }
  };
}

async function openByDialog(app: ElectronApplication, page: Page, repoRoot: string): Promise<void> {
  await mockOpenDialog(app, repoRoot);
  const button = page.getByRole('button', {name: '打开本地仓库…'});
  if (await button.isVisible()) {
    await button.click();
  }
  await page.waitForSelector('[data-testid="workspace"]');
}

test.describe('人工审查持久化（BR-003 验收流程）', () => {
  test('标记已审查与反馈在重启后恢复', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-review-e2e-'));
    const fixture = await createFixture();
    const first = await launchApp(userData);
    try {
      await openByDialog(first.app, first.page, fixture.repoRoot);
      await first.page.locator('[data-testid="file-item"]', {hasText: 'app.ts'}).click();
      await first.page.locator('.review-note').fill('结论：改动符合预期');
      await first.page.getByRole('button', {name: '✓ 已审查'}).click();
      await expect(first.page.locator('.review-state-label')).toContainText('已审查');
      await expect(first.page.locator('[data-testid="file-item"]').first()).toContainText('✓');
      await first.app.close();

      // 重启后恢复
      const second = await launchApp(userData);
      try {
        const recent = second.page.locator('section[aria-label="最近仓库"]');
        await recent.getByRole('button', {name: '打开', exact: true}).click();
        await second.page.waitForSelector('[data-testid="workspace"]');
        await expect(second.page.locator('.review-state-label')).toContainText('已审查');
        await expect(second.page.locator('.review-note')).toHaveValue('结论：改动符合预期');
        await expect(second.page.locator('.review-glyph').first()).toContainText('✓');
      } finally {
        await second.app.close();
      }
    } finally {
      await first.app.close().catch(() => undefined);
      await rm(userData, {recursive: true, force: true});
      await rm(fixture.repoRoot, {recursive: true, force: true});
    }
  });

  test('草稿自动保存并在重启后恢复；内容变化后标为待复审', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-review-e2e-'));
    const fixture = await createFixture();
    const first = await launchApp(userData);
    try {
      await openByDialog(first.app, first.page, fixture.repoRoot);
      await first.page.locator('[data-testid="file-item"]', {hasText: 'app.ts'}).click();
      await first.page.locator('.review-note').fill('未保存的草稿内容');
      await expect(first.page.locator('.review-hint')).toContainText('草稿已保存', {timeout: 5000});
      await first.app.close();

      const second = await launchApp(userData);
      try {
        const recent = second.page.locator('section[aria-label="最近仓库"]');
        await recent.getByRole('button', {name: '打开', exact: true}).click();
        await second.page.waitForSelector('[data-testid="workspace"]');
        await expect(second.page.locator('.review-note')).toHaveValue('未保存的草稿内容');

        // 只有草稿、没有标记时：内容变化不产生 recheck，但草稿要标出已过期
        await fixture.changeFile('v3\n');
        await second.page.getByRole('button', {name: '刷新'}).click();
        await expect(second.page.locator('.review-state-label')).toContainText('未审查');
        await expect(second.page.locator('.review-banner')).toContainText('草稿对应的文件内容已变化');

        // 刷新后基于新内容正式标记（草稿转为正式记录）
        await second.page.getByRole('button', {name: '✓ 已审查'}).click();
        await expect(second.page.locator('.review-state-label')).toContainText('已审查');

        // 再次修改磁盘但先不刷新：基于过期快照的保存必须被拒绝且明确提示
        await fixture.changeFile('v4\n');
        await second.page.getByRole('button', {name: '✓ 已审查'}).click();
        const alert = second.page.locator('.review-error');
        await expect(alert).toBeVisible();
        await expect(alert).toContainText('content_changed');

        // 刷新后派生待复审，旧结论保留为参考
        await second.page.getByRole('button', {name: '刷新'}).click();
        await expect(second.page.locator('.review-state-label')).toContainText('待复审');
        await expect(second.page.locator('.review-glyph').first()).toContainText('↻');
        await expect(second.page.locator('.review-banner')).toContainText('此前的标记基于旧内容');
      } finally {
        await second.app.close();
      }
    } finally {
      await first.app.close().catch(() => undefined);
      await rm(userData, {recursive: true, force: true});
      await rm(fixture.repoRoot, {recursive: true, force: true});
    }
  });

  test('主仓库与 linked worktree 的审查记录互不串扰', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'branchroom-review-e2e-'));
    const fixture = await createFixture();
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'anchor'], {cwd: fixture.repoRoot});
    const worktreePath = join(fixture.repoRoot, '..', 'branchroom-review-e2e-wt');
    await exec('git', ['worktree', 'add', '-q', '-b', 'topic', worktreePath, 'HEAD'], {cwd: fixture.repoRoot});
    await writeFile(join(worktreePath, 'app.ts'), 'v1\n', 'utf8');
    await writeFile(join(worktreePath, 'app.ts'), 'v1\nwt 修改\n', 'utf8');
    try {
      const first = await launchApp(userData);
      await openByDialog(first.app, first.page, fixture.repoRoot);
      await first.page.locator('[data-testid="file-item"]', {hasText: 'app.ts'}).click();
      await first.page.getByRole('button', {name: '✓ 已审查'}).click();
      await expect(first.page.locator('.review-state-label')).toContainText('已审查');
      await first.app.close();

      const second = await launchApp(userData);
      try {
        await openByDialog(second.app, second.page, worktreePath);
        // worktree 是独立仓库：同样路径未审查
        await expect(second.page.locator('.review-state-label')).toContainText('未审查');
        await expect(second.page.locator('.review-glyph').first()).toContainText('○');
      } finally {
        await second.app.close();
      }
    } finally {
      await exec('git', ['worktree', 'remove', '--force', worktreePath], {cwd: fixture.repoRoot}).catch(() => undefined);
      await rm(userData, {recursive: true, force: true}).catch(() => undefined);
      await rm(worktreePath, {recursive: true, force: true}).catch(() => undefined);
      await rm(fixture.repoRoot, {recursive: true, force: true});
    }
  });
});
