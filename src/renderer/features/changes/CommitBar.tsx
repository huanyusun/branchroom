import { useCallback, useEffect, useState } from 'react';
import type { ChangeFile, CommitPreview } from '../../../shared/contracts';

interface Props {
  repositoryId: string;
  /** 变化时重新加载提交预览（快照刷新/暂存操作后由父级递增）。 */
  revision: number;
  selectedFile: ChangeFile | null;
  /** 提交成功后由父级刷新快照。 */
  onCommitted: (commitHash: string) => void;
}

type ActionError = {code: string; message: string};

/**
 * 提交区（BR-006）：展示当前索引将被提交的内容，显式提交。
 * 目标始终是本地仓库的当前分支——没有推送、没有远程操作。
 */
export function CommitBar({repositoryId, revision, selectedFile, onCommitted}: Props): React.JSX.Element {
  const [preview, setPreview] = useState<CommitPreview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [lastHash, setLastHash] = useState<string | null>(null);

  const reloadPreview = useCallback(async () => {
    const result = await window.branchroom.previewCommit(repositoryId);
    if (result.ok) {
      setPreview(result.data);
    } else {
      setPreview({files: [], additions: 0, deletions: 0});
      if (result.error.code !== 'repository_unavailable') {
        setError({code: result.error.code, message: result.error.message});
      }
    }
  }, [repositoryId]);

  useEffect(() => {
    void reloadPreview();
  }, [reloadPreview, revision]);

  const commitStagedAction = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.branchroom.commitStaged(repositoryId, message);
      if (result.ok) {
        setLastHash(result.data.commitHash);
        setMessage('');
        onCommitted(result.data.commitHash);
      } else {
        setError({code: result.error.code, message: result.error.message});
      }
    } finally {
      setBusy(false);
    }
  }, [repositoryId, message, onCommitted]);

  const commitSelected = useCallback(async () => {
    if (selectedFile === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.branchroom.commitFiles(repositoryId, message, [selectedFile.id]);
      if (result.ok) {
        setLastHash(result.data.commitHash);
        setMessage('');
        onCommitted(result.data.commitHash);
      } else {
        setError({code: result.error.code, message: result.error.message});
      }
    } finally {
      setBusy(false);
    }
  }, [repositoryId, message, selectedFile, onCommitted]);

  const stagedCount = preview?.files.length ?? 0;
  const selectedCommittable = selectedFile !== null
    && (selectedFile.worktreeStatus !== '.' || selectedFile.indexStatus !== '.');

  return (
    <section className="panel commit-bar" aria-label="提交">
      <header className="panel-header">
        <h2>提交（写入本地仓库）</h2>
      </header>
      <div className="commit-body">
        <div className="commit-preview muted">
          {preview === null
            ? '正在读取提交预览…'
            : stagedCount === 0
              ? '暂存区为空：先在文件列表中暂存要提交的文件，或使用“提交所选文件”。'
              : `将提交 ${stagedCount} 个已暂存文件（+${preview.additions} −${preview.deletions}）：${preview.files.join('、')}`}
        </div>
        <textarea
          className="commit-message"
          aria-label="提交信息"
          placeholder="提交信息（必填）"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="commit-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || stagedCount === 0 || message.trim() === ''}
            onClick={() => void commitStagedAction()}
            title="把暂存区内容提交到当前分支"
          >
            提交已暂存
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || message.trim() === '' || !selectedCommittable}
            title={selectedCommittable ? `直接提交 ${selectedFile!.id} 的当前内容到当前分支` : '先在列表中选择有变更的文件'}
            onClick={() => void commitSelected()}
          >
            提交所选文件
          </button>
          {lastHash !== null && <span className="muted mono commit-result">已提交 {lastHash}</span>}
        </div>
        {error !== null && (
          <div className="review-error" role="alert">
            {error.message}
            <code className="error-code"> {error.code}</code>
          </div>
        )}
      </div>
    </section>
  );
}
