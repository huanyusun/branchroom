import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentCapability, ChangeFile, ReviewRun } from '../../../shared/contracts';

interface Props {
  repositoryId: string;
  snapshotId: string;
  files: ChangeFile[];
  selectedFile: ChangeFile | null;
  onSelectFile: (path: string) => void;
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

/** Agent Review 面板：能力检测、发起审查、进度/取消、意见列表与历史 run。 */
export function AgentPanel({repositoryId, snapshotId, files, selectedFile, onSelectFile}: Props): React.JSX.Element {
  const [agents, setAgents] = useState<AgentCapability[]>([]);
  const [runs, setRuns] = useState<ReviewRun[]>([]);
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [provider, setProvider] = useState<AgentCapability['provider'] | null>(null);
  const [starting, setStarting] = useState(false);
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

  // 主进程推送的 run 状态更新
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

  const start = useCallback(
    async (fileId: string | null) => {
      if (provider === null) return;
      setStarting(true);
      setError(null);
      try {
        const ids = fileId === null ? reviewableIds : [fileId];
        const result = await window.branchroom.startReview({
          repoId: repositoryId,
          snapshotId,
          fileIds: ids,
          provider
        });
        if (result.ok) {
          setViewRunId(result.data.id);
          setRuns((current) => [result.data, ...current.filter((item) => item.id !== result.data.id)]);
        } else {
          setError({code: result.error.code, message: result.error.message});
        }
      } finally {
        setStarting(false);
      }
    },
    [provider, repositoryId, snapshotId, reviewableIds]
  );

  const cancel = useCallback(async (runId: string) => {
    const result = await window.branchroom.cancelReview(runId);
    if (!result.ok) {
      setError({code: result.error.code, message: result.error.message});
    }
  }, []);

  const viewingRun = runs.find((run) => run.id === viewRunId) ?? runs[0] ?? null;
  const activeRun = runs.find((run) => run.status === 'queued' || run.status === 'running') ?? null;
  const availableAgents = agents.filter((agent) => agent.status === 'available');

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
            onClick={() => void start(null)}
          >
            {activeRun !== null ? '审查进行中…' : `审查全部变更（${reviewableIds.length} 个文件）`}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={starting || provider === null || selectedFile === null || !selectedFile.reviewable || activeRun !== null}
            onClick={() => void start(selectedFile!.id)}
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
                {viewingRun.report.findings.map((finding) => (
                  <li key={finding.id}>
                    <button
                      type="button"
                      className="finding-item"
                      onClick={() => onSelectFile(finding.fileId)}
                      title={`${finding.fileId}:${finding.startLine}`}
                    >
                      <span className={`finding-priority priority-${finding.priority.toLowerCase()}`}>
                        {finding.priority} {finding.kind === 'issue' ? 'issue' : 'verify'}
                      </span>
                      <span className="mono finding-loc">{finding.fileId}:{finding.startLine}</span>
                      <span className="finding-title">{finding.title}</span>
                    </button>
                  </li>
                ))}
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
                onClick={() => setViewRunId(run.id)}
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
