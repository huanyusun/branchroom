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

export function createRecentStore(filePath: string): RecentRepositoryStore {
  const isValidRecord = (value: unknown): value is RecentRepositoryRecord => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as {repository?: unknown; lastOpenedAt?: unknown};
    return typeof record.repository === 'object' && record.repository !== null
      && typeof record.lastOpenedAt === 'string';
  };

  const load = async (): Promise<RecentRepositoryRecord[]> => {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return []; // 首次使用，没有文件是正常情况
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
      // 损坏数据不阻塞应用：备份原文件后从空列表开始
      const backup = `${filePath}.corrupt-${Date.now()}`;
      await rename(filePath, backup).catch(() => undefined);
      console.warn(`[branchroom] 最近仓库列表损坏，已备份到 ${backup}`, error);
      return [];
    }
  };

  const save = async (entries: RecentRepositoryRecord[]): Promise<void> => {
    const data: StoreData = {schemaVersion: SCHEMA_VERSION, entries};
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    await mkdir(dirname(filePath), {recursive: true});
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, payload, 'utf8');
    await rename(tmpPath, filePath);
  };

  return {
    async list() {
      return load();
    },
    async add(repository) {
      const entries = (await load()).filter((entry) => entry.repository.id !== repository.id);
      entries.push({repository, lastOpenedAt: new Date().toISOString()});
      while (entries.length > RECENT_REPOSITORIES_LIMIT) entries.shift();
      await save(entries);
    },
    async remove(id) {
      const entries = (await load()).filter((entry) => entry.repository.id !== id);
      await save(entries);
    }
  };
}
