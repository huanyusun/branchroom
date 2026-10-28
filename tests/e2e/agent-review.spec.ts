import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

/** 假 Codex CLI：真实 codex 的行为子集（--version、读 stdin、写 result.json）。 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-codex 1.0.0'); process.exit(0); }
const outIdx = args.indexOf('--output-last-message');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const stdin = fs.readFileSync(0, 'utf8');
const unique = [...new Set([...stdin.matchAll(/"path":"([^"]+)"/g)].map((m) => m[1]))];
const report = {
  summary: 'fake 审查完成',
  coverage: unique,
  limitations: ['假 CLI 自动化验证'],
  findings: unique.length
    ? [{ kind: 'issue', severity: 'P1', path: unique[0], start_line: 1, end_line: 1,
         title: '自动化验证意见', body: '测试意见', evidence: 'fixture', suggestion: '测试建议' }]
    : []
};
fs.writeFileSync(outPath, JSON.stringify(report));
`;

interface Fixture {
  userData: string;
  repoRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const userData = await mkdtemp(join(tmpdir(), 'branchroom-agent-e2e-'));
  const repoRoot = join(userData, 'fixture-repo');
  await mkdir(repoRoot, {recursive: true});
  await exec('git', ['init', '-q', '-b', 'main', repoRoot]);
  await writeFile(join(repoRoot, 'app.ts'), 'v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: repoRoot});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: repoRoot});
  await writeFile(join(repoRoot, 'app.ts'), 'v2\n', 'utf8');

  // 假 CLI + 显式路径设置写入隔离 userData（产品功能：显式指定可执行文件）
  const fakeCliPath = join(userData, 'fake-codex.cjs');
  await writeFile(fakeCliPath, FAKE_CODEX, 'utf8');
  await chmod(fakeCliPath, 0o755);
  await writeFile(
    join(userData, 'agent-settings.json'),
    JSON.stringify({schemaVersion: 1, executablePaths: {codex: fakeCliPath}})
  );
  return {userData, repoRoot};
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

test.describe('Agent Review（BR-004 验收流程）', () => {
  test('能力检测、发起审查、意见定位与历史 run', async () => {
    const fixture = await createFixture();
    const {app, page} = await launchApp(fixture.userData);
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

      const panel = page.locator('section[aria-label="Agent Review"]');
      await expect(panel).toBeVisible();
      // 能力检测：显式路径 + --version → 可用
      await expect(panel).toContainText('codex · 可用 · fake-codex 1.0.0');

      // 发起整批审查
      await panel.getByRole('button', {name: /审查全部变更/}).click();
      const finding = panel.locator('.finding-item');
      await expect(finding.first()).toBeVisible({timeout: 20_000});
      await expect(panel).toContainText('自动化验证意见');
      await expect(panel).toContainText('app.ts:1');

      // 点击意见 → 定位到对应文件
      await finding.first().click();
      await expect(page.locator('.diff-path')).toHaveText('app.ts');

      // 历史 run 保留
      await expect(panel.locator('.run-history-item')).toHaveCount(1);
      await expect(panel.locator('.run-history-item').first()).toContainText('succeeded');
    } finally {
      await app.close();
      await rm(fixture.userData, {recursive: true, force: true});
    }
  });

  test('审查进行中可停止，历史记录保留 cancelled 状态', async () => {
    const fixture = await createFixture();
    // 换成慢速假 CLI：先写 --version 应答，再挂起
    const slowCli = join(fixture.userData, 'fake-slow.cjs');
    await writeFile(
      slowCli,
      `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('fake-slow 1.0.0'); process.exit(0); }\nsetTimeout(() => process.exit(0), 60000);\n`,
      'utf8'
    );
    await chmod(slowCli, 0o755);
    await writeFile(
      join(fixture.userData, 'agent-settings.json'),
      JSON.stringify({schemaVersion: 1, executablePaths: {codex: slowCli}})
    );

    const {app, page} = await launchApp(fixture.userData);
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

      const panel = page.locator('section[aria-label="Agent Review"]');
      await panel.getByRole('button', {name: /审查全部变更/}).click();
      await expect(panel).toContainText('Agent 正在分析快照…', {timeout: 10_000});

      await panel.getByRole('button', {name: '停止'}).click();
      await expect(panel.locator('.run-history-item').first()).toContainText('cancelled', {timeout: 10_000});
    } finally {
      await app.close();
      await rm(fixture.userData, {recursive: true, force: true});
    }
  });
});
