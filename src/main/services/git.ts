import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** 服务层错误；code 与 docs/CONTRACTS.md 的错误码语义一致。 */
export class RepositoryError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options?: {retryable?: boolean; cause?: unknown}
  ) {
    super(message);
    this.name = 'RepositoryError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) {
      (this as {cause?: unknown}).cause = options.cause;
    }
  }
}

export function isSpawnFailure(error: unknown): boolean {
  return (error as {code?: unknown} | null)?.code === 'ENOENT';
}

function firstStderrLine(error: unknown): string {
  const stderr = (error as {stderr?: unknown} | null)?.stderr;
  if (typeof stderr !== 'string') return '';
  return stderr.trim().split('\n')[0] ?? '';
}

export function classifyGitError(error: unknown, args: string[]): RepositoryError {
  if (isSpawnFailure(error)) {
    return new RepositoryError('git_unavailable', '未找到 git 命令。请确认系统 PATH 中已安装 Git，或在后续版本中显式指定可执行文件路径。', {
      retryable: true,
      cause: error
    });
  }
  const stderr = firstStderrLine(error);
  return new RepositoryError(
    'git_failed',
    `git ${args.join(' ')} 失败${stderr ? `：${stderr}` : ''}。`,
    {cause: error}
  );
}

/** 文本输出；失败抛 RepositoryError（git 缺失 → git_unavailable）。 */
export async function runGit(
  root: string,
  args: string[],
  options?: {maxBuffer?: number}
): Promise<string> {
  try {
    const {stdout} = await execFileP('git', args, {
      cwd: root,
      maxBuffer: options?.maxBuffer ?? 4 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw classifyGitError(error, args);
  }
}

/** 字节输出（blob 内容等），用于二进制检测。 */
export async function runGitBuffer(root: string, args: string[]): Promise<Buffer> {
  try {
    const {stdout} = await execFileP('git', args, {cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024});
    return stdout as unknown as Buffer;
  } catch (error) {
    throw classifyGitError(error, args);
  }
}

/** 当前 HEAD；未创建首次提交返回 null（合法状态），其他失败抛错，不吞成 unborn。 */
export async function resolveHead(root: string): Promise<string | null> {
  try {
    const {stdout} = await execFileP('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {cwd: root});
    return stdout.trim() || null;
  } catch (error) {
    if (isSpawnFailure(error)) throw classifyGitError(error, ['rev-parse', 'HEAD']);
    const exitCode = (error as {code?: unknown}).code;
    if (exitCode === 1) return null; // unborn HEAD
    throw classifyGitError(error, ['rev-parse', 'HEAD']);
  }
}

export interface StatusRecord {
  code: 'changed' | 'renamed' | 'untracked' | 'unmerged' | 'ignored';
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  origPath: string | null;
  headBlob: string | null;
  indexBlob: string | null;
  unmerged: boolean;
  submodule: boolean;
}

const isZeroHash = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && /^0+$/.test(value);

function hashOrNull(value: string | undefined): string | null {
  if (value === undefined || value === '' || isZeroHash(value)) return null;
  return value;
}

/**
 * 解析 `git status --porcelain=v2 -z` 输出。
 * -z 格式：记录之间 NUL 分隔；rename 记录的 origPath 以额外一个 NUL 跟在 path 之后。
 * 固定字段数之后的所有空格都属于路径，因此中文/空格文件名不会被拆坏。
 */
export function parseStatusZ(output: string): StatusRecord[] {
  const records: StatusRecord[] = [];
  const tokens = output.split('\u0000');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '') continue;
    if (token.startsWith('1 ')) {
      const fields = token.split(' ');
      records.push({
        code: 'changed',
        indexStatus: fields[1]![0]!,
        worktreeStatus: fields[1]![1]!,
        submodule: fields[2] === 'S',
        headBlob: hashOrNull(fields[6]),
        indexBlob: hashOrNull(fields[7]),
        path: fields.slice(8).join(' '),
        origPath: null,
        unmerged: false
      });
    } else if (token.startsWith('2 ')) {
      const fields = token.split(' ');
      const origPath = tokens[i + 1] ?? '';
      i += 1; // 消费 origPath 段
      records.push({
        code: 'renamed',
        indexStatus: fields[1]![0]!,
        worktreeStatus: fields[1]![1]!,
        submodule: fields[2] === 'S',
        headBlob: hashOrNull(fields[6]),
        indexBlob: hashOrNull(fields[7]),
        path: fields.slice(9).join(' '),
        origPath: origPath === '' ? null : origPath,
        unmerged: false
      });
    } else if (token.startsWith('u ')) {
      const fields = token.split(' ');
      records.push({
        code: 'unmerged',
        indexStatus: fields[1]![0]!,
        worktreeStatus: fields[1]![1]!,
        submodule: fields[2] === 'S',
        headBlob: null,
        indexBlob: null,
        path: fields.slice(10).join(' '),
        origPath: null,
        unmerged: true
      });
    } else if (token.startsWith('? ')) {
      records.push({
        code: 'untracked',
        indexStatus: '?',
        worktreeStatus: '?',
        submodule: false,
        headBlob: null,
        indexBlob: null,
        path: token.slice(2),
        origPath: null,
        unmerged: false
      });
    } else if (token.startsWith('! ')) {
      records.push({
        code: 'ignored',
        indexStatus: '!',
        worktreeStatus: '!',
        submodule: false,
        headBlob: null,
        indexBlob: null,
        path: token.slice(2),
        origPath: null,
        unmerged: false
      });
    }
  }
  return records;
}

export interface PatchChunk {
  patch: string;
  binary: boolean;
}

/**
 * 把整棵树的 `git diff` 输出按文件拆分。
 * key 优先取 `+++ b/<path>`（重命名后新路径）；删除文件回退到 `diff --git` 头的 b 路径。
 * 二进制块标记 binary，不产出可用文本 patch。
 */
export function splitPatchByFile(diff: string): Map<string, PatchChunk> {
  const chunks = new Map<string, PatchChunk>();
  if (diff === '') return chunks;

  let key = '';
  let buffer: string[] = [];
  let binary = false;
  let open = false;

  const flush = (): void => {
    if (open && key !== '') chunks.set(key, {patch: buffer.join('\n'), binary});
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      open = true;
      buffer = [line];
      binary = false;
      // 回退 key：默认头形如 "diff --git a/<old> b/<new>"；取最后一个 " b/" 之后的路径
      const marker = ' b/';
      const at = line.lastIndexOf(marker);
      key = at >= 0 ? line.slice(at + marker.length) : '';
      continue;
    }
    if (!open) continue;
    buffer.push(line);
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
    } else if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      if (target.startsWith('b/')) key = target.slice(2);
      else if (target !== '/dev/null') key = target;
    }
  }
  flush();
  return chunks;
}
