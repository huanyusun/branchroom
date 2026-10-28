import { useCallback, useEffect, useState } from 'react';
import type { Repository, Snapshot } from '../../../shared/contracts';
import { RepositoryIdentity } from '../repositories/RepositoryIdentity';
import { DiffView } from './DiffView';
import { FileList } from './FileList';

interface Props {
  repository: Repository;
}

type SnapshotState =
  | {status: 'loading'}
  | {status: 'ready'; snapshot: Snapshot}
  | {status: 'error'; code: string; message: string; retryable: boolean};

function shortHead(head: string | null): string {
  return head === null ? '尚无提交' : head.slice(0, 10);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', {hour12: false});
}

/** 打开仓库后的工作区：变更列表 + Diff/全文视图，快照手动刷新。 */
export function Workspace({repository}: Props): React.JSX.Element {
  const [state, setState] = useState<SnapshotState>({status: 'loading'});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setState({status: 'loading'});
    const result = await window.branchroom.getSnapshot(repository.id);
    if (result.ok) {
      setState({status: 'ready', snapshot: result.data});
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
            <DiffView file={selected} />
          ) : (
            <div className="workspace-status">选择左侧文件查看 Diff。</div>
          )}
        </div>
      )}
    </div>
  );
}
