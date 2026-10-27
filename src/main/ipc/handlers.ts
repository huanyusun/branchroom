import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import type { RecentRepositoryStore } from '../services/recent-store';
import { openRepository, repositoryIdForRoot } from '../services/repositories';
import type { Repository, RepositoryEntry, Result } from '../../shared/contracts';
import {
  parseNoInput,
  parseOpenRepositoryInput,
  parseRemoveRepositoryInput
} from '../../shared/schemas';

export interface HandlerContext {
  getWindow(): BrowserWindow | null;
  recentStore: RecentRepositoryStore;
  isDev: boolean;
}

const CHANNELS = {
  chooseRepository: 'branchroom:choose-repository',
  listRepositories: 'branchroom:list-repositories',
  listRepositoryEntries: 'branchroom:list-repository-entries',
  openRepositoryPath: 'branchroom:open-repository-path',
  removeRepository: 'branchroom:remove-repository'
} as const;

function ok<T>(data: T): Result<T> {
  return {ok: true, data};
}

function fail<T>(code: string, message: string, retryable = false): Result<T> {
  return {ok: false, error: {code, message, retryable}};
}

function toErrorInfo(error: unknown): {code: string; message: string; retryable: boolean} {
  if (error instanceof Error && 'code' in error && typeof (error as {code: unknown}).code === 'string') {
    const repositoryError = error as Error & {code: string; retryable?: boolean};
    return {code: repositoryError.code, message: error.message, retryable: repositoryError.retryable ?? false};
  }
  // 意外错误不向 renderer 泄露堆栈细节
  return {code: 'internal_error', message: '发生未预期的错误，请重试；若持续出现请查看日志。', retryable: true};
}

export function isTrustedSender(event: IpcMainInvokeEvent, isDev: boolean): boolean {
  const url = event.senderFrame?.url ?? '';
  if (url === '' ) return false;
  if (url.startsWith('branchroom://app/')) return true;
  if (isDev && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url)) return true;
  return false;
}

/** 重新校验一条最近记录：返回当前身份；路径失效或不再是有效仓库时返回 null。 */
async function resolveEntry(recordRoot: string): Promise<Repository | null> {
  try {
    return await openRepository(recordRoot);
  } catch {
    return null;
  }
}

export function registerRepositoryHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  const guard = (
    channel: string,
    handler: (input: unknown) => Promise<Result<unknown>>
  ): void => {
    ipcMain.handle(channel, async (event, input): Promise<Result<unknown>> => {
      if (!isTrustedSender(event, ctx.isDev)) {
        return fail('ipc_forbidden', 'IPC 请求来源不受信任。');
      }
      try {
        return await handler(input);
      } catch (error) {
        const info = toErrorInfo(error);
        return fail(info.code, info.message, info.retryable);
      }
    });
  };

  guard(CHANNELS.chooseRepository, async (input) => {
    const parsed = parseNoInput(input);
    if (!parsed.ok) return fail('invalid_input', parsed.message);
    const window = ctx.getWindow();
    const selection = window
      ? await dialog.showOpenDialog(window, {
          title: '选择 Git 仓库',
          buttonLabel: '打开仓库',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择 Git 仓库',
          buttonLabel: '打开仓库',
          properties: ['openDirectory', 'createDirectory']
        });
    if (selection.canceled || selection.filePaths.length === 0) {
      return ok<Repository | null>(null); // 取消不是异常
    }
    const repository = await openRepository(selection.filePaths[0]!);
    await ctx.recentStore.add(repository);
    return ok<Repository | null>(repository);
  });

  guard(CHANNELS.listRepositories, async (input) => {
    const parsed = parseNoInput(input);
    if (!parsed.ok) return fail('invalid_input', parsed.message);
    const records = await ctx.recentStore.list();
    const repositories: Repository[] = [];
    for (const record of records) {
      const repository = await resolveEntry(record.repository.root);
      if (repository) repositories.push(repository);
    }
    return ok(repositories);
  });

  guard(CHANNELS.listRepositoryEntries, async (input) => {
    const parsed = parseNoInput(input);
    if (!parsed.ok) return fail('invalid_input', parsed.message);
    const records = await ctx.recentStore.list();
    const entries: RepositoryEntry[] = [];
    for (const record of records) {
      const repository = await resolveEntry(record.repository.root);
      entries.push({
        id: repositoryIdForRoot(record.repository.root),
        repository,
        root: repository?.root ?? record.repository.root,
        name: repository?.name ?? record.repository.name,
        lastOpenedAt: record.lastOpenedAt
      });
    }
    return ok(entries);
  });

  guard(CHANNELS.openRepositoryPath, async (input) => {
    const parsed = parseOpenRepositoryInput(input);
    if (!parsed.ok) return fail('invalid_input', parsed.message);
    const repository = await openRepository(parsed.value.root);
    await ctx.recentStore.add(repository);
    return ok(repository);
  });

  guard(CHANNELS.removeRepository, async (input) => {
    const parsed = parseRemoveRepositoryInput(input);
    if (!parsed.ok) return fail('invalid_input', parsed.message);
    await ctx.recentStore.remove(parsed.value.id);
    return ok(undefined);
  });
}
