import { useMemo, useState } from 'react';
import type { ChangeFile } from '../../../shared/contracts';
import { alignLines, fileChangeStats, type AlignedRow } from '../../lib/diff';

const ALIGNED_ROW_LIMIT = 4000;
const FULLTEXT_LINE_LIMIT = 20_000;

type ViewMode = 'diff' | 'fulltext';

function splitLines(text: string): string[] {
  return text.split('\n');
}

function TruncationNotice({shown, total, unit}: {shown: number; total: number; unit: string}): React.JSX.Element {
  return (
    <div className="render-notice" role="note">
      因渲染上限只显示前 {shown} {unit}（共 {total} {unit}）。完整内容以后续虚拟化或导出为准，此处不是完整数据。
    </div>
  );
}

function AlignedTable({rows}: {rows: AlignedRow[]}): React.JSX.Element {
  return (
    <div className="diff-table" data-testid="diff-aligned" role="table" aria-label="对齐双栏 Diff">
      {rows.map((row, index) => {
        switch (row.type) {
          case 'equal':
            return (
              <div className="diff-row" key={index}>
                <span className="line-no">{row.baseLine}</span>
                <span className="line-text equal">{row.text}</span>
                <span className="line-no">{row.currentLine}</span>
                <span className="line-text equal">{row.text}</span>
              </div>
            );
          case 'modify':
            return (
              <div className="diff-row" key={index}>
                <span className="line-no">{row.baseLine}</span>
                <span className="line-text del">{row.base}</span>
                <span className="line-no">{row.currentLine}</span>
                <span className="line-text add">{row.current}</span>
              </div>
            );
          case 'del':
            return (
              <div className="diff-row" key={index}>
                <span className="line-no">{row.baseLine}</span>
                <span className="line-text del">{row.text}</span>
                <span className="line-no" />
                <span className="line-text empty" />
              </div>
            );
          case 'add':
            return (
              <div className="diff-row" key={index}>
                <span className="line-no" />
                <span className="line-text empty" />
                <span className="line-no">{row.currentLine}</span>
                <span className="line-text add">{row.text}</span>
              </div>
            );
        }
      })}
    </div>
  );
}

function SingleColumn({lines, tone}: {lines: string[]; tone: 'add' | 'del'}): React.JSX.Element {
  const clipped = lines.length > FULLTEXT_LINE_LIMIT;
  const shown = clipped ? lines.slice(0, FULLTEXT_LINE_LIMIT) : lines;
  return (
    <div className="single-column" data-testid="diff-single" role="table" aria-label="单栏 Diff">
      {shown.map((text, index) => (
        <div className="single-row" key={index}>
          <span className="line-no">{index + 1}</span>
          <span className={`line-text ${tone}`}>{text}</span>
        </div>
      ))}
      {clipped && <TruncationNotice shown={FULLTEXT_LINE_LIMIT} total={lines.length} unit="行" />}
    </div>
  );
}

function FullText({content, tone}: {content: string; tone: 'base' | 'current'}): React.JSX.Element {
  const lines = content === '' ? [] : splitLines(content);
  return (
    <div className="fulltext" data-testid="diff-fulltext">
      {lines.length === 0 ? (
        <div className="render-notice">（空文件）</div>
      ) : (
        <SingleColumn lines={lines} tone={tone === 'current' ? 'add' : 'del'} />
      )}
    </div>
  );
}

export function DiffView({file}: {file: ChangeFile}): React.JSX.Element {
  const [mode, setMode] = useState<ViewMode>('diff');
  const stats = fileChangeStats(file);

  const alignment = useMemo(() => {
    if (mode !== 'diff') return null;
    if (file.baseContent === null || file.currentContent === null) return null;
    return alignLines(splitLines(file.baseContent), splitLines(file.currentContent));
  }, [file, mode]);

  const singleTone =
    file.kind === 'deleted' ? {content: file.baseContent, tone: 'base' as const}
    : {content: file.currentContent, tone: 'current' as const};

  return (
    <section className="diff-pane" aria-label="Diff 视图">
      <header className="diff-header">
        <span className="mono diff-path" title={file.path}>{file.path}</span>
        {file.previousPath !== null && (
          <span className="mono diff-previous" title="重命名前路径">← {file.previousPath}</span>
        )}
        {stats.additions !== null && (
          <span className="mono stats">
            <span className="green">+{stats.additions}</span>{' '}
            <span className="red">−{stats.deletions}</span>
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={mode === 'diff' ? 'btn btn-secondary' : 'btn btn-ghost'}
          onClick={() => setMode('diff')}
        >
          对比
        </button>
        <button
          type="button"
          className={mode === 'fulltext' ? 'btn btn-secondary' : 'btn btn-ghost'}
          onClick={() => setMode('fulltext')}
        >
          全文
        </button>
      </header>

      {file.reviewable && file.unavailableReason === null ? null : (
        <div className="unavailable-notice" role="note">
          {file.unavailableReason ?? '此文件暂不支持审阅'}
        </div>
      )}

      <div className="diff-scroll">
        {mode === 'fulltext' ? (
          <FullText
            content={singleTone.content ?? ''}
            tone={singleTone.tone}
          />
        ) : alignment !== null ? (
          alignment.rows.length > ALIGNED_ROW_LIMIT ? (
            <>
              <AlignedTable rows={alignment.rows.slice(0, ALIGNED_ROW_LIMIT)} />
              <TruncationNotice shown={ALIGNED_ROW_LIMIT} total={alignment.rows.length} unit="行" />
            </>
          ) : (
            <AlignedTable rows={alignment.rows} />
          )
        ) : singleTone.content !== null ? (
          <SingleColumn
            lines={singleTone.content === '' ? [] : splitLines(singleTone.content)}
            tone={singleTone.tone === 'current' ? 'add' : 'del'}
          />
        ) : (
          <div className="render-notice">没有可显示的内容。</div>
        )}
      </div>
    </section>
  );
}
