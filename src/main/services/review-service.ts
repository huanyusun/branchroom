import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snapshot } from '../../shared/contracts';
import type { RepositoryRegistry } from './repositories';
import {
  type DraftEntry,
  type ReviewData,
  type ReviewEntry,
  type ReviewStore,
  contentIdentityOf,
  noteByteLength,
  NOTE_MAX_BYTES
} from './review-store';
import { parseStatusZ, runGit, runGitBuffer } from './git';

/** 人工审查流程错误：code 遵循 docs/CONTRACTS.md。 */
export class ReviewError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: {retryable?: boolean; cause?: unknown}) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
    if (options?.cause !== undefined) {
      (this as {cause?: unknown}).cause = options.cause;
    }
  }
}

interface SnapshotFileRecord {
  fingerprint: string;
  contentIdentity: string;
}

/** 本会话内 snapshotId → 文件身份的登记表；保存结论时用于核对。 */
export class SnapshotRegistry {
  readonly #bySnapshot = new Map<string, {repoId: string; files: Map<string, SnapshotFileRecord>}>();
  readonly #snapshots = new Map<string, Snapshot>();
  readonly #latest = new Map<string, string>();

  remember(snapshot: Snapshot): void {
    const files = new Map<string, SnapshotFileRecord>();
    for (const file of snapshot.files) {
      files.set(file.path, {
        fingerprint: file.fingerprint,
        contentIdentity: contentIdentityOf(file.baseContent, file.currentContent)
      });
    }
    this.#bySnapshot.set(snapshot.id, {repoId: snapshot.repoId, files});
    this.#snapshots.set(snapshot.id, snapshot);
    this.#latest.set(snapshot.repoId, snapshot.id);
  }

  recordOf(snapshotId: string, fileId: string): SnapshotFileRecord | null {
    return this.#bySnapshot.get(snapshotId)?.files.get(fileId) ?? null;
  }

  fileOf(snapshotId: string, fileId: string): SnapshotFileRecord | null {
    return this.recordOf(snapshotId, fileId);
  }

  snapshotOf(snapshotId: string): Snapshot | null {
    return this.#snapshots.get(snapshotId) ?? null;
  }

  latestFor(repoId: string): string | null {
    return this.#latest.get(repoId) ?? null;
  }
}

export interface ReviewInput {
  repoId: string;
  snapshotId: string;
  fileId: string;
  expectedFingerprint: string;
  state: 'pending' | 'reviewed' | 'issue';
  note: string;
}

export interface DraftInput {
  repoId: string;
  snapshotId: string;
  fileId: string;
  expectedFingerprint: string;
  note: string;
}

export interface ReviewEntryView extends ReviewEntry {
  fileId: string;
  stale: boolean;
}

export interface DraftEntryView extends DraftEntry {
  fileId: string;
  stale: boolean;
}

export interface ReviewOverview {
  reviews: Record<string, ReviewEntryView>;
  drafts: Record<string, DraftEntryView>;
}

function isBinaryBuffer(bytes: Buffer): boolean {
  const end = Math.min(bytes.length, 8000);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * 计算一个路径此刻的内容身份，规则与 snapshots.buildChangeFile 完全一致：
 * 文本文件取（HEAD 基线, 工作区内容）；二进制/不可读视为 (null, null)；
 * 干净路径两侧都是 HEAD 内容。用于保存前的真实复核。
 */
async function liveIdentity(root: string, fileId: string): Promise<string> {
  let base: string | null = null;
  let current: string | null = null;

  const statusOutput = await runGit(root, [
    '--no-optional-locks', 'status', '--porcelain=v2', '--untracked-files=all', '-z', '--', fileId
  ]);
  const record = parseStatusZ(statusOutput).find((entry) => entry.path === fileId || entry.origPath === fileId);

  if (record === undefined) {
    // 干净路径：基线与当前都是 HEAD 内容；不在 HEAD 则两侧皆空
    try {
      const bytes = await runGitBuffer(root, ['cat-file', 'blob', `HEAD:${fileId}`]);
      if (!isBinaryBuffer(bytes)) {
        const content = bytes.toString('utf8');
        base = content;
        current = content;
      }
    } catch {
      base = null;
      current = null;
    }
    return contentIdentityOf(base, current);
  }

  if (record.headBlob !== null) {
    try {
      const bytes = await runGitBuffer(root, ['cat-file', 'blob', record.headBlob]);
      if (!isBinaryBuffer(bytes)) base = bytes.toString('utf8');
    } catch {
      base = null;
    }
  }

  if (record.indexStatus !== 'D' && record.worktreeStatus !== 'D' && !record.submodule) {
    const absolute = join(root, record.path);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        current = await readlink(absolute);
      } else if (info.size <= 1024 * 1024) {
        const bytes = await readFile(absolute);
        if (!isBinaryBuffer(bytes)) current = bytes.toString('utf8');
      }
    } catch {
      current = null;
    }
  }

  return contentIdentityOf(base, current);
}

