import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeFile, Repository, Snapshot } from '../../shared/contracts';
import {
  RepositoryError,
  type PatchChunk,
  type StatusRecord,
  parseStatusZ,
  resolveHead,
  runGit,
  runGitBuffer,
  splitPatchByFile
} from './git';
import { type ReviewData, applyReviewStates } from './review-store';

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
  /** 已保存的人工审查记录；构建时套用到文件状态（recheck 为派生结果）。 */
  reviewData?: Pick<ReviewData, 'reviews'>;
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
  /** 捕获开始时的完整 status 序列，用于结束后深度核对（覆盖新增/消失/仅 index 变化）。 */
  statusOutput: string;
}

function kindOf(record: StatusRecord): ChangeFile['kind'] {
  if (record.unmerged) return 'conflicted';
  if (record.origPath !== null) return 'renamed';
  if (record.headBlob === null && (record.code === 'untracked' || record.indexStatus === 'A' || record.worktreeStatus === 'A')) {
    return 'added';
  }
  if (record.indexStatus === 'D' || record.worktreeStatus === 'D') return 'deleted';
  return 'modified';
}

/**
 * 同一路径可能出现多条记录（如暂存删除 + 工作区重建）。
 * 快照范围是“HEAD 到当前工作区”，必须合并为单一条目，避免重复 ID 与错配 patch。
 */
function mergeRecordsByPath(records: StatusRecord[]): {merged: StatusRecord[]; mergedPaths: Set<string>} {
  const byPath = new Map<string, StatusRecord[]>();
  for (const record of records) {
    const group = byPath.get(record.path);
    if (group === undefined) byPath.set(record.path, [record]);
    else group.push(record);
  }

  const merged: StatusRecord[] = [];
  const mergedPaths = new Set<string>();
  for (const [path, group] of byPath) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    mergedPaths.add(path);
    const firstNon = <T>(select: (record: StatusRecord) => T): T | null => {
      for (const record of group) {
        const value = select(record);
        if (value !== null && value !== undefined && value !== ('' as never)) return value;
      }
      return null;
    };
    const activeIndex = firstNon((record) => (record.indexStatus !== '.' && record.indexStatus !== '?' ? record.indexStatus : null));
    const activeWorktree = firstNon((record) => (record.worktreeStatus !== '.' ? record.worktreeStatus : null));
    merged.push({
      code: group.some((record) => record.unmerged)
        ? 'unmerged'
        : group.some((record) => record.code === 'renamed')
          ? 'renamed'
          : group.some((record) => record.code === 'untracked')
            ? 'untracked'
            : 'changed',
      indexStatus: activeIndex ?? '.',
      worktreeStatus: activeWorktree ?? '.',
      submodule: group.some((record) => record.submodule),
      headBlob: firstNon((record) => record.headBlob),
      indexBlob: firstNon((record) => record.indexBlob),
      path,
      origPath: firstNon((record) => record.origPath),
      unmerged: group.some((record) => record.unmerged)
    });
  }
  merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {merged, mergedPaths};
}

const STATUS_ARGS = [
  '--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=all', '-z'
] as const;

async function runAttempt(
  repository: Repository,
  limits: {contentLimitBytes: number; patchLimitBytes: number},
  reviewData?: Pick<ReviewData, 'reviews'>
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
    statusOutput = await runGit(root, [...STATUS_ARGS]);
  } catch (error) {
    throw new SnapshotError('repository_unavailable', (error as Error).message, {cause: error});
  }
  const records = parseStatusZ(statusOutput).filter((record) => record.code !== 'ignored');
  const {merged, mergedPaths} = mergeRecordsByPath(records);

  let diffOutput = '';
  if (head !== null) {
    try {
      diffOutput = await runGit(
        root,
        ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--find-renames', '--no-ext-diff', '--no-textconv'],
        {maxBuffer: DIFF_MAX_BUFFER, overflowCode: 'diff_too_large'}
      );
    } catch (error) {
      if (error instanceof RepositoryError && error.code === 'diff_too_large') {
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
  for (const record of merged) {
    files.push(
      await buildChangeFile(repository, record, patchChunks, limits, head, mergedPaths.has(record.path))
    );
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (reviewData !== undefined) {
    applyReviewStates(files, reviewData);
  }
  return {head, files, statusOutput};
}

async function buildChangeFile(
  repository: Repository,
  record: StatusRecord,
  patchChunks: Map<string, PatchChunk>,
  limits: {contentLimitBytes: number; patchLimitBytes: number},
  head: string | null,
  isMergedPath: boolean
): Promise<ChangeFile> {
  const {root, id: repoId} = repository;

  // 子模块：gitlink 在 HEAD 里是 commit 对象而非 blob，绝不能按 blob 读取
  if (record.submodule) {
    const kind: ChangeFile['kind'] = record.unmerged ? 'conflicted' : 'modified';
    return {
      id: record.path,
      path: record.path,
      previousPath: record.origPath,
      kind,
      indexStatus: record.indexStatus,
      worktreeStatus: record.worktreeStatus,
      fingerprint: sha256([repoId, head ?? 'unborn', record.path, '', ''].join('\u0000')),
      baseContent: null,
      currentContent: null,
      patch: null,
      reviewable: false,
      unavailableReason: '子模块，暂不支持内容读取',
      reviewState: 'pending'
    };
  }

  let kind = kindOf(record);

  // CHECK-02：暂存删除 + 工作区重建时，磁盘上其实有新内容 → 净效果是内容变更
  if (kind === 'deleted') {
    try {
      const disk = await lstat(join(root, record.path));
      if (!disk.isDirectory()) {
        kind = record.headBlob !== null ? 'modified' : 'added';
      }
    } catch {
      // 磁盘确实没有文件，保持 deleted
    }
  }

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

  // Patch：冲突与合并路径跳过（combined diff / 单文件块不可信），其余按新路径取块
  let patch: string | null = null;
  if (kind === 'conflicted') {
    reviewable = false;
    unavailableReason = '文件处于合并冲突状态：暂不支持 Diff 审阅，可查看全文';
  } else if (isMergedPath) {
    // 同路径多条记录合并而来：整树 diff 无法表达这种中间状态，宁缺毋错
    patch = null;
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
    const result = await runAttempt(repository, limits, options.reviewData);
    await options.hooks?.beforeVerify?.();

    let consistent = true;
    try {
      const headNow = await resolveHead(repository.root);
      if (headNow !== result.head) {
        consistent = false;
      } else {
        // 深度核对：路径集合、暂存/工作区状态与 blob 哈希必须与捕获时完全一致。
        // 覆盖新增/消失的变更、仅 index 变化、以及基线或内容被替换的情况。
        const statusNow = await runGit(repository.root, [...STATUS_ARGS]);
        if (statusNow !== result.statusOutput) {
          consistent = false;
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
