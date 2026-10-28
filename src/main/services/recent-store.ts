import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Repository } from '../../shared/contracts';

export const RECENT_REPOSITORIES_LIMIT = 20;
const SCHEMA_VERSION = 1;

export interface RecentRepositoryRecord {
  repository: Repository;
  lastOpenedAt: string;
}

interface StoreData {
  schemaVersion: number;
  entries: RecentRepositoryRecord[];
}

export interface RecentRepositoryStore {
  /** 按打开顺序返回（旧 → 新）。不校验路径是否仍然有效。 */
  list(): Promise<RecentRepositoryRecord[]>;
  /** 按 repository.id 去重并刷新时间，超出上限时丢弃最旧记录。 */
  add(repository: Repository): Promise<void>;
  remove(id: string): Promise<void>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isValidRepository(value: unknown): value is Repository {
  if (typeof value !== 'object' || value === null) return false;
  const repo = value as Record<string, unknown>;
  return (
    isNonEmptyString(repo.id)
    && isNonEmptyString(repo.name)
    && isNonEmptyString(repo.root)
    && isNonEmptyString(repo.gitDir)
    && isNonEmptyString(repo.commonGitDir)
    && (repo.branch === null || isNonEmptyString(repo.branch))
    && (repo.head === null || isNonEmptyString(repo.head))
  );
}

function isValidRecord(value: unknown): value is RecentRepositoryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as {repository?: unknown; lastOpenedAt?: unknown};
  if (!isValidRepository(record.repository)) return false;
  if (!isNonEmptyString(record.lastOpenedAt)) return false;
  return Number.isFinite(Date.parse(record.lastOpenedAt));
}

/**
 * 最近仓库列表存储：userData 下单个版本化 JSON。
 * 所有读改写串行执行（CHECK-04），原子写入用唯一临时名；深度 schema 校验
 * 拒绝残缺记录（CHECK-05）；除文件不存在外的读取错误直接抛出，不伪装成空。
 */
export function createRecentStore(filePath: string): RecentRepositoryStore {
  let queue: Promise<unknown> = Promise.resolve();
  let tmpSeq = 0;

  /** 完整读改写串行化：任何一步失败都不影响后续排队操作。 */
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<RecentRepositoryRecord[]> => {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as {code?: unknown}).code === 'ENOENT') {
        return []; // 首次使用，没有文件是正常情况
      }
      throw error; // 权限/IO 问题不能伪装成空存储
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== 'object' || parsed === null
        || (parsed as {schemaVersion?: unknown}).schemaVersion !== SCHEMA_VERSION
        || !Array.isArray((parsed as {entries?: unknown}).entries)
        || !(parsed as {entries: unknown[]}).entries.every(isValidRecord)
      ) {
        throw new Error('schema mismatch');
      }
      return (parsed as {entries: RecentRepositoryRecord[]}).entries;
    } catch (error) {
      // 损坏数据不阻塞应用：备份原文件后从空列表开始；备份失败也要如实记录
      const backup = `${filePath}.corrupt-${Date.now()}`;
      let backedUp = true;
      try {
        await rename(filePath, backup);
      } catch (backupError) {
        backedUp = false;
        console.warn('[branchroom] 最近仓库列表损坏，且备份失败', backupError, error);
      }
      if (backedUp) {
        console.warn(`[branchroom] 最近仓库列表损坏，已备份到 ${backup}`, error);
      }
      return [];
    }
  };

  const save = async (entries: RecentRepositoryRecord[]): Promise<void> => {
    const data: StoreData = {schemaVersion: SCHEMA_VERSION, entries};
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    await mkdir(dirname(filePath), {recursive: true});
    const tmpPath = `${filePath}.${Date.now()}-${tmpSeq++}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      await writeFile(tmpPath, '').catch(() => undefined); // 清理残留临时文件尽力而为
      throw error;
    }
  };

  const mutate = async (
    transform: (entries: RecentRepositoryRecord[]) => Promise<RecentRepositoryRecord[]> | RecentRepositoryRecord[]
  ): Promise<void> => {
    await enqueue(async () => {
      await save(await transform(await load()));
    });
  };

  return {
    list(): Promise<RecentRepositoryRecord[]> {
      return enqueue(() => load());
    },
    async add(repository) {
      await mutate(async (entries) => {
        const next = entries.filter((entry) => entry.repository.id !== repository.id);
        next.push({repository, lastOpenedAt: new Date().toISOString()});
        while (next.length > RECENT_REPOSITORIES_LIMIT) next.shift();
        return next;
      });
    },
    async remove(id) {
      await mutate(async (entries) => entries.filter((entry) => entry.repository.id !== id));
    }
  };
}