/** 校验并落盘人工审查结论 / 草稿。保存前对指纹与会话登记表、磁盘真实状态做双重核对。 */
export class ReviewService {
  constructor(
    private readonly store: ReviewStore,
    private readonly snapshots: SnapshotRegistry,
    private readonly registry: RepositoryRegistry
  ) {}

  private async verify(
    input: {repoId: string; snapshotId: string; fileId: string; expectedFingerprint: string; note: string}
  ): Promise<{root: string; contentIdentity: string}> {
    if (noteByteLength(input.note) > NOTE_MAX_BYTES) {
      throw new ReviewError(
        'note_too_large',
        `反馈长度 ${noteByteLength(input.note)} 字节，超过 ${NOTE_MAX_BYTES} 字节上限。请缩短后重试；内容不会被截断保存。`,
        {retryable: false}
      );
    }
    const root = this.registry.rootOf(input.repoId);
    if (root === null) {
      throw new ReviewError('repository_unavailable', '此仓库尚未在本会话打开，请先重新打开。');
    }
    const record = this.snapshots.recordOf(input.snapshotId, input.fileId);
    if (record === null || record.fingerprint !== input.expectedFingerprint) {
      throw new ReviewError(
        'content_changed',
        '结论对应的快照已过期或不存在，请刷新后基于最新内容重新标记。原草稿已保留。',
        {retryable: false}
      );
    }
    const live = await liveIdentity(root, input.fileId);
    if (live !== record.contentIdentity) {
      throw new ReviewError(
        'content_changed',
        '文件内容在读取之后又发生了变化，结论未保存。请刷新后基于最新内容重新标记。原草稿已保留。',
        {retryable: false}
      );
    }
    return {root, contentIdentity: record.contentIdentity};
  }

  async saveReview(input: ReviewInput): Promise<void> {
    const {contentIdentity} = await this.verify(input);
    const now = new Date().toISOString();
    if (input.state === 'pending') {
      await this.store.clearReview(input.repoId, input.fileId);
      await this.store.clearDraft(input.repoId, input.fileId);
      return;
    }
    const entry: ReviewEntry = {
      state: input.state,
      note: input.note,
      contentIdentity,
      snapshotId: input.snapshotId,
      updatedAt: now
    };
    await this.store.setReview(input.repoId, input.fileId, entry);
    await this.store.clearDraft(input.repoId, input.fileId); // 草稿已转成正式结论
  }

  async saveDraft(input: DraftInput): Promise<void> {
    const {contentIdentity} = await this.verify(input);
    const entry: DraftEntry = {
      note: input.note,
      contentIdentity,
      snapshotId: input.snapshotId,
      updatedAt: new Date().toISOString()
    };
    await this.store.setDraft(input.repoId, input.fileId, entry);
  }

  async clearDraft(repoId: string, fileId: string): Promise<void> {
    await this.store.clearDraft(repoId, fileId);
  }

  /** 供 getSnapshot 组装时读取已保存的人工结论。 */
  loadReviewData(repoId: string): Promise<Pick<ReviewData, 'reviews'>> {
    return this.store.load(repoId);
  }

  /** 供 getSnapshot 组装后登记快照身份，供保存核验使用。 */
  rememberSnapshot(snapshot: Snapshot): void {
    this.snapshots.remember(snapshot);
  }

  async listEntries(repoId: string): Promise<ReviewOverview> {
    const data: ReviewData = await this.store.load(repoId);
    const latest = this.snapshots.latestFor(repoId);
    const overview: ReviewOverview = {reviews: {}, drafts: {}};

    for (const [fileId, entry] of Object.entries(data.reviews)) {
      const stale = latest === null
        ? false
        : (this.snapshots.recordOf(latest, fileId)?.contentIdentity ?? entry.contentIdentity) !== entry.contentIdentity;
      overview.reviews[fileId] = {...entry, fileId, stale};
    }
    for (const [fileId, draft] of Object.entries(data.drafts)) {
      const stale = latest === null
        ? false
        : (this.snapshots.recordOf(latest, fileId)?.contentIdentity ?? draft.contentIdentity) !== draft.contentIdentity;
      overview.drafts[fileId] = {...draft, fileId, stale};
    }
    return overview;
  }
}
