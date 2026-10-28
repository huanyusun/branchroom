import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentCapability, Provider, ReviewRun } from '../../shared/contracts';
import { detectAgent } from '../agents/capabilities';
import { classifyFailure, profileFor } from '../agents/profiles';
import { buildPrompt, reportJsonSchema, validateAgentReport, type SnapshotFileInput } from '../agents/report';
import { spawnCli } from '../agents/runner';
import type { RepositoryRegistry } from './repositories';
import type { SnapshotRegistry } from './review-service';

/** Agent Review 流程错误；code 遵循 docs/CONTRACTS.md 语义。 */
export class RunError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: {retryable?: boolean; cause?: unknown}) {
    super(message);
    this.name = 'RunError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) (this as {cause?: unknown}).cause = options.cause;
  }
}

export interface RunManagerOptions {
  runsDir: string;
  /** 存放 agent-settings.json（显式可执行文件路径）的目录。 */
  configDir: string;
  registry: RepositoryRegistry;
  snapshots: SnapshotRegistry;
  /** 状态变化回调（IPC 推送用）。 */
  onUpdate?: (run: ReviewRun) => void;
  defaultTimeoutMs?: number;
  cancelGraceMs?: number;
}

interface AgentSettings {
  schemaVersion: 1;
  executablePaths: Partial<Record<Provider, string>>;
}

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

function isTerminal(run: ReviewRun): boolean {
  return run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
}

/**
 * Agent Review 的任务生命周期管理：
 * - 每仓库同时一个 run（run_busy），跨仓库排队
 * - run 记录逐状态原子落盘（runs/<repoId>/<runId>.json），历史不被覆盖
 * - 服务重启时遗留的 running/queued 一律标记 interrupted，不自动重新计费
 */
export class RunManager {
  readonly #runsDir: string;
  readonly #configDir: string;
  readonly #registry: RepositoryRegistry;
  readonly #snapshots: SnapshotRegistry;
  readonly #onUpdate?: (run: ReviewRun) => void;
  readonly #defaultTimeoutMs: number;
  readonly #cancelGraceMs: number;
  /** repoId → 当前 run；串行化同一仓库的执行。 */
  readonly #active = new Map<string, Promise<void>>();
  readonly #executions = new Map<string, Promise<void>>();
  readonly #runners = new Map<string, {cancel(): void}>();
  /** 已请求取消但执行协程尚未处理的 run。 */
  readonly #cancelRequested = new Set<string>();

  constructor(options: RunManagerOptions) {
    this.#runsDir = options.runsDir;
    this.#configDir = options.configDir;
    this.#registry = options.registry;
    this.#snapshots = options.snapshots;
    this.#onUpdate = options.onUpdate;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#cancelGraceMs = options.cancelGraceMs ?? 2000;
  }

