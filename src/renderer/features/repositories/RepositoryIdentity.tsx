import type { Repository } from '../../../shared/contracts';

function branchLabel(repository: Repository): string {
  if (repository.branch !== null && repository.head === null) {
    return `${repository.branch}（尚未创建提交）`;
  }
  if (repository.branch !== null) return repository.branch;
  if (repository.head !== null) return '分离 HEAD';
  return '未知状态';
}

function headLabel(repository: Repository): string {
  if (repository.head === null) return '尚无提交';
  return `${repository.head.slice(0, 10)}…`;
}

/** 展示真实读取到的仓库身份；不捏造分支或提交。compact 模式用于工作区头部的单行摘要。 */
export function RepositoryIdentity({repository, compact = false}: {repository: Repository; compact?: boolean}): React.JSX.Element {
  const isLinkedWorktree = repository.gitDir !== repository.commonGitDir;

  if (compact) {
    return (
      <span className="repo-inline" aria-label="仓库身份摘要">
        <strong>{repository.name}</strong>
        <span className="muted mono" title={repository.root}>{repository.root}</span>
        <span>{branchLabel(repository)}</span>
        <span className="muted mono">{headLabel(repository)}</span>
        {isLinkedWorktree && <span className="badge-worktree">worktree</span>}
      </span>
    );
  }

  const rows: Array<{label: string; value: string; mono?: boolean}> = [
    {label: '名称', value: repository.name},
    {label: '路径', value: repository.root, mono: true},
    {label: '分支', value: branchLabel(repository)},
    {label: 'HEAD', value: headLabel(repository), mono: true}
  ];
  if (isLinkedWorktree) {
    rows.push({label: '工作区', value: '链接 worktree（独立于主仓库记录）', mono: false});
  }

  return (
    <section className="panel repo-identity" aria-label="仓库身份">
      <header className="panel-header">
        <h2>已打开仓库</h2>
      </header>
      <dl className="identity-list">
        {rows.map((row) => (
          <div className="identity-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.mono ? 'mono' : undefined} title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
