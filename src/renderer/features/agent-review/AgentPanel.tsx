import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentCapability, ChangeFile, Finding, ReviewRun } from '../../../shared/contracts';

interface Props {
  repositoryId: string;
  snapshotId: string;
  files: ChangeFile[];
  selectedFile: ChangeFile | null;
  onSelectFile: (path: string, line?: number) => void;
  /** 采纳产生草稿后由父级刷新审查概览。 */
  onOverviewChanged: () => void;
}

type ActionError = {code: string; message: string};

const STATUS_LABEL: Record<AgentCapability['status'], string> = {
  available: '可用',
  missing: '未安装',
  unauthenticated: '未登录',
  incompatible: '不兼容',
  unchecked: '未检测'
};

function formatElapsed(startedAt: string | null, finishedAt: string | null): string {
  if (startedAt === null) return '';
  const start = new Date(startedAt).getTime();
  const end = finishedAt === null ? Date.now() : new Date(finishedAt).getTime();
  if (Number.isNaN(start)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

function composeAdoptedNote(finding: Finding): string {
  return [
    `[Agent 意见 · ${finding.priority} ${finding.kind} · ${finding.fileId}:${finding.startLine}] ${finding.title}`,
    `影响：${finding.body}`,
    `依据：${finding.evidence}`,
    `建议：${finding.suggestion}`
  ].join('\n');
}

/** Agent Review 面板：能力检测、发起审查（含只复审待复审文件）、意见定位/采纳与历史 run。 */
export function AgentPanel({repositoryId, snapshotId, files, selectedFile, onSelectFile, onOverviewChanged}: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentCapability[]>([]);
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [expandedFindingId, setExpandedFindingId] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentCapability['provider'] | null>(null);
  const [starting, setStarting] = useState(false);
  const [adoptedFindingId, setAdoptedFindingId] = useState<string | null>(null);
  const [error, setError] = useState<ActionError | null>(null);

  const reload = useCallback(async () => {
    const [agentsResult, runsResult] = await Promise.all([
      window.branchroom.listAgents(),
      window.branchroom.listRuns(repositoryId)
    ]);
    if (agentsResult.ok) {
      setAgents(agentsResult.data);
      setProvider((current) => {
        if (current !== null && agentsResult.data.some((a) => a.provider === current && a.status === 'available')) {
          return current;
        }
        return agentsResult.data.find((a) => a.status === 'available')?.provider ?? null;
      });
    }
    if (runsResult.ok) {
      setRuns(runsResult.data);
      setViewRunId((current) => (current !== null && runsResult.data.some((r) => r.id === current) ? current : null));
    }
  }, [repositoryId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const unsubscribe = window.branchroom.onReviewRun((run) => {
      if (run.repoId !== repositoryId) return;
      setRuns((current) => {
        const next = current.filter((item) => item.id !== run.id);
        next.unshift(run);
        return next;
      });
    });
    return unsubscribe;
  }, [repositoryId]);

  const reviewableIds = useMemo(
    () => files.filter((file) => file.reviewable).map((file) => file.id),
    [files]
  );
  const recheckIds = useMemo(
    () => files.filter((file) => file.reviewState === 'recheck' && file.reviewable).map((file) => file.id),
    [files]
  );

  const start = useCallback(
    async (ids: string[]) => {
      if (provider === null || ids.length === 0) return;
      setStarting(true);
      setError(null);
      try {
        const result = await window.branchroom.startReview({
          repoId: repositoryId,
          snapshotId,
          fileIds: ids,
          provider
        });
        if (result.ok) {
          setViewRunId(result.data.id);
          setExpandedFindingId(null);
          setAdoptedFindingId(null);
          setRuns((current) => [result.data, ...current.filter((item) => item.id !== result.data.id)]);
        } else {
          setError({code: result.error.code, message: result.error.message});
        }
      } finally {
        setStarting(false);
      }
    },
    [provider, repositoryId, snapshotId]
  );

  const cancel = useCallback(async (runId: string) => {
    const result = await window.branchroom.cancelReview(runId);
    if (!result.ok) {
      setError({code: result.error.code, message: result.error.message});
    }
  }, []);

  const adopt = useCallback(
    async (finding: Finding) => {
      const currentFile = files.find((file) => file.id === finding.fileId);
      if (currentFile === undefined) return;
      const result = await window.branchroom.saveDraft({
        repoId: repositoryId,
        snapshotId,
        fileId: currentFile.id,
        expectedFingerprint: currentFile.fingerprint,
        note: composeAdoptedNote(finding)
      });
      if (result.ok) {
        setAdoptedFindingId(finding.id);
        onOverviewChanged();
      } else {
        setError({code: result.error.code, message: result.error.message});
      }
    },
    [files, repositoryId, snapshotId, onOverviewChanged]
  );

  const viewingRun = runs.find((run) => run.id === viewRunId) ?? runs[0] ?? null;
  const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running') ?? null;
  const availableAgents = agents.filter((agent) => agent.status === 'available');

  const findingsOf = (run: ReviewRun | null): Finding[] => run?.report?.findings ?? [];
  const isStale = (finding: Finding): boolean => {
    const file = files.find((item) => item.id === finding.fileId);
    return file === undefined || file.fingerprint !== finding.fingerprint;
  };

  return (
    <section className="panel agent-panel" aria-label="Agent Review">
      <header className="panel-header agent-panel-header">
        <h2>Agent Review</h2>
        <span className="agent-providers">
          {agents.map((agent) => (
            <button
              key={agent.provider}
              type="button"
              className={
                agent.status === 'available'
                  ? (provider === agent.provider ? 'provider-chip active' : 'provider-chip')
                  : 'provider-chip disabled'
              }
              disabled={agent.status !== 'available'}
              title={agent.diagnostic ?? `${agent.provider} ${agent.version ?? ''}`}
              onClick={() => setProvider(agent.provider)}
            >
              {agent.provider} · {STATUS_LABEL[agent.status]}
              {agent.version !== null && agent.status === 'available' ? ` · ${agent.version}` : ''}
            </button>
          ))}
        </span>
      </header>

      <div className="agent-panel-body">
        {availableAgents.length === 0 && (
          <div className="agent-hint">
            本机没有可用的 Agent CLI。检测区分未安装与不兼容；可在 userData 的
            agent-settings.json 中显式指定可执行文件路径。
          </div>
        )}

        <div className="agent-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={starting || provider === null || reviewableIds.length === 0 || activeRun !== null}
            onClick={() => void start(reviewableIds)}
          >
            {activeRun !== null ? '审查进行中…' : `审查全部变更（${reviewableIds.length} 个文件）`}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={starting || provider === null || recheckIds.length === 0 || activeRun !== null}
            title="只对标记后内容又变化的文件重新审查"
            onClick={() => void start(recheckIds)}
          >
            复审待复审文件（{recheckIds.length}）
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={starting || provider === null || selectedFile === null || !selectedFile.reviewable || activeRun !== null}
            onClick={() => void start([selectedFile!.id])}
          >
            审查当前文件
          </button>
          {activeRun !== null && (
            <button type="button" className="btn btn-ghost" onClick={() => void cancel(activeRun.id)}>
              停止
            </button>
          )}
        </div>

        {error !== null && (
          <div className="review-error" role="alert">
            {error.message}
            <code className="error-code"> {error.code}</code>
          </div>
        )}

        {activeRun !== null && (
          <div className="run-status" role="status">
            <span className={activeRun.status === 'running' ? 'run-status-text' : 'run-status-text muted'}>
              {activeRun.status === 'queued' ? '排队中…' : 'Agent 正在分析快照…'}
              {' · '}{formatElapsed(activeRun.startedAt, null)}
            </span>
          </div>
        )}

        {viewingRun !== null && viewingRun !== activeRun && (
          <>
            <div className="run-summary">
              <span className="muted">
                {viewingRun.provider} · {viewingRun.status} · {formatElapsed(viewingRun.startedAt, viewingRun.finishedAt)}
                {' · '}{viewingRun.report !== null ? `${viewingRun.report.findings.length} 条意见` : '无报告'}
              </span>
              {viewingRun.error !== null && (
                <div className="review-error">
                  {viewingRun.error.message}
                  <code className="error-code"> {viewingRun.error.code}</code>
                </div>
              )}
            </div>
            {viewingRun.report !== null && (
              <ul className="finding-list">
                {findingsOf(viewingRun).map((finding) => {
                  const stale = isStale(finding);
                  const expanded = expandedFindingId === finding.id;
                  return (
                    <li key={finding.id}>
                      <button
                        type="button"
                        className="finding-item"
                        onClick={() => {
                          setExpandedFindingId(expanded ? null : finding.id);
                          onSelectFile(finding.fileId, finding.startLine); // 一击定位
                        }}
                        title={`${finding.fileId}:${finding.startLine}`}
                      >
                        <span className={`finding-priority priority-${finding.priority.toLowerCase()}`}>
                          {finding.priority} {finding.kind === 'issue' ? 'issue' : 'verify'}
                        </span>
                        {stale && <span className="finding-stale-tag" title="意见基于旧版本内容">旧</span>}
                        <span className="mono finding-loc">{finding.fileId}:{finding.startLine}</span>
                        <span className="finding-title">{finding.title}</span>
                      </button>
                      {expanded && (
                        <div className="finding-detail" aria-label="意见详情">
                          {stale && (
                            <div className="finding-stale-banner" role="note">
                              此意见基于旧版本内容，与当前文件不一致；已阻止直接采纳。请重新审查或手动处理。
                            </div>
                          )}
                          <p className="finding-text">
                            <span className="muted">类型：</span>
                            {finding.priority} · {finding.kind === 'issue' ? 'issue（输入可直接证明的问题）' : 'verify（需外部依据确认）'}
                          </p>
                          <p className="finding-text"><span className="muted">影响：</span>{finding.body}</p>
                          <p className="finding-text"><span className="muted">依据：</span>{finding.evidence}</p>
                          <p className="finding-text"><span className="muted">建议：</span>{finding.suggestion}</p>
                          <div className="finding-actions">
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={stale}
                              title={stale ? '内容已变化，阻止直接采纳' : '把意见转为该文件的反馈草稿，仍需你确认'}
                              onClick={() => void adopt(finding)}
                            >
                              {adoptedFindingId === finding.id ? '已转为草稿 ✓' : '采纳为反馈草稿'}
                            </button>
                            <span className="muted finding-adopt-hint">
                              采纳只生成草稿，不会修改仓库或直接变成审查结论。
                            </span>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {runs.length > 0 && (
          <div className="run-history">
            <span className="muted">历史 run：</span>
            {runs.slice(0, 8).map((run, index) => (
              <button
                key={run.id}
                type="button"
                className={(viewRunId ?? runs[0]?.id) === run.id ? 'run-history-item active' : 'run-history-item'}
                onClick={() => {
                  setViewRunId(run.id);
                  setExpandedFindingId(null);
                  setAdoptedFindingId(null);
                }}
              >
                #{runs.length - index} {run.status}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