  private async loadSettings(): Promise<AgentSettings> {
    try {
      const raw = await readFile(join(this.#configDir, 'agent-settings.json'), 'utf8');
      const parsed = JSON.parse(raw) as AgentSettings;
      if (parsed.schemaVersion !== 1 || typeof parsed.executablePaths !== 'object' || parsed.executablePaths === null) {
        return {schemaVersion: 1, executablePaths: {}};
      }
      return parsed;
    } catch {
      return {schemaVersion: 1, executablePaths: {}};
    }
  }

  async listAgents(): Promise<AgentCapability[]> {
    const settings = await this.loadSettings();
    const providers: Provider[] = ['codex', 'claude'];
    return Promise.all(
      providers.map((provider) =>
        detectAgent(provider, {executablePath: settings.executablePaths[provider]})
      )
    );
  }

  private runPath(repoId: string, runId: string): string {
    return join(this.#runsDir, repoId, `${runId}.json`);
  }

  private async persist(run: ReviewRun): Promise<void> {
    const path = this.runPath(run.repoId, run.id);
    await mkdir(join(this.#runsDir, run.repoId), {recursive: true});
    const tmp = `${path}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
    this.#onUpdate?.(run);
  }

  /** 服务启动时调用：把上次进程遗留的未完成 run 标记为 interrupted。 */
  async init(): Promise<void> {
    let repoIds: string[] = [];
    try {
      repoIds = await readdir(this.#runsDir);
    } catch {
      return; // 还没有任何 run
    }
    for (const repoId of repoIds) {
      let files: string[] = [];
      try {
        files = await readdir(join(this.#runsDir, repoId));
      } catch {
        continue;
      }
      for (const file of files.filter((name) => name.endsWith('.json'))) {
        try {
          const raw = JSON.parse(await readFile(join(this.#runsDir, repoId, file), 'utf8')) as ReviewRun;
          if (raw.status === 'running' || raw.status === 'queued') {
            await this.persist({
              ...raw,
              status: 'interrupted',
              finishedAt: new Date().toISOString(),
              error: {code: 'interrupted', message: '应用重启中断了这次审查；未自动重跑。请重新发起。'}
            });
          }
        } catch (error) {
          console.warn(`[branchroom] 无法读取 run 记录 ${file}`, error);
        }
      }
    }
  }

  async startReview(input: {
    repoId: string;
    snapshotId: string;
    fileIds: string[];
    provider: Provider;
  }): Promise<ReviewRun> {
    if (this.#active.has(input.repoId)) {
      throw new RunError('run_busy', '此仓库已有一个审查在运行；请等待完成或先取消。');
    }
    const root = this.#registry.rootOf(input.repoId);
    if (root === null) {
      throw new RunError('repository_unavailable', '此仓库尚未在本会话打开，请先重新打开。');
    }
    const snapshot = this.#snapshots.snapshotOf(input.snapshotId);
    if (snapshot === null || snapshot.repoId !== input.repoId) {
      throw new RunError('content_changed', '快照已过期或不存在，请刷新后重新发起审查。');
    }
    const wanted = new Set(input.fileIds);
    const selected = snapshot.files.filter((file) => wanted.has(file.id));
    const reviewable = selected.filter((file) => file.reviewable);
    if (selected.length !== input.fileIds.length || reviewable.length === 0) {
      throw new RunError(
        'file_unreviewable',
        '所选文件不存在或都不可审阅（二进制/符号链接/子模块/超大文件不能交给 Agent）。'
      );
    }
    if (this.#active.has(input.repoId)) {
      throw new RunError('run_busy', '此仓库已有一个审查在运行；请等待完成或先取消。');
    }

    const run: ReviewRun = {
      id: randomUUID(),
      repoId: input.repoId,
      snapshotId: input.snapshotId,
      provider: input.provider,
      status: 'queued',
      fileIds: reviewable.map((file) => file.id),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      report: null,
      error: null
    };
    await this.persist(run);

    const execution = this.#execute(run, reviewable.map((file) => ({
      path: file.path,
      fingerprint: file.fingerprint,
      previousContent: file.baseContent,
      currentContent: file.currentContent,
      diff: file.patch
    }))).finally(() => {
      this.#active.delete(input.repoId);
      this.#runners.delete(run.id);
      this.#executions.delete(run.id);
    });
    this.#active.set(input.repoId, execution);
    this.#executions.set(run.id, execution);
    return run;
  }

  async #execute(
    initial: ReviewRun,
    files: SnapshotFileInput[]
  ): Promise<void> {
    let run: ReviewRun = initial;
    const update = async (next: ReviewRun): Promise<void> => {
      // 取消是终态：一旦写入 cancelled，执行协程的滞后更新不得覆盖
      if (run.status === 'cancelled' && next.status !== 'cancelled') return;
      run = next;
      await this.persist(next);
      if (isTerminal(next)) this.#cancelRequested.delete(next.id);
    };

    try {
      const settings = await this.loadSettings();
      const agents = await this.listAgents();
      if (this.#cancelRequested.has(run.id)) {
        await update({...run, status: 'cancelled', finishedAt: new Date().toISOString()});
        return;
      }
      const capability = agents.find((agent) => agent.provider === run.provider);
      if (capability?.status !== 'available' || capability.executable === null) {
        throw new RunError(
          'agent_missing',
          capability?.diagnostic ?? `本机未找到可用的 ${run.provider} CLI。`
        );
      }

      const workDir = join(this.#runsDir, run.repoId, `${run.id}.work`);
      await mkdir(workDir, {recursive: true});
      await writeFile(join(workDir, 'schema.json'), JSON.stringify(reportJsonSchema), 'utf8');

      await update({...run, status: 'running', startedAt: run.startedAt});

      const profile = profileFor(run.provider);
      const cli = spawnCli({
        executable: capability.executable,
        args: profile.buildArgs(workDir),
        cwd: workDir,
        stdin: buildPrompt(files, null),
        timeoutMs: this.#defaultTimeoutMs,
        env: {}
      });
      this.#runners.set(run.id, cli);
      // spawn 前后的取消请求窗口：立即终止刚启动的进程，走正常 cancelled 流程
      if (this.#cancelRequested.has(run.id)) cli.cancel();
      const result = await cli.result;
      if (isTerminal(run)) return;

      const finishFailure = async (code: string, message: string): Promise<void> => {
        await update({
          ...run,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: {code, message}
        });
      };

      if (cli.killedReason === 'timeout') {
        await finishFailure('agent_timeout', `审查超过 ${Math.round(this.#defaultTimeoutMs / 1000)} 秒，已停止；可缩小范围后重试。`);
        return;
      }
      if (cli.killedReason === 'cancelled') {
        await update({...run, status: 'cancelled', finishedAt: new Date().toISOString()});
        return;
      }
      if (cli.killedReason === 'output_limit') {
        await finishFailure('agent_failed', 'Agent 输出超过上限，已停止。请缩小审查范围后重试。');
        return;
      }
      if (result.exitCode !== 0) {
        const classified = classifyFailure(result.stderr, result.stdout, result.exitCode);
        await finishFailure(classified.code, classified.message);
        return;
      }

      let reportValue: unknown;
      try {
        reportValue = await profile.extractReport(workDir, result.stdout);
      } catch (error) {
        await finishFailure('agent_failed', `无法读取 Agent 输出：${(error as Error).message}`);
        return;
      }

      let report;
      try {
        report = validateAgentReport(reportValue, files);
      } catch (error) {
        await finishFailure('invalid_report', (error as Error).message);
        return;
      }

      await update({
        ...run,
        status: 'succeeded',
        finishedAt: new Date().toISOString(),
        report
      });
    } catch (error) {
      if (isTerminal(run)) return;
      const runError = error as {code?: string; message?: string};
      await this.persist({
        ...run,
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: {
          code: runError.code ?? 'agent_failed',
          message: runError.message ?? '审查失败。'
        }
      });
    }
  }

  async cancelReview(runId: string): Promise<void> {
    this.#cancelRequested.add(runId);
    const runner = this.#runners.get(runId);
    if (runner !== undefined) {
      runner.cancel();
      return; // 执行协程会把 cancelled 落盘
    }
    // 还没挂到 runner（排队中或执行协程尚在准备）：直接找记录标记取消
    for (const repoId of await readdirSafe(this.#runsDir)) {
      const path = this.runPath(repoId, runId);
      try {
        const raw = JSON.parse(await readFile(path, 'utf8')) as ReviewRun;
        if (raw.status === 'queued' || raw.status === 'running') {
          await this.persist({...raw, status: 'cancelled', finishedAt: new Date().toISOString()});
          return;
        }
      } catch {
        continue;
      }
    }
  }

  /** 应用退出前终止所有仍在运行的 CLI 进程树。 */
  cancelAllActive(): void {
    for (const runner of this.#runners.values()) {
      runner.cancel();
    }
  }

  async listRuns(repoId: string): Promise<ReviewRun[]> {
    const dir = join(this.#runsDir, repoId);
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const runs: ReviewRun[] = [];
    for (const file of files) {
      try {
        runs.push(JSON.parse(await readFile(join(dir, file), 'utf8')) as ReviewRun);
      } catch (error) {
        console.warn(`[branchroom] 无法解析 run 记录 ${file}`, error);
      }
    }
    runs.sort((a, b) => ((a.startedAt ?? '') < (b.startedAt ?? '') ? 1 : -1));
    return runs;
  }

  /** 测试与 UI 轮询用：等待某个 run 的执行完全结束（含最终落盘）。 */
  async waitForSettled(runId: string, timeoutMs = 20_000): Promise<ReviewRun> {
    const execution = this.#executions.get(runId);
    if (execution !== undefined) await execution;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const repoId of await readdirSafe(this.#runsDir)) {
        try {
          const run = JSON.parse(await readFile(this.runPath(repoId, runId), 'utf8')) as ReviewRun;
          if (isTerminal(run)) return run;
        } catch {
          continue;
        }
      }
      if (Date.now() > deadline) throw new RunError('agent_timeout', `等待 run ${runId} 结束超时。`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** 等待所有进行中的执行结束（测试清理用，避免落盘与目录删除竞争）。 */
  async waitUntilIdle(): Promise<void> {
    await Promise.allSettled([...this.#active.values()]);
  }
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
