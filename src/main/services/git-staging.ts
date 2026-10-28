import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve, sep } from 'node:path';

const execFileP = promisify(execFile);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Git 写操作错误；写操作只由显式产品动作触发。 */
export class StagingError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: {cause?: unknown}) {
    super(message);
    this.name = 'StagingError';
    this.code = code;
    this.retryable = false;
    if (options?.cause !== undefined) (this as {cause?: unknown}).cause = options.cause;
  }
}

/** 归一化并校验路径列表：必须相对且不逃出仓库根。返回去重后的相对路径。 */
function normalizePaths(root: string, paths: string[]): string[] {
  if (paths.length === 0) {
    throw new StagingError('invalid_input', '未选择任何文件。');
  }
  const normalizedRoot = resolve(root);
  const unique = new Set<string>();
  for (const input of paths) {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new StagingError('invalid_input', '文件路径不能为空。');
    }
    if (isAbsolute(input)) {
      throw new StagingError('invalid_input', `路径必须是仓库内相对路径：${input}`);
    }
    const absolute = resolve(normalizedRoot, input);
    if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + sep)) {
      throw new StagingError('invalid_input', `路径逃出仓库范围：${input}`);
    }
    const relative = absolute === normalizedRoot ? '' : absolute.slice(normalizedRoot.length + 1);
    if (relative === '') {
      throw new StagingError('invalid_input', '路径不能是仓库根目录本身。');
    }
    unique.add(relative);
  }
  return [...unique];
}

async function runGit(root: string, args: string[]): Promise<string> {
  try {
    const {stdout} = await execFileP('git', args, {cwd: root, maxBuffer: GIT_MAX_BUFFER});
    return stdout;
  } catch (error) {
    const err = error as {code?: unknown; stderr?: string; stdout?: string; message?: string};
    throw new StagingError(
      'git_failed',
      `git ${args.join(' ')} 失败：${(err.stderr ?? err.message ?? '').trim().split('\n')[0] ?? ''}`,
      {cause: error}
    );
  }
}

function firstStderr(error: unknown): string {
  return ((error as {stderr?: string}).stderr ?? '').trim();
}

/** 显式暂存：git add -- <paths>。 */
export async function stageFiles(root: string, paths: string[]): Promise<void> {
  const normalized = normalizePaths(root, paths);
  await runGit(root, ['add', '--', ...normalized]);
}

/** 显式取消暂存：git restore --staged -- <paths>。工作区内容不动。 */
export async function unstageFiles(root: string, paths: string[]): Promise<void> {
  const normalized = normalizePaths(root, paths);
  await runGit(root, ['restore', '--staged', '--', ...normalized]);
}

export interface CommitResult {
  commitHash: string;
}

/** 提交当前索引（只包含已暂存内容）；需要非空提交信息与用户已配置的 Git 身份。 */
export async function commitStaged(root: string, message: string): Promise<CommitResult> {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new StagingError('invalid_input', '提交信息不能为空。');
  }
  try {
    const {stdout} = await execFileP('git', ['commit', '-m', message], {
      cwd: root,
      maxBuffer: GIT_MAX_BUFFER
    });
    return {commitHash: parseHash(stdout)};
  } catch (error) {
    throw mapCommitError(error);
  }
}

/** 文件级提交：只提交所选路径的当前工作区内容（IDEA 变更列表语义）。 */
export async function commitFiles(root: string, message: string, paths: string[]): Promise<CommitResult> {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new StagingError('invalid_input', '提交信息不能为空。');
  }
  const normalized = normalizePaths(root, paths);
  try {
    // 未跟踪路径对 `git commit -- pathspec` 不可见；先把所选路径加入索引
    //（仅限所选路径，不触碰其他文件的暂存状态）
    await execFileP('git', ['add', '--', ...normalized], {cwd: root, maxBuffer: GIT_MAX_BUFFER});
    const {stdout} = await execFileP(
      'git',
      ['commit', '-m', message, '--', ...normalized],
      {cwd: root, maxBuffer: GIT_MAX_BUFFER}
    );
    return {commitHash: parseHash(stdout)};
  } catch (error) {
    throw mapCommitError(error);
  }
}

function parseHash(output: string): string {
  const match = output.match(/\[[\w/.-]+ ([0-9a-f]{7,40})\]/);
  if (match === null) {
    // git 也可能在 stdout 打分支裁剪信息；用 rev-parse 兜底由调用方完成
    const fallback = output.trim().split('\n')[0] ?? '';
    throw new StagingError('git_failed', `无法解析提交结果：${fallback.slice(0, 200)}`);
  }
  return match[1]!;
}

function mapCommitError(error: unknown): StagingError {
  const err = error as {stderr?: string; stdout?: string; message?: string};
  // git 把 "nothing to commit" 打到 stdout，其余错误多在 stderr：合并后再分类
  const combined = `${firstStderr(err)}\n${err.stdout ?? ''}`;
  if (/nothing (?:added )?to commit|no changes added/i.test(combined)) {
    return new StagingError('nothing_staged', '没有可提交的内容：请先暂存文件或选择要提交的文件。', {cause: error});
  }
  if (/Please tell me who you are/i.test(combined)) {
    return new StagingError('git_failed', 'Git 缺少提交身份配置：请在本机配置 user.name / user.email 后重试。', {cause: error});
  }
  const stderr = firstStderr(err);
  return new StagingError('git_failed', `提交失败：${stderr.split('\n')[0] ?? ''}`, {cause: error});
}

export interface CommitPreview {
  files: string[];
  additions: number;
  deletions: number;
}

/** 提交预览：当前索引里会被提交的文件与增删统计。 */
export async function previewCommit(root: string): Promise<CommitPreview> {
  const output = await runGit(root, [
    '-c', 'core.quotePath=false',
    'diff', '--cached', '--numstat'
  ]);
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const [add = '', del = '', ...rest] = line.split('\t');
    files.push(rest.join('\t'));
    if (add !== '-') additions += Number.parseInt(add, 10) || 0;
    if (del !== '-') deletions += Number.parseInt(del, 10) || 0;
  }
  return {files, additions, deletions};
}
