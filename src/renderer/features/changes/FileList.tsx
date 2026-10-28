import type { ChangeFile } from '../../../shared/contracts';
import { fileChangeStats } from '../../lib/diff';

const KIND_LABELS: Record<ChangeFile['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  conflicted: 'U'
};

interface Props {
  files: ChangeFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onStage: (file: ChangeFile) => void;
  onUnstage: (file: ChangeFile) => void;
  busy: boolean;
}

const REVIEW_STATE_GLYPH: Record<ChangeFile['reviewState'], {glyph: string; className: string; title: string}> = {
  pending: {glyph: '○', className: 'muted', title: '未审查'},
  reviewed: {glyph: '✓', className: 'green', title: '已审查'},
  issue: {glyph: '⚑', className: 'red', title: '标记问题'},
  recheck: {glyph: '↻', className: 'warning', title: '内容变化，待复审'}
};

function splitPath(path: string): {directory: string; name: string} {
  const at = path.lastIndexOf('/');
  if (at < 0) return {directory: '', name: path};
  return {directory: path.slice(0, at + 1), name: path.slice(at + 1)};
}

export function FileList({files, selectedPath, onSelect, onStage, onUnstage, busy}: Props): React.JSX.Element {
  return (
    <ul className="file-list-items" aria-label="变更文件列表">
      {files.map((file) => {
        const {additions, deletions} = fileChangeStats(file);
        const {directory, name} = splitPath(file.path);
        const staged = file.indexStatus !== '.' && file.indexStatus !== '?';
        const hasWorktreeChange = file.worktreeStatus !== '.';
        const reviewGlyph = REVIEW_STATE_GLYPH[file.reviewState];
        return (
          <li key={file.id}>
            <div
              className={file.path === selectedPath ? 'file-item selected' : 'file-item'}
              data-testid="file-item"
              data-path={file.path}
            >
              <button
                type="button"
                className="file-item-main"
                onClick={() => onSelect(file.path)}
                title={file.unavailableReason ?? file.path}
              >
                <span className={`review-glyph ${reviewGlyph.className}`} title={reviewGlyph.title}>
                  {reviewGlyph.glyph}
                </span>
                <span className={`kind-badge kind-${file.kind}`}>{KIND_LABELS[file.kind]}</span>
                <span className="file-item-path">
                  <span className="file-dir">{directory}</span>
                  <span className="file-name">{name}</span>
                </span>
                <span className="file-item-meta">
                  {staged && <span className="staged-dot" title="已暂存">●</span>}
                  {additions !== null && (
                    <span className="mono stats">
                      <span className="green">+{additions}</span>{' '}
                      <span className="red">−{deletions}</span>
                    </span>
                  )}
                </span>
              </button>
              <span className="file-item-actions">
                {hasWorktreeChange && !busy && (
                  <button
                    type="button"
                    className="btn btn-ghost file-action"
                    title={`暂存 ${file.path} 到索引`}
                    onClick={() => onStage(file)}
                  >
                    暂存
                  </button>
                )}
                {staged && !busy && (
                  <button
                    type="button"
                    className="btn btn-ghost file-action"
                    title={`把 ${file.path} 移出暂存区（工作区内容不动）`}
                    onClick={() => onUnstage(file)}
                  >
                    取消暂存
                  </button>
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
