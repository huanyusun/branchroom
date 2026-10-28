# 首个切片接口契约

下列为正式实现的约定。类型已放入 src/shared/contracts.ts，IPC 输入在 src/shared/schemas.ts 做运行时校验。已实现并暴露：chooseRepository、listRepositories、getSnapshot、saveReview、saveDraft、listReviewEntries、clearDraft（BR-002/003）、openRepositoryPath、removeRepository、listRepositoryEntries；其余方法待对应任务。

```ts
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
  head: string | null; // 未创建首次提交时为空
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

export interface BranchroomAPI {
  chooseRepository(): Promise<Result<Repository | null>>; // 取消不是异常
  listRepositories(): Promise<Result<Repository[]>>;
  // BR-001 额外暴露（已实现）：openRepositoryPath(root)、removeRepository(id)、
  // listRepositoryEntries()，见 src/shared/contracts.ts 的 ExposedBranchroomAPI。
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
```

## 状态与失败语义

- 人工 pending → reviewed / issue；重新读取时内容不匹配则 derived recheck。同内容 stage/unstage 不触发 recheck。
- run queued → running → succeeded / failed / cancelled；服务崩溃后 unfinished run → interrupted，不自动再计费重跑。
- 相同 snapshot 可以多次 run；启动请求用 request ID 防重复。取消针对所属 run/process，不允许旧任务输出终止新任务。
- 保存人工结论前再次核对 expectedFingerprint；不符返回 content_changed，保留前端草稿。
- 错误码至少包含 not_git_repository、repository_unavailable、snapshot_changed、content_changed、file_unreviewable、agent_missing、agent_auth_required、agent_incompatible、agent_failed、invalid_report、run_busy、note_too_large。
- 对上限的拒绝必须说明范围和补救方式。不要 slice 后假装完整保存/审查。

## Agent 输出与应用内部 ID

模型输入可携带 fileId、路径、base/current 行号，模型输出按白名单映射回内部 ID。不得将模型给出的任意路径交给系统文件读取。

运行时校验：完整 coverage；schema；真实范围内路径/ID；对应 side 的合法行号；fingerprint 绑定；优先级枚举；字符串非空；输出大小；重复意见。报告覆盖不完整返回 invalid_report 或显式部分覆盖状态，不能显示为整批通过。

stale 是 Finding 与当前 Snapshot 的匹配结果，不改写历史 run。过期后禁用直接采用；用户可以查看历史上下文或重新审查。
