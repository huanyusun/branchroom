import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeFile } from '../../../shared/contracts';
import type { DraftEntryView, ReviewEntryView } from '../../../shared/contracts';

interface Props {
  repositoryId: string;
  snapshotId: string;
  file: ChangeFile;
  entry: ReviewEntryView | null;
  draft: DraftEntryView | null;
  /** 保存成功后由父级刷新快照与概览。 */
  onSaved: () => void;
}

type SaveError = {code: string; message: string};

const AUTOSAVE_DELAY_MS = 1200;

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', {hour12: false});
}

/**
 * 单文件的人工审查面板：结论（reviewed/issue/pending）+ 反馈草稿。
 * 草稿防抖自动保存并绑定内容身份；保存结论前主进程会核对指纹与磁盘真实内容。
 */
export function ReviewPanel({repositoryId, snapshotId, file, entry, draft, onSaved}: Props): React.JSX.Element {
  const [note, setNote] = useState(draft?.note ?? entry?.note ?? '');
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(draft?.updatedAt ?? null);
  const [saving, setSaving] = useState(false);
  const initialNote = useRef(draft?.note ?? entry?.note ?? '');
  const dirty = useRef(false);

  // 切换文件时重置本地状态（父级用 key={file.path} 挂载，这里做兜底同步）
  useEffect(() => {
    const next = draft?.note ?? entry?.note ?? '';
    setNote(next);
    initialNote.current = next;
    dirty.current = false;
    setDraftSavedAt(draft?.updatedAt ?? null);
    setSaveError(null);
  }, [file.path, draft?.note, entry?.note, draft?.updatedAt]);

  // 草稿防抖自动保存；只有内容真正变化才触发
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(async () => {
      const result = await window.branchroom.saveDraft({
        repoId: repositoryId,
        snapshotId,
        fileId: file.path,
        expectedFingerprint: file.fingerprint,
        note
      });
      if (result.ok) {
        setDraftSavedAt(new Date().toISOString());
        setSaveError(null);
      } else {
        setSaveError({code: result.error.code, message: result.error.message});
      }
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [note, repositoryId, snapshotId, file.path, file.fingerprint]);

  const save = useCallback(
    async (state: 'reviewed' | 'issue' | 'pending') => {
      setSaving(true);
      setSaveError(null);
      try {
        const result = await window.branchroom.saveReview({
          repoId: repositoryId,
          snapshotId,
          fileId: file.path,
          expectedFingerprint: file.fingerprint,
          state,
          note
        });
        if (result.ok) {
          dirty.current = false;
          onSaved();
        } else {
          setSaveError({code: result.error.code, message: result.error.message});
        }
      } finally {
        setSaving(false);
      }
    },
    [repositoryId, snapshotId, file.path, file.fingerprint, note, onSaved]
  );

  const discardDraft = useCallback(async () => {
    await window.branchroom.clearDraft(repositoryId, file.path);
    setNote('');
    dirty.current = false;
    setDraftSavedAt(null);
  }, [repositoryId, file.path]);

  const issueNeedsNote = note.trim() === '' && (entry?.note ?? '').trim() === '';
  const issueButtonDisabled = saving || issueNeedsNote;

  return (
    <section className="review-panel" aria-label="人工审查">
      <header className="review-header">
        <span className="review-title">人工审查</span>
        <span className="review-state-label">
          {file.reviewState === 'reviewed' && <span className="green">✓ 已审查</span>}
          {file.reviewState === 'issue' && <span className="red">⚑ 标记问题</span>}
          {file.reviewState === 'recheck' && <span className="warning">↻ 待复审（内容已变化）</span>}
          {file.reviewState === 'pending' && <span className="muted">○ 未审查</span>}
        </span>
      </header>

      {entry?.stale === true && (
        <div className="review-banner" role="note">
          此前的标记基于旧内容，文件已再次变化；以下反馈仅供参考，可修改后重新保存。
        </div>
      )}
      {draft?.stale === true && entry === null && (
        <div className="review-banner" role="note">
          草稿对应的文件内容已变化，保存结论前请先刷新并确认内容。
        </div>
      )}

      <textarea
        className="review-note"
        aria-label="反馈内容"
        placeholder="记录结论或反馈；自动保存为草稿，保存结论后转为正式记录。"
        value={note}
        rows={4}
        onChange={(event) => {
          dirty.current = true;
          setNote(event.target.value);
        }}
      />
      <div className="review-footer">
        <span className="review-hint">
          {draftSavedAt !== null && <span className="muted">草稿已保存 {formatTime(draftSavedAt)}</span>}
          {note !== initialNote.current && dirty.current && <span className="muted"> · 未保存的修改</span>}
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={() => void discardDraft()} disabled={saving}>
          清空
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void save('pending')}
          disabled={saving || file.reviewState === 'pending'}
        >
          重置
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => void save('reviewed')}
          disabled={saving}
        >
          ✓ 已审查
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save('issue')}
          disabled={issueButtonDisabled}
          title={issueNeedsNote ? '标记问题前请先填写反馈' : ''}
        >
          ⚑ 标记问题
        </button>
      </div>

      {saveError !== null && (
        <div className="review-error" role="alert">
          {saveError.message}
          <code className="error-code"> {saveError.code}</code>
        </div>
      )}
    </section>
  );
}
