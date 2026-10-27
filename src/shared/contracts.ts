// 与 docs/CONTRACTS.md 保持一致的纯数据类型。禁止在此文件导入 Electron / Node / Bun。
// BR-001 只暴露 chooseRepository / listRepositories / listRepositoryEntries /
// removeRepository / openRepositoryPath；其余方法待对应任务实现后开放，不返回伪造结果。

export type RepoId = string;
export type SnapshotId = string;
export type RunId = string;
export type FileId = string;
export type Provider = 'codex' | 'claude';
export type ReviewState = 'pending' | 'reviewed' | 'issue' | 'recheck';

export interface Repository {
  id: RepoId;
  name: string;
  root: string;
  gitDir: string;
  commonGitDir: string;
  branch: string | null;
  head: string | null; // 未创建首次提交时为空；branch 为 null 且 head 非空表示分离 HEAD
}

export interface ChangeFile {
  id: FileId;
  path: string;
  previousPath: string | null;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';
  indexStatus: string;
  worktreeStatus: string;
  fingerprint: string;
  baseContent: string | null;
  currentContent: string | null;
  patch: string | null;
  reviewable: boolean;
  unavailableReason: string | null;
  reviewState: ReviewState;
}

export interface Snapshot {
  id: SnapshotId;
  repoId: RepoId;
  head: string | null;
  capturedAt: string;
  files: ChangeFile[];
}

export interface Finding {
  id: string;
  kind: 'issue' | 'verify';
  priority: 'P1' | 'P2' | 'P3';
  fileId: FileId;
  side: 'base' | 'current'; // 删除行定位 base，不能伪造当前行
  startLine: number;
  endLine: number;
  title: string;
  body: string;
  evidence: string;
  suggestion: string;
  fingerprint: string;
  disposition: 'open' | 'accepted' | 'dismissed';
}

export interface AgentReport {
  summary: string;
  coverage: FileId[];
  skipped: Array<{fileId: FileId; reason: string}>;
  limitations: string[];
  findings: Finding[];
}

export interface ReviewRun {
  id: RunId;
  repoId: RepoId;
  snapshotId: SnapshotId;
  provider: Provider;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  fileIds: FileId[];
  startedAt: string | null;
  finishedAt: string | null;
  report: AgentReport | null;
  error: {code: string; message: string} | null;
}

export interface AgentCapability {
  provider: Provider;
  executable: string | null;
  version: string | null;
  status: 'missing' | 'unauthenticated' | 'incompatible' | 'available' | 'unchecked';
  diagnostic: string | null;
}

export type Result<T> =
  | {ok: true; data: T}
  | {ok: false; error: {code: string; message: string; retryable: boolean}};

/** 最近仓库列表条目；repository 为 null 表示该路径已失效（已删除或不再是 Git 仓库）。id 由根路径派生，失效时仍可用。 */
export interface RepositoryEntry {
  id: RepoId;
  repository: Repository | null;
  root: string;
  name: string;
  lastOpenedAt: string;
}

/** BR-001 阶段 preload 实际暴露的 API 子集。 */
export type ExposedBranchroomAPI = Pick<
  BranchroomAPI,
  'chooseRepository' | 'listRepositories'
> & {
  /** 按已知路径重新打开最近仓库；主进程会重新校验它是有效 Git 仓库。 */
  openRepositoryPath(root: string): Promise<Result<Repository>>;
  /** 移除一条最近仓库记录，不删除磁盘内容。 */
  removeRepository(id: RepoId): Promise<Result<void>>;
  /** 最近仓库完整列表，包含已失效路径，供“重新打开/移除”入口使用。 */
  listRepositoryEntries(): Promise<Result<RepositoryEntry[]>>;
};

export interface BranchroomAPI {
  chooseRepository(): Promise<Result<Repository | null>>; // 取消不是异常
  listRepositories(): Promise<Result<Repository[]>>;
  getSnapshot(repoId: RepoId): Promise<Result<Snapshot>>;
  saveReview(input: {
    repoId: RepoId; snapshotId: SnapshotId; fileId: FileId;
    expectedFingerprint: string; state: 'pending' | 'reviewed' | 'issue'; note: string;
  }): Promise<Result<void>>;
  listAgents(): Promise<Result<AgentCapability[]>>;
  startReview(input: {
    repoId: RepoId; snapshotId: SnapshotId; fileIds: FileId[]; provider: Provider;
  }): Promise<Result<ReviewRun>>;
  cancelReview(runId: RunId): Promise<Result<void>>;
  listRuns(repoId: RepoId): Promise<Result<ReviewRun[]>>;
  onReviewRun(listener: (run: ReviewRun) => void): () => void;
}
