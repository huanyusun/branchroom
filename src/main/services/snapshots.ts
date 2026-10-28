import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeFile, Repository, Snapshot } from '../../shared/contracts';
import {
  type PatchChunk,
  type StatusRecord,
  parseStatusZ,
  resolveHead,
  runGit,
  runGitBuffer,
  splitPatchByFile
} from './git';

export const DEFAULT_CONTENT_LIMIT_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_PATCH_LIMIT_BYTES = 2 * 1024 * 1024; // 2 MiB
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/** 快照失败；code 遵循 docs/CONTRACTS.md 错误码语义。 */
export class SnapshotError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: {retryable?: boolean; cause?: unknown}) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) {
      (this as {cause?: unknown}).cause = options.cause;
    }
  }
}

export interface SnapshotOptions {
  /** HEAD/内容一致性失败时的最大尝试次数。 */
  maxAttempts?: number;
  contentLimitBytes?: number;
  patchLimitBytes?: number;
  /** 测试一致性重试的注入点：每次尝试校验之前调用。生产代码不使用。 */
  hooks?: {beforeVerify?: () => Promise<void>};
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

function isBinaryBuffer(bytes: Buffer): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

interface Attempt {
  head: string | null;
  files: ChangeFile[];
  stamps: Map<string, {mtimeMs: number; size: number}>;
}

function kindOf(record: StatusRecord): ChangeFile['kind'] {
  if (record.unmerged) return 'conflicted';
  if (record.origPath !== null) return 'renamed';
  if (record.code === 'untracked' || record.indexStatus === 'A' || record.worktreeStatus === 'A') {
    return 'added';
  }
  if (record.indexStatus === 'D' || record.worktreeStatus === 'D') return 'deleted';
  return 'modified';
}

async function runAttempt(
  repository: Repository,
  limits: {contentLimitBytes: number; patchLimitBytes: number}
): Promise<Attempt> {
  const {root, id: repoId} = repository;

  let head: string | null;
  try {
    head = await resolveHead(root);
  } catch (error) {
    throw new SnapshotError('repository_unavailable', (error as Error).message, {cause: error});
  }

  let statusOutput: string;
  try {
    // --no-optional-locks：保证 status 不写用户仓库的 index
    statusOutput = await runGit(root, [
      '--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=all', '-z'
    ]);
  } catch (error) {
    throw new SnapshotError('repository_unavailable', (error as Error).message, {cause: error});
  }
  const records = parseStatusZ(statusOutput).filter((record) => record.code !== 'ignored');

  // 读取前的文件指纹（mtime+size），读取后再核对以发现并发修改
  const stamps = new Map<string, {mtimeMs: number; size: number}>();
  for (const record of records) {
    if (record.code === 'ignored') continue;
    try {
      const info = await lstat(join(root, record.path));
      if (!info.isDirectory()) {
        stamps.set(record.path, {mtimeMs: info.mtimeMs, size: info.size});
      }
    } catch {
      // 工作区文件不存在（如已暂存删除），属正常状态
    }
  }

  let diffOutput = '';
  if (head !== null) {
    try {
      diffOutput = await runGit(
        root,
        ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--find-renames', '--no-ext-diff', '--no-textconv'],
        {maxBuffer: DIFF_MAX_BUFFER}
      );
    } catch (error) {
      const cause = error as {code?: unknown};
      if (cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new SnapshotError(
          'diff_too_large',
          `一次性读取整棵树的 Diff 超过 ${DIFF_MAX_BUFFER} 字节上限，未生成快照。`,
          {retryable: false, cause: error}
        );
      }
      throw new SnapshotError('repository_unavailable', (error as Error).message, {cause: error});
    }
  }
  const patchChunks = splitPatchByFile(diffOutput);

  const files: ChangeFile[] = [];
  for (const record of records) {
    files.push(await buildChangeFile(repository, record, patchChunks, limits, head));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {head, files, stamps};
}

async function buildChangeFile(
  repository: Repository,
  record: StatusRecord,
  patchChunks: Map<string, PatchChunk>,
  limits: {contentLimitBytes: number; patchLimitBytes: number},
  head: string | null
): Promise<ChangeFile> {
  const {root, id: repoId} = repository;
  const kind = kindOf(record);

  let baseContent: string | null = null;
  let currentContent: string | null = null;
  let reviewable = true;
  let unavailableReason: string | null = null;

  // 基线内容：直接读取 status 记录里钉住的 HEAD blob，不随后续 HEAD 移动漂移
  if (record.headBlob !== null) {
    try {
      const sizeOutput = await runGit(root, ['cat-file', '-s', record.headBlob]);
      const size = Number.parseInt(sizeOutput.trim(), 10);
      if (Number.isFinite(size) && size > limits.contentLimitBytes) {
        reviewable = false;
        unavailableReason = `基线内容过大（${size} 字节，上限 ${limits.contentLimitBytes} 字节），未读取`;
      } else {
        const bytes = await runGitBuffer(root, ['cat-file', 'blob', record.headBlob]);
        if (isBinaryBuffer(bytes)) {
          reviewable = false;
          unavailableReason = '二进制文件，不支持文本 Diff';
        } else {
          baseContent = bytes.toString('utf8');
        }
      }
    } catch (error) {
      throw new SnapshotError('repository_unavailable', (error as Error).message, {cause: error});
    }
  }

  // 当前工作区内容
  if (kind !== 'deleted') {
    if (record.submodule) {
      reviewable = false;
      unavailableReason = '子模块，暂不支持内容读取';
    } else {
      const absolute = join(root, record.path);
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        info = null;
      }
      if (info?.isSymbolicLink()) {
        currentContent = await readlink(absolute);
        reviewable = false;
        unavailableReason = '符号链接：仅显示链接目标，不读取目标内容';
      } else if (info === null) {
        reviewable = false;
        unavailableReason = '工作区文件不可读或已消失';
      } else if (info.size > limits.contentLimitBytes) {
        reviewable = false;
        unavailableReason = `文件过大（${info.size} 字节，上限 ${limits.contentLimitBytes} 字节），未读取内容`;
      } else {
        const bytes = await readFile(absolute);
        if (isBinaryBuffer(bytes)) {
          reviewable = false;
          unavailableReason = '二进制文件，不支持文本 Diff';
        } else {
          currentContent = bytes.toString('utf8');
        }
      }
    }
  }

  // Patch：冲突文件跳过（diff 输出的 combined 格式不可靠），其余按新路径取块
  let patch: string | null = null;
  if (kind === 'conflicted') {
    reviewable = false;
    unavailableReason = '文件处于合并冲突状态：暂不支持 Diff 审阅，可查看全文';
  } else {
    const chunk = patchChunks.get(record.path);
    if (chunk) {
      if (chunk.binary) {
        reviewable = false;
        unavailableReason ??= '二进制文件，不支持文本 Diff';
      } else if (Buffer.byteLength(chunk.patch, 'utf8') > limits.patchLimitBytes) {
        reviewable = false;
        unavailableReason = `Diff 过大（超过 ${limits.patchLimitBytes} 字节上限），未生成`;
      } else {
        patch = chunk.patch;
      }
    }
  }

  const fingerprint = sha256(
    [
      repoId,
      head ?? 'unborn',
      record.path,
      baseContent === null ? '' : sha256(baseContent),
      currentContent === null ? '' : sha256(currentContent)
    ].join('\u0000')
  );

  return {
    id: record.path,
    path: record.path,
    previousPath: record.origPath,
    kind,
    indexStatus: record.indexStatus,
    worktreeStatus: record.worktreeStatus,
    fingerprint,
    baseContent,
    currentContent,
    patch,
    reviewable,
    unavailableReason,
    reviewState: 'pending' // BR-003 引入人工审查持久化
  };
}

/**
 * 构建一次一致的快照：HEAD、status、内容与 patch 全部读取完之后重新核对；
 * 期间发生任何变化就整体重试，绝不返回混合快照。重试耗尽抛 snapshot_changed。
 */
export async function buildSnapshot(
  repository: Repository,
  options: SnapshotOptions = {}
): Promise<Snapshot> {
  const maxAttempts = options.maxAttempts ?? 3;
  const limits = {
    contentLimitBytes: options.contentLimitBytes ?? DEFAULT_CONTENT_LIMIT_BYTES,
    patchLimitBytes: options.patchLimitBytes ?? DEFAULT_PATCH_LIMIT_BYTES
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runAttempt(repository, limits);
    await options.hooks?.beforeVerify?.();

    let consistent = true;
    try {
      const headNow = await resolveHead(repository.root);
      if (headNow !== result.head) {
        consistent = false;
      } else {
        for (const [path, stamp] of result.stamps) {
          const info = await lstat(join(repository.root, path));
          if (info.mtimeMs !== stamp.mtimeMs || info.size !== stamp.size) {
            consistent = false;
            break;
          }
        }
      }
    } catch {
      consistent = false;
    }
    if (consistent) {
      const capturedAt = new Date().toISOString();
      return {
        id: sha256([repository.id, result.head ?? 'unborn', capturedAt, randomUUID()].join('\u0000')),
        repoId: repository.id,
        head: result.head,
        capturedAt,
        files: result.files
      };
    }
  }

  throw new SnapshotError(
    'snapshot_changed',
    `仓库在读取期间持续发生变化（已重试 ${maxAttempts} 次）。请稍后刷新重试。`,
    {retryable: true}
  );
}
