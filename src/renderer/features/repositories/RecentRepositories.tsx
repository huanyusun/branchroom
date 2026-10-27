import type { RepositoryEntry } from '../../../shared/contracts';

interface Props {
  entries: RepositoryEntry[];
  onOpen: (root: string) => void;
  onRemove: (id: string) => void;
  busyRoot: string | null;
}

/** 最近仓库列表，按最近打开排序；失效路径保留显示并提供移除入口。 */
export function RecentRepositories({entries, onOpen, onRemove, busyRoot}: Props): React.JSX.Element | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort(
    (a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime()
  );

  return (
    <section className="panel recent-list" aria-label="最近仓库">
      <header className="panel-header">
        <h2>最近仓库</h2>
      </header>
      <ul className="recent-items">
        {sorted.map((entry) => {
          const missing = entry.repository === null;
          const isBusy = busyRoot === entry.root;
          return (
            <li key={entry.id} className={missing ? 'recent-item missing' : 'recent-item'}>
              <span className="recent-name" title={entry.root}>{entry.name}</span>
              <span className="recent-path mono" title={entry.root}>{entry.root}</span>
              {missing ? (
                <span className="recent-state">路径已失效</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={isBusy}
                  onClick={() => onOpen(entry.root)}
                >
                  {isBusy ? '打开中…' : '打开'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`移除 ${entry.name}`}
                onClick={() => onRemove(entry.id)}
              >
                移除
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
