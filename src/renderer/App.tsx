import { useCallback, useEffect, useState } from 'react';
import type { Repository, RepositoryEntry } from '../shared/contracts';
import { RepositoryIdentity } from './features/repositories/RepositoryIdentity';
import { RecentRepositories } from './features/repositories/RecentRepositories';

type AppError = {code: string; message: string};

export default function App(): React.JSX.Element {
  const [repository, setRepository] = useState<Repository | null>(null);
  const [entries, setEntries] = useState<RepositoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyRoot, setBusyRoot] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const refreshEntries = useCallback(async () => {
    const result = await window.branchroom.listRepositoryEntries();
    if (result.ok) {
      setEntries(result.data);
    } else {
      setError({code: result.error.code, message: result.error.message});
    }
  }, []);

  useEffect(() => {
    void refreshEntries();
  }, [refreshEntries]);

  const chooseRepository = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.branchroom.chooseRepository();
      if (result.ok) {
        // 用户取消时 data 为 null：静默返回，不当作错误
        if (result.data === null) return;
        setRepository(result.data);
        await refreshEntries();
      } else {
        setError({code: result.error.code, message: result.error.message});
      }
    } finally {
      setBusy(false);
    }
  }, [refreshEntries]);

  const openByPath = useCallback(
    async (root: string) => {
      setBusyRoot(root);
      setError(null);
      try {
        const result = await window.branchroom.openRepositoryPath(root);
        if (result.ok) {
          setRepository(result.data);
          await refreshEntries();
        } else {
          setError({code: result.error.code, message: result.error.message});
          await refreshEntries(); // 路径可能已失效，刷新标记
        }
      } finally {
        setBusyRoot(null);
      }
    },
    [refreshEntries]
  );

  const removeEntry = useCallback(
    async (id: string) => {
      const result = await window.branchroom.removeRepository(id);
      if (!result.ok) {
        setError({code: result.error.code, message: result.error.message});
      }
      await refreshEntries();
    },
    [refreshEntries]
  );

  return (
    <main className="app-shell">
      <div className="app-header">
        <span className="app-title">Branchroom</span>
        <span className="app-subtitle">审查 AI 生成修改的本地 Git 客户端</span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void chooseRepository()}
          disabled={busy}
        >
          {busy ? '选择目录…' : '打开本地仓库…'}
        </button>
      </div>

      {error !== null && (
        <div className="error-banner" role="alert">
          <span>
            {error.message}
            <code className="error-code"> {error.code}</code>
          </span>
          <button type="button" className="btn btn-ghost" aria-label="关闭错误提示" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      {repository === null ? (
        <section className="empty-state" aria-label="欢迎">
          <h1>打开一个本地 Git 仓库开始审查</h1>
          <p>
            Branchroom 面向 AI 批量修改：读取工作区相对 HEAD 的真实变更，让人工审查与 Agent
            辅助审查各司其职。当前切片支持选择仓库并确认其身份，变更阅读与 Agent
            审查将在后续任务中提供。
          </p>
        </section>
      ) : (
        <RepositoryIdentity repository={repository} />
      )}

      <RecentRepositories entries={entries} onOpen={(root) => void openByPath(root)} onRemove={(id) => void removeEntry(id)} busyRoot={busyRoot} />
    </main>
  );
}
