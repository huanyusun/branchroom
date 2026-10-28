import { spawn } from 'node:child_process';

export type KillReason = 'timeout' | 'output_limit' | 'cancelled';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
}

export interface SpawnCliOptions {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  /** 到时自动终止；默认 8 分钟（原型经验值）。 */
  timeoutMs: number;
  /** stdout+stderr 合计上限，超过即按 output_limit 终止。 */
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export interface CliRun {
  result: Promise<CliResult>;
  /** 终止整棵进程树（POSIX 进程组）。 */
  cancel(): void;
  /** 因 timeout / output_limit / cancelled 被终止时给出原因。 */
  readonly killedReason: KillReason | null;
}

const CANCEL_GRACE_MS = 2000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;

export class CliSpawnError extends Error {
  readonly code = 'cli_spawn_failed';
  constructor(message: string, options?: {cause?: unknown}) {
    super(message);
    this.name = 'CliSpawnError';
    if (options?.cause !== undefined) (this as {cause?: unknown}).cause = options.cause;
  }
}

/**
 * 受控启动一个 CLI 子进程：stdin 传提示词（不经 argv/shell）、
 * detached 进程组便于整树终止、超时与输出上限兜底。
 * argv 数组直接交给 execFile 语义，不经过 shell。
 */
export function spawnCli(options: SpawnCliOptions): CliRun {
  let killedReason: KillReason | null = null;
  let cancelled = false;
  let child: ReturnType<typeof spawn> | null = null;

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalBytes = 0;
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const result = new Promise<CliResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: {...process.env, ...options.env},
        // 进程组组长：取消时可 SIGTERM/SIGKILL 整棵树，避免遗留仍在计费的子进程
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      finish(() => reject(new CliSpawnError(`无法启动 ${options.executable}。`, {cause: error})));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      killedReason = 'timeout';
      killTree('SIGTERM');
      const force = setTimeout(() => {
        if (!settled) killTree('SIGKILL');
      }, CANCEL_GRACE_MS);
      force.unref();
    }, options.timeoutMs);
    timer.unref();

    const killTree = (signal: NodeJS.Signals): void => {
      if (child === null) return;
      try {
        if (child.pid !== undefined && process.platform !== 'win32') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // 进程可能已退出
      }
    };

    const trackChunk = (chunk: Buffer): void => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes && killedReason === null) {
        killedReason = 'output_limit';
        killTree('SIGTERM');
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      trackChunk(chunk);
      stdoutChunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      trackChunk(chunk);
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      finish(() => reject(new CliSpawnError(`无法启动 ${options.executable}。`, {cause: error})));
    });

    child.on('close', (exitCode, signal) => {
      finish(() => {
        if (cancelled && killedReason === null) killedReason = 'cancelled';
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        resolve({
          stdout,
          stderr,
          exitCode,
          killed: killedReason !== null && signal !== null
        });
      });
    });

    child.stdin!.on('error', () => undefined); // CLI 提前退出时写入 EPIPE 属正常
    child.stdin!.end(options.stdin);
  });

  return {
    result,
    cancel(): void {
      cancelled = true;
      if (killedReason === null) killedReason = 'cancelled';
      if (child !== null && child.pid !== undefined) {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
          else child.kill('SIGTERM');
        } catch {
          // 已退出
        }
      }
    },
    get killedReason(): KillReason | null {
      return killedReason;
    }
  };
}
