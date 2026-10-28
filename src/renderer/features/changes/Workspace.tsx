import { useCallback, useEffect, useRef, useState } from 'react';
import type { Repository, Snapshot } from '../../../shared/contracts';
import type { DraftEntryView, ReviewEntryView } from '../../../shared/contracts';
import { createLatestGuard } from '../../lib/latest-guard';
import { AgentPanel } from '../agent-review/AgentPanel';
import { RepositoryIdentity } from '../repositories/RepositoryIdentity';
import { ReviewPanel } from '../review/ReviewPanel';
import { DiffView } from './DiffView';
import { FileList } from './FileList';

interface Props {
  repository: Repository;
}

type SnapshotState =
  | {status: 'loading'}
  | {status: 'ready'; snapshot: Snapshot}
  | {status: 'error'; code: string; message: string; retryable: boolean};

type Overview = {
  reviews: Record<string, ReviewEntryView>;
  drafts: Record<string, DraftEntryView>;
};

function shortHead(head: string | null): string {
  return head === null ? '尚无提交' : head.slice(0, 10);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', {hour12: false});
}

/** 打开仓库后的工作区：变更列表 + Diff/全文 + 人工审查面板，快照手动刷新。 */
export function Workspace({repository}: Props): React.JSX.Element {
  const [state, setState] = useState<SnapshotState>({status: 'loading'});
  const [overview, setOverview] = useState<Overview>({reviews: {}, drafts: {}});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // CHECK-07：只有最后一次请求的结果允许落地，切换仓库/快速刷新不会互相覆盖
  const guard = useRef(createLatestGuard());

  const selectFile = useCallback((path: string, line?: number) => {
    setSelectedPath(path);
    setFocusLine(line ?? null);
  }, []);

  const reloadOverview = useCallback(async () => {
    const result = await window.branchroom.listReviewEntries(repository.id);
    if (result.ok) setOverview(result.data);
  }, [repository.id]);

  const load = useCallback(async () => {
    const token = guard.current.begin();
    setState({status: 'loading'});
    const result = await window.branchroom.getSnapshot(repository.id);
    if (!guard.current.isCurrent(token)) return;
    if (result.ok) {
      const overviewResult = await window.branchroom.listReviewEntries(repository.id);
      if (!guard.current.isCurrent(token)) return;
      const nextOverview: Overview = overviewResult.ok
        ? overviewResult.data
        : {reviews: {}, drafts: {}};
      if (!overviewResult.ok) {
        setState({
          status: 'error',
          code: overviewResult.error.code,
          message: overviewResult.error.message,
          retryable: overviewResult.error.retryable
        });
        return;
      }
      setState({status: 'ready', snapshot: result.data});
      setOverview(nextOverview);
      setSelectedPath((current) =>
        current !== null && result.data.files.some((file) => file.path === current)
          ? current
          : (result.data.files[0]?.path ?? null)
      );
    } else {
      setState({
        status: 'error',
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable
      });
    }
  }, [repository.id]);

  useEffect(() => {
    void load();
    // 仓库切换或卸载时使进行中的请求失效
    return () => guard.current.invalidate();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const selected =
    state.status === 'ready'
      ? (state.snapshot.files.find((file) => file.path === selectedPath) ?? null)
      : null;

  return (
    <div className="workspace" data-testid="workspace">
      <header className="workspace-header">
        <div className="workspace-meta">
          <RepositoryIdentity repository={repository} compact={true} />
          {state.status === 'ready' && (
            <span className="snapshot-meta">
              HEAD <span className="mono">{shortHead(state.snapshot.head)}</span>
              {' · '}快照 {formatTime(state.snapshot.capturedAt)}
              {' · '}{state.snapshot.files.length} 个变更
            </span>
          )}
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </header>

      {state.status === 'loading' && <div className="workspace-status">正在读取工作区变更…</div>}

      {state.status === 'error' && (
        <div className="error-banner" role="alert">
          <span>
            {state.message}
            <code className="error-code"> {state.code}</code>
          </span>
          <span className="spacer" />
          {state.retryable && (
            <button type="button" className="btn btn-secondary" onClick={() => void refresh()}>
              重试
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && state.snapshot.files.length === 0 && (
        <div className="workspace-status">工作区相对 HEAD 没有变更（快照 {formatTime(state.snapshot.capturedAt)}）。</div>
      )}

      {state.status === 'ready' && state.snapshot.files.length > 0 && (
        <div className="workspace-body">
          <aside className="file-list panel">
            <div className="panel-header">
              <h2>变更文件</h2>
            </div>
            <FileList files={state.snapshot.files} selectedPath={selectedPath} onSelect={setSelectedPath} />
          </aside>
          {selected !== null ? (
            <div className="diff-column">
              <DiffView file={selected} focusLine={focusLine} />
              {selected.reviewable && (
                <ReviewPanel
                  key={selected.path}
                  repositoryId={repository.id}
                  snapshotId={state.snapshot.id}
                  file={selected}
                  entry={overview.reviews[selected.path] ?? null}
                  draft={overview.drafts[selected.path] ?? null}
                  onSaved={() => void refresh()}
                />
              )}
              <AgentPanel
                repositoryId={repository.id}
                snapshotId={state.snapshot.id}
                files={state.snapshot.files}
                selectedFile={selected}
                onSelectFile={selectFile}
                onOverviewChanged={() => void reloadOverview()}
              />
            </div>
          ) : (
            <div className="workspace-status">选择左侧文件查看 Diff。</div>
          )}
        </div>
      )}
    </div>
  );
}
