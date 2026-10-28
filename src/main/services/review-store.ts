import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewState } from '../../shared/contracts';

/** 人工反馈的长度上限（UTF-8 字节）。超限明确报错，绝不截断。 */
export const NOTE_MAX_BYTES = 64 * 1024;

export function noteByteLength(note: string): number {
  return Buffer.byteLength(note, 'utf8');
}

/** 内容身份：只绑定基线内容与当前内容，不包含 HEAD 或暂存位置。 */
export function contentIdentityOf(baseContent: string | null, currentContent: string | null): string {
  return createHash('sha256')
    .update(`${baseContent ?? ''}\u0000${currentContent ?? ''}`)
    .digest('hex');
}

/** 已保存的人工结论；recheck 是派生态，不写入存储。 */
export interface ReviewEntry {
  state: 'reviewed' | 'issue';
  note: string;
  contentIdentity: string;
  snapshotId: string;
  updatedAt: string;
}

export interface DraftEntry {
  note: string;
  contentIdentity: string;
  snapshotId: string;
  updatedAt: string;
}

export interface ReviewData {
  schemaVersion: 1;
  reviews: Record<string, ReviewEntry>;
  drafts: Record<string, DraftEntry>;
}

export interface ReviewStore {
  load(repoId: string): Promise<ReviewData>;
  setReview(repoId: string, fileId: string, entry: ReviewEntry): Promise<void>;
  clearReview(repoId: string, fileId: string): Promise<void>;
  setDraft(repoId: string, fileId: string, entry: DraftEntry): Promise<void>;
  clearDraft(repoId: string, fileId: string): Promise<void>;
}

const SCHEMA_VERSION = 1;

function emptyData(): ReviewData {
  return {schemaVersion: SCHEMA_VERSION, reviews: {}, drafts: {}};
}

function isValidData(parsed: unknown): parsed is ReviewData {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const data = parsed as {schemaVersion?: unknown; reviews?: unknown; drafts?: unknown};
  return (
    data.schemaVersion === SCHEMA_VERSION
    && typeof data.reviews === 'object' && data.reviews !== null
    && typeof data.drafts === 'object' && data.drafts !== null
  );
}

/**
 * 按仓库 ID 分目录的版本化 JSON 存储（userData/reviews/<repoId>/state.json）。
 * 原子写入；损坏文件备份后从空状态开始，不阻塞应用。
 */
export function createReviewStore(baseDir: string): ReviewStore {
  const repoPath = (repoId: string): string => join(baseDir, repoId);
  const filePath = (repoId: string): string => join(repoPath(repoId), 'state.json');

  const load = async (repoId: string): Promise<ReviewData> => {
    let raw: string;
    try {
      raw = await readFile(filePath(repoId), 'utf8');
    } catch {
      return emptyData(); // 首次使用没有文件是正常情况
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isValidData(parsed)) throw new Error('schema mismatch');
      return parsed;
    } catch (error) {
      const backup = `${filePath(repoId)}.corrupt-${Date.now()}`;
      await rename(filePath(repoId), backup).catch(() => undefined);
      console.warn(`[branchroom] 审查记录损坏，已备份到 ${backup}`, error);
      return emptyData();
    }
  };

  const save = async (repoId: string, data: ReviewData): Promise<void> => {
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    await mkdir(repoPath(repoId), {recursive: true});
    const tmpPath = `${filePath(repoId)}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, filePath(repoId));
  };

  const mutate = async (
    repoId: string,
    transform: (data: ReviewData) => void
  ): Promise<void> => {
    const data = await load(repoId);
    transform(data);
    await save(repoId, data);
  };

  return {
    load,
    async setReview(repoId, fileId, entry) {
      await mutate(repoId, (data) => {
        data.reviews[fileId] = entry;
      });
    },
    async clearReview(repoId, fileId) {
      await mutate(repoId, (data) => {
        delete data.reviews[fileId];
      });
    },
    async setDraft(repoId, fileId, entry) {
      await mutate(repoId, (data) => {
        data.drafts[fileId] = entry;
      });
    },
    async clearDraft(repoId, fileId) {
      await mutate(repoId, (data) => {
        delete data.drafts[fileId];
      });
    }
  };
}

/**
 * 把已保存的结论套到当前快照文件上：
 * 身份一致 → 保留状态；基线或当前内容变化 → 派生 recheck；无记录 → pending。
 * 只派生，不改写存储。
 */
export function applyReviewStates(
  files: Array<{path: string; baseContent: string | null; currentContent: string | null; reviewState: ReviewState}>,
  data: Pick<ReviewData, 'reviews'>
): void {
  for (const file of files) {
    const entry = data.reviews[file.path];
    if (entry === undefined) {
      file.reviewState = 'pending';
      continue;
    }
    const identity = contentIdentityOf(file.baseContent, file.currentContent);
    file.reviewState = identity === entry.contentIdentity ? entry.state : 'recheck';
  }
}
