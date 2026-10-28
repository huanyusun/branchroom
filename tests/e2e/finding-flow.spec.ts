import {_electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

// 假 CLI：返回带完整 body/evidence/suggestion 的意见，便于验证采纳文本组装
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
  limitations: [],
  findings: unique.map((p) => ({
    kind: 'verify', severity: 'P2', path: p, start_line: 2, end_line: 2,
    title: '需确认的错误处理约定',
    body: '当响应非 2xx 时仍会尝试解析 JSON，可能掩盖真实错误。',
    evidence: '第 2 行直接调用 res.json()。',
    suggestion: '先检查 response.ok 再解析。'
  }))
};
fs.writeFileSync(outPath, JSON.stringify(report));
`;

interface Fixture {
  userData: string;
  repoRoot: string;
  modifyFile: (content: string) => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const userData = await mkdtemp(join(tmpdir(), 'branchroom-finding-e2e-'));
  const repoRoot = join(userData, 'fixture-repo');
  await mkdir(repoRoot, {recursive: true});
  await exec('git', ['init', '-q', '-b', 'main', repoRoot]);
  await writeFile(join(repoRoot, 'app.ts'), 'v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: repoRoot});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: repoRoot});
  await writeFile(join(repoRoot, 'app.ts'), 'line1\nline2\nline3\n', 'utf8');

  const fakeCliPath = join(userData, 'fake-codex.cjs');
  await writeFile(fakeCliPath, FAKE_CODEX, 'utf8');
  await chmod(fakeCliPath, 0o755);
  await writeFile(
    join(userData, 'agent-settings.json'),
    JSON.stringify({schemaVersion: 1, executablePaths: {codex: fakeCliPath}})
  );
  return {
    userData,
    repoRoot,
    modifyFile: async (content) => {
      await writeFile(join(repoRoot, 'app.ts'), content, 'utf8');
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

async function openRepo(app: ElectronApplication, page: Page, repoRoot: string): Promise<void> {
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
  await page.waitForSelector('[data-testid="workspace"]');
}

test.describe('意见定位与采纳（BR-005 验收流程）', () => {
  test('一击定位到行并高亮；采纳仅产生草稿且绑定内容', async () => {
    const fixture = await createFixture();
    const {app, page} = await launchApp(fixture.userData);
    try {
      await openRepo(app, page, fixture.repoRoot);

      const panel = page.locator('section[aria-label="Agent Review"]');
      await panel.getByRole('button', {name: /审查全部变更/}).click();
      const finding = panel.locator('.finding-item').first();
      await expect(finding).toBeVisible({timeout: 20_000});

      // 一击定位：点击意见 → 打开文件并滚动高亮到对应行
      await finding.click();
      await expect(page.locator('.diff-path')).toHaveText('app.ts');
      const focused = page.locator('.diff-row.focus-line');
      await expect(focused).toHaveCount(1);
      await expect(focused).toContainText('line2');

      // 展开详情：issue/verify 区分 + 依据/建议可见
      await expect(panel.locator('.finding-detail')).toContainText('verify');
      await expect(panel.locator('.finding-detail')).toContainText('先检查 response.ok 再解析。');

      // 采纳 → 仅产生草稿，不写仓库、不直接变成结论
      await panel.getByRole('button', {name: '采纳为反馈草稿'}).click();
      await expect(page.locator('.review-note')).toHaveValue(/先检查 response\.ok 再解析。/);
      await expect(page.locator('.review-hint')).toContainText('草稿已保存', {timeout: 5000});
      // 仓库工作区文件内容未被改动（采纳只写草稿）
      const {stdout} = await exec('git', ['status', '--porcelain'], {cwd: fixture.repoRoot});
      expect(stdout).toContain(' M app.ts'); // 只有原有审查对象变更，无新增改动
      expect(stdout.split('\n').filter(Boolean)).toHaveLength(1);
    } finally {
      await app.close();
      await rm(fixture.userData, {recursive: true, force: true});
    }
  });

  test('内容变化后旧意见标为过期并阻止直接采纳；只复审待复审文件', async () => {
    const fixture = await createFixture();
    const {app, page} = await launchApp(fixture.userData);
    try {
      await openRepo(app, page, fixture.repoRoot);
      const panel = page.locator('section[aria-label="Agent Review"]');
      await panel.getByRole('button', {name: /审查全部变更/}).click();
      await expect(panel.locator('.finding-item').first()).toBeVisible({timeout: 20_000});

      // 内容变化 + 刷新：意见基于旧指纹 → 列表标记"旧"，展开详情后有阻止横幅且采纳禁用
      await fixture.modifyFile('line1\n被修改的 line2\nline3\n');
      await page.getByRole('button', {name: '刷新'}).click();
      await expect(panel.locator('.finding-stale-tag').first()).toBeVisible();
      await panel.locator('.finding-item').first().click();
      await expect(panel.locator('.finding-stale-banner')).toContainText('旧版本');
      await expect(panel.getByRole('button', {name: '采纳为反馈草稿'})).toBeDisabled();

      // 待复审文件筛选：先标记已审查，内容变化后产生 recheck → 一键复审只针对该文件
      await page.locator('[data-testid="file-item"]', {hasText: 'app.ts'}).click();
      await page.getByRole('button', {name: '✓ 已审查'}).click();
      await expect(page.locator('.review-state-label')).toContainText('已审查');
      await fixture.modifyFile('line1\n再次修改的 line2\nline3\n');
      await page.getByRole('button', {name: '刷新'}).click();
      await expect(page.locator('.review-state-label')).toContainText('待复审');

      const reviewButton = panel.getByRole('button', {name: /复审待复审文件（1）/});
      await expect(reviewButton).toBeEnabled();
      await reviewButton.click();
      await expect(panel.locator('.run-history-item').first()).toContainText('succeeded', {timeout: 20_000});
      // 新 run 的意见基于当前内容：没有"旧"标记，可以直接采纳
      await expect(panel.locator('.finding-stale-tag')).toHaveCount(0);
      await panel.locator('.finding-item').first().click();
      await expect(panel.getByRole('button', {name: '采纳为反馈草稿'})).toBeEnabled();
    } finally {
      await app.close();
      await rm(fixture.userData, {recursive: true, force: true});
    }
  });
});
