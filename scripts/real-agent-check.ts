// 真实 CLI 验证脚本（手动运行，不属于默认测试）：bun scripts/real-agent-check.ts [provider]
// 在临时 fixture 仓库上发起一次真实 Agent Review，打印元数据与意见标题；
// 不写入任何仓库文件，不输出凭据或完整报告正文。
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository, RepositoryRegistry } from '../src/main/services/repositories';
import { buildSnapshot } from '../src/main/services/snapshots';
import { SnapshotRegistry } from '../src/main/services/review-service';
import { RunManager } from '../src/main/services/review-runs';

const exec = promisify(execFile);
const provider = (process.argv[2] ?? 'codex') as 'codex' | 'claude';
const GIT = ['-c', 'user.name=Real Check', '-c', 'user.email=real@check.invalid'];

// fixture：一个真实缺陷（未处理的 promise rejection + 资源未释放），供 Agent 发现
async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'branchroom-real-agent-'));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(
    join(root, 'fetch-retry.ts'),
    [
      'export async function fetchWithRetry(url: string, retries = 3): Promise<string> {',
      '  for (let attempt = 0; attempt < retries; attempt++) {',
      '    const response = await fetch(url);',
      '    if (response.ok) return response.text();',
      '  }',
      '  return "";',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  await exec('git', [...GIT, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT, 'commit', '-q', '-m', 'base'], {cwd: root});
  await writeFile(
    join(root, 'fetch-retry.ts'),
    [
      'export async function fetchWithRetry(url: string, retries = 3): Promise<string> {',
      '  for (let attempt = 0; attempt < retries; attempt++) {',
      '    const controller = new AbortController();',
      '    const timer = setTimeout(() => controller.abort(), 5000);',
      '    const response = await fetch(url, {signal: controller.signal});',
      '    if (response.ok) {',
      '      return response.text();',
      '    }',
      '  }',
      '  return "";',
      '}',
      ''
    ].join('\n'),
    'utf8'
  );
  return root;
}

const root = await makeFixture();
const repo = await openRepository(root);
const registry = new RepositoryRegistry();
registry.remember(repo);
const snapshots = new SnapshotRegistry();
const snapshot = await buildSnapshot(repo);
snapshots.remember(snapshot);

const workspace = await mkdtemp(join(tmpdir(), 'branchroom-real-agent-runs-'));
const manager = new RunManager({
  runsDir: join(workspace, 'runs'),
  configDir: workspace, // 无 agent-settings.json → PATH 检测真实 CLI
  registry,
  snapshots,
  onUpdate: (run) => {
    if (run.status === 'running') console.error(`[real-agent-check] ${provider} running…`);
  }
});
await manager.init();

const startedAt = Date.now();
const run = await manager.startReview({
  repoId: repo.id,
  snapshotId: snapshot.id,
  fileIds: snapshot.files.map((file) => file.id),
  provider
});
const settled = await manager.waitForSettled(run.id, 8 * 60 * 1000);
const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

console.log(JSON.stringify({
  provider,
  status: settled.status,
  errorCode: settled.error?.code ?? null,
  elapsedSeconds,
  fileCount: settled.fileIds.length,
  findingCount: settled.report?.findings.length ?? null,
  coverage: settled.report?.coverage ?? null,
  findingTitles: settled.report?.findings.map((finding) => `[${finding.priority} ${finding.kind}] ${finding.fileId}:${finding.startLine} ${finding.title}`) ?? []
}, null, 2));

await rm(root, {recursive: true, force: true});
await rm(workspace, {recursive: true, force: true});
if (settled.status !== 'succeeded') process.exit(1);
