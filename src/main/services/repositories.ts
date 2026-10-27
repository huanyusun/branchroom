import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Repository } from '../../shared/contracts';

const execFileP = promisify(execFile);
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

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

async function runGit(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, {cwd: root, maxBuffer: GIT_MAX_BUFFER});
    return stdout;
  } catch (error) {
    throw classifyGitError(error, args);
  }
}

/** 失败返回 null，但 git 本身缺失仍然抛错，避免把环境问题吞成“分支为空”。 */
async function tryGit(root: string, args: string[]): Promise<string | null> {
  try {
    const {stdout} = await execFileP('git', args, {cwd: root, maxBuffer: GIT_MAX_BUFFER});
    return stdout;
  } catch (error) {
    if (isSpawnFailure(error)) throw classifyGitError(error, args);
    return null;
  }
}

function isSpawnFailure(error: unknown): boolean {
  return (error as {code?: unknown} | null)?.code === 'ENOENT';
}

function firstStderrLine(error: unknown): string {
  const stderr = (error as {stderr?: unknown} | null)?.stderr;
  if (typeof stderr !== 'string') return '';
  return stderr.trim().split('\n')[0] ?? '';
}

function classifyGitError(error: unknown, args: string[]): RepositoryError {
  if (isSpawnFailure(error)) {
    return new RepositoryError('git_unavailable', '未找到 git 命令。请确认系统 PATH 中已安装 Git，或在后续版本中显式指定可执行文件路径。', {
      retryable: true,
      cause: error
    });
  }
  const stderr = firstStderrLine(error);
  if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
    return new RepositoryError(
      'not_git_repository',
      stderr ? `所选目录不是 Git 仓库（git: ${stderr}）` : '所选目录不是 Git 仓库。',
      {cause: error}
    );
  }
  return new RepositoryError(
    'repository_unavailable',
    `无法读取 Git 仓库信息（git ${args.join(' ')} 失败${stderr ? `：${stderr}` : ''}）。`,
    {cause: error}
  );
}

function repositoryId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}

/** 由根路径派生仓库 ID；与 openRepository 一致，路径失效时仍可用于最近列表操作。 */
export function repositoryIdForRoot(root: string): string {
  return repositoryId(resolve(root));
}

/**
 * 校验并读取一个 Git 仓库或 linked worktree 的身份。
 * 输入必须是可以直接使用的绝对路径；子目录会向上解析到所在 worktree 根。
 * 未创建首次提交是合法情况（head 为 null），其他 Git 命令失败不会吞成空仓库。
 */
export async function openRepository(inputRoot: string): Promise<Repository> {
  if (typeof inputRoot !== 'string' || inputRoot.trim() === '') {
    throw new RepositoryError('invalid_input', '仓库路径不能为空。');
  }
  if (!isAbsolute(inputRoot)) {
    throw new RepositoryError('invalid_input', `仓库路径必须是绝对路径：${inputRoot}`);
  }

  let info;
  try {
    info = await stat(inputRoot);
  } catch {
    throw new RepositoryError('path_not_found', `目录不存在或无法访问：${inputRoot}`);
  }
  if (!info.isDirectory()) {
    throw new RepositoryError('path_not_found', `所选路径不是目录：${inputRoot}`);
  }

  const probeRoot = resolve(inputRoot);
  const insideWorkTree = (await runGit(probeRoot, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (insideWorkTree !== 'true') {
    throw new RepositoryError('bare_repository', '所选的是裸仓库（bare repository），没有工作区，暂不支持打开。');
  }

  const toplevel = (await runGit(probeRoot, ['rev-parse', '--show-toplevel'])).trim();
  if (toplevel === '') {
    throw new RepositoryError('repository_unavailable', '无法解析仓库根目录。');
  }
  const root = resolve(toplevel);

  const gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).trim();
  if (gitDir === '') {
    throw new RepositoryError('repository_unavailable', '无法解析仓库的 .git 目录。');
  }
  const commonDirRaw = (await runGit(root, ['rev-parse', '--git-common-dir'])).trim();
  const commonGitDir = resolve(root, commonDirRaw);

  // 分离 HEAD：symbolic-ref 非零退出是预期信号；未创建提交：rev-parse HEAD 非零退出。
  const branchRaw = await tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const headRaw = await tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branch = branchRaw === null ? null : branchRaw.trim() || null;
  const head = headRaw === null ? null : headRaw.trim() || null;

  return {
    id: repositoryId(root),
    name: basename(root),
    root,
    gitDir,
    commonGitDir,
    branch,
    head
  };
}
