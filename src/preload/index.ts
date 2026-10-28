import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentCapability,
  ExposedBranchroomAPI,
  Repository,
  RepositoryEntry,
  Result,
  ReviewOverview,
  ReviewRun,
  Snapshot
} from '../shared/contracts';
import type { SaveDraftInput, SaveReviewInput, StartReviewInput } from '../shared/schemas';

// 只暴露具体方法；不暴露 ipcRenderer 或原始 invoke。
// 返回值类型是主进程 Result 的镜像；跨 IPC 的运行时数据由主进程 schema 校验保证。
const api: ExposedBranchroomAPI = {
  chooseRepository: (): Promise<Result<Repository | null>> =>
    ipcRenderer.invoke('branchroom:choose-repository') as Promise<Result<Repository | null>>,
  listRepositories: (): Promise<Result<Repository[]>> =>
    ipcRenderer.invoke('branchroom:list-repositories') as Promise<Result<Repository[]>>,
  listRepositoryEntries: (): Promise<Result<RepositoryEntry[]>> =>
    ipcRenderer.invoke('branchroom:list-repository-entries') as Promise<Result<RepositoryEntry[]>>,
  openRepositoryPath: (root: string): Promise<Result<Repository>> =>
    ipcRenderer.invoke('branchroom:open-repository-path', {root}) as Promise<Result<Repository>>,
  removeRepository: (id: string): Promise<Result<void>> =>
    ipcRenderer.invoke('branchroom:remove-repository', {id}) as Promise<Result<void>>,
  getSnapshot: (repoId: string): Promise<Result<Snapshot>> =>
    ipcRenderer.invoke('branchroom:get-snapshot', {repoId}) as Promise<Result<Snapshot>>,
  saveReview: (input: SaveReviewInput): Promise<Result<void>> =>
    ipcRenderer.invoke('branchroom:save-review', input) as Promise<Result<void>>,
  saveDraft: (input: SaveDraftInput): Promise<Result<void>> =>
    ipcRenderer.invoke('branchroom:save-draft', input) as Promise<Result<void>>,
  listReviewEntries: (repoId: string): Promise<Result<ReviewOverview>> =>
    ipcRenderer.invoke('branchroom:list-review-entries', {repoId}) as Promise<Result<ReviewOverview>>,
  clearDraft: (repoId: string, fileId: string): Promise<Result<void>> =>
    ipcRenderer.invoke('branchroom:clear-draft', {repoId, fileId}) as Promise<Result<void>>,
  listAgents: (): Promise<Result<AgentCapability[]>> =>
    ipcRenderer.invoke('branchroom:list-agents') as Promise<Result<AgentCapability[]>>,
  startReview: (input: StartReviewInput): Promise<Result<ReviewRun>> =>
    ipcRenderer.invoke('branchroom:start-review', input) as Promise<Result<ReviewRun>>,
  cancelReview: (runId: string): Promise<Result<void>> =>
    ipcRenderer.invoke('branchroom:cancel-review', {runId}) as Promise<Result<void>>,
  listRuns: (repoId: string): Promise<Result<ReviewRun[]>> =>
    ipcRenderer.invoke('branchroom:list-runs', {repoId}) as Promise<Result<ReviewRun[]>>,
  onReviewRun: (listener: (run: ReviewRun) => void): (() => void) => {
    const handler = (_event: unknown, run: ReviewRun): void => listener(run);
    ipcRenderer.on('branchroom:review-run-event', handler);
    return () => {
      ipcRenderer.removeListener('branchroom:review-run-event', handler);
    };
  }
};

contextBridge.exposeInMainWorld('branchroom', api);
