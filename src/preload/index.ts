import { contextBridge, ipcRenderer } from 'electron';
import type {
  ExposedBranchroomAPI,
  Repository,
  RepositoryEntry,
  Result
} from '../shared/contracts';

import type { Snapshot } from '../shared/contracts';

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
    ipcRenderer.invoke('branchroom:get-snapshot', {repoId}) as Promise<Result<Snapshot>>
};

contextBridge.exposeInMainWorld('branchroom', api);
