import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository, RepositoryRegistry } from '../../src/main/services/repositories';
import { buildSnapshot } from '../../src/main/services/snapshots';
import { SnapshotRegistry } from '../../src/main/services/review-service';
import { RunManager } from '../../src/main/services/review-runs';
import type { Repository, ReviewRun } from '../../src/shared/contracts';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

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
  limitations: ['假 CLI'],
  findings: unique.length
    ? [{ kind: 'issue', severity: 'P2', path: unique[0], start_line: 1, end_line: 1,
         title: 'fake finding', body: '自动化验证', evidence: 'fake evidence', suggestion: 'fake' }]
    : []
};
fs.writeFileSync(outPath, JSON.stringify(report));
`;

const FAKE_AUTH_FAIL = `#!/bin/bash
if [ "$1" = "--version" ]; then echo 'fake-auth 1.0.0'; exit 0; fi
echo "错误：not logged in，请先登录" >&2
exit 2
`;

const FAKE_MODEL_FAIL = `#!/bin/bash
if [ "$1" = "--version" ]; then echo 'fake-model 1.0.0'; exit 0; fi
echo 'fatal: unrecognized_model: glm-5.3-flash[1m]' >&2
exit 1
`;

const FAKE_SLOW = `#!/bin/bash
if [ "$1" = "--version" ]; then echo 'fake-slow 1.0.0'; exit 0; fi
sleep 60
`;

let root: string;
let repo: Repository;
let workspace: string;
let registry: RepositoryRegistry;
let snapshots: SnapshotRegistry;
let snapshotId: string;
const fileIds: string[] = [];

vi.setConfig({testTimeout: 30_000});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'branchroom-runs-'));
  root = join(workspace, 'repo');
  await mkdir(root, {recursive: true});
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'app.ts'), 'v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await writeFile(join(root, 'app.ts'), 'v2\n', 'utf8');
  repo = await openRepository(root);
  registry = new RepositoryRegistry();
  registry.remember(repo);
  snapshots = new SnapshotRegistry();
  const dataDir = join(workspace, 'review-data');
  snapshots.remember(await buildSnapshot(repo));
  const snapshot = await buildSnapshot(repo);
  snapshots.remember(snapshot);
  snapshotId = snapshot.id;
  fileIds.length = 0;
  fileIds.push(...snapshot.files.map((f) => f.id));
});

afterEach(async () => {
  await rm(workspace, {recursive: true, force: true});
});

interface ManagerOptions {
  fakeCliPath: string;
  provider?: 'codex' | 'claude';
  timeoutMs?: number;
}

async function makeManager(options: ManagerOptions): Promise<RunManager> {
  const configDir = join(workspace, 'config');
  const runsDir = join(workspace, 'agent-runs');
  await mkdir(configDir, {recursive: true});
  await writeFile(
    join(configDir, 'agent-settings.json'),
    JSON.stringify({schemaVersion: 1, executablePaths: {[options.provider ?? 'codex']: options.fakeCliPath}})
  );
  return new RunManager({
    runsDir,
    configDir,
    registry,
    snapshots,
    defaultTimeoutMs: options.timeoutMs ?? 30_000
  });
}

async function writeFakeCli(name: string, body: string): Promise<string> {
  const path = join(workspace, name);
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
  return path;
}

test('start through succeed: report validated, run persisted, history retained', async () => {
  const manager = await makeManager({fakeCliPath: await writeFakeCli('fake-codex.cjs', FAKE_CODEX)});
  await manager.init();
  const run = await manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  expect(run.status).toBe('queued');

  const settled = await manager.waitForSettled(run.id);
  expect(settled.status).toBe('succeeded');
  expect(settled.report).not.toBeNull();
  expect(settled.report!.summary).toBe('fake 审查完成');
  expect(settled.report!.coverage).toEqual(['app.ts']);
  expect(settled.report!.findings[0]).toMatchObject({fileId: 'app.ts', side: 'current', priority: 'P2'});

  const history = await manager.listRuns(repo.id);
  expect(history).toHaveLength(1);
  const raw = await readFile(join(workspace, 'agent-runs', repo.id, `${run.id}.json`), 'utf8');
  expect(JSON.parse(raw).status).toBe('succeeded');
  await manager.cancelReview(run.id).catch(() => undefined);
});

test('second run while one is in flight is rejected with run_busy', async () => {
  const manager = await makeManager({fakeCliPath: await writeFakeCli('fake-slow.cjs', FAKE_SLOW), timeoutMs: 60_000});
  await manager.init();
  const first = await manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  await expect(
    manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'})
  ).rejects.toSatisfy((error: unknown) => (error as {code?: string}).code === 'run_busy');
  await manager.cancelReview(first.id);
  await manager.waitForSettled(first.id);
});

test('cancelled run terminates the fake cli and records cancelled', async () => {
  const manager = await makeManager({fakeCliPath: await writeFakeCli('fake-slow.cjs', FAKE_SLOW), timeoutMs: 60_000});
  await manager.init();
  const run = await manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  await manager.cancelReview(run.id);
  const settled = await manager.waitForSettled(run.id);
  expect(settled.status).toBe('cancelled');
  expect(settled.finishedAt).not.toBeNull();
});

test('auth failure and model failure map to distinct error codes', async () => {
  const authManager = await makeManager({fakeCliPath: await writeFakeCli('fake-auth-fail.sh', FAKE_AUTH_FAIL)});
  await authManager.init();
  const authRun = await authManager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  const authSettled = await authManager.waitForSettled(authRun.id);
  expect(authSettled.status).toBe('failed');
  expect(authSettled.error).toMatchObject({code: 'agent_auth_required'});

  const modelManager = await makeManager({fakeCliPath: await writeFakeCli('fake-model-fail.sh', FAKE_MODEL_FAIL)});
  await modelManager.init();
  const modelRun = await modelManager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  const modelSettled = await modelManager.waitForSettled(modelRun.id);
  expect(modelSettled.status).toBe('failed');
  expect(modelSettled.error).toMatchObject({code: 'agent_incompatible'});
});

test('timeout produces agent_timeout failure', async () => {
  const manager = await makeManager({
    fakeCliPath: await writeFakeCli('fake-slow.cjs', FAKE_SLOW),
    timeoutMs: 200
  });
  await manager.init();
  const run = await manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  const settled = await manager.waitForSettled(run.id);
  expect(settled.status).toBe('failed');
  expect(settled.error).toMatchObject({code: 'agent_timeout'});
});

test('unknown snapshot id or empty reviewable selection is rejected', async () => {
  const manager = await makeManager({fakeCliPath: await writeFakeCli('fake-codex.cjs', FAKE_CODEX)});
  await manager.init();
  await expect(
    manager.startReview({repoId: repo.id, snapshotId: '不存在', fileIds, provider: 'codex'})
  ).rejects.toSatisfy((error: unknown) => (error as {code?: string}).code === 'content_changed');
  await expect(
    manager.startReview({repoId: repo.id, snapshotId, fileIds: ['不存在的文件'], provider: 'codex'})
  ).rejects.toSatisfy((error: unknown) => (error as {code?: string}).code === 'file_unreviewable');
});

test('missing executable fails fast with agent_missing', async () => {
  const manager = await makeManager({fakeCliPath: join(workspace, '不存在')});
  await manager.init();
  const run = await manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  const settled = await manager.waitForSettled(run.id);
  expect(settled.status).toBe('failed');
  expect(settled.error).toMatchObject({code: 'agent_missing'});
});

test('runs still recorded as running are marked interrupted on init', async () => {
  const manager = await makeManager({fakeCliPath: await writeFakeCli('fake-codex.cjs', FAKE_CODEX)});
  await manager.init();
  const run = await manager.startReview({repoId: repo.id, snapshotId, fileIds, provider: 'codex'});
  const settled = await manager.waitForSettled(run.id);
  expect(settled.status).toBe('succeeded');

  // 伪造一个服务崩溃时遗留的 running 记录
  const runsDir = join(workspace, 'agent-runs', repo.id);
  const stale = {...settled, id: 'stale-run', status: 'running'};
  await writeFile(join(runsDir, 'stale-run.json'), JSON.stringify(stale));

  const revived = await makeManager({fakeCliPath: await writeFakeCli('fake-codex2.cjs', FAKE_CODEX)});
  await revived.init();
  const runs = await revived.listRuns(repo.id);
  const staleRun = runs.find((r) => r.id === 'stale-run');
  expect(staleRun!.status).toBe('interrupted');
  expect(staleRun!.error).toMatchObject({code: 'interrupted'});
});

test('listAgents reports explicit configured path and version', async () => {
  // 假 CLI 对 --version 退出非零 → incompatible；另配置一个可用的
  const broken = await writeFakeCli('fake-broken', '#!/bin/bash\necho "配置损坏" >&2\nexit 5');
  const versioned = await writeFakeCli('fake-version-codex', '#!/bin/bash\necho "codex-cli 9.9.9"');
  const configDir = join(workspace, 'config2');
  await mkdir(configDir, {recursive: true});
  await writeFile(
    join(configDir, 'agent-settings.json'),
    JSON.stringify({schemaVersion: 1, executablePaths: {codex: versioned, claude: broken}})
  );
  const manager = new RunManager({
    runsDir: join(workspace, 'agent-runs'), configDir, registry, snapshots
  });
  const agents = await manager.listAgents();
  const codex = agents.find((a) => a.provider === 'codex')!;
  const claude = agents.find((a) => a.provider === 'claude')!;
  expect(codex.status).toBe('available');
  expect(codex.version).toBe('codex-cli 9.9.9');
  expect(claude.status).toBe('incompatible'); // 假脚本对 --version 退出非零
});
