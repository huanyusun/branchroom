import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Provider } from '../../shared/contracts';
import { reportJsonSchema } from './report';

export interface ProviderProfile {
  id: Provider;
  /** 启动参数。设计原则（docs/AGENT-INTEGRATION.md）：只读沙箱、不经 argv 传提示词、
   *  不清空用户 provider/auth/model 配置（Claude 不再使用 --setting-sources ''）。 */
  buildArgs(workDir: string): string[];
  /** 从运行产物中提取待校验的报告 JSON。 */
  extractReport(workDir: string, stdout: string): Promise<unknown>;
}

/** codex exec：只读沙箱、禁用 shell/web 工具、结构化输出写到受控目录。 */
export const codexProfile: ProviderProfile = {
  id: 'codex',
  buildArgs(workDir) {
    return [
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--disable', 'shell_tool',
      '--disable', 'unified_exec',
      '-c', 'web_search="disabled"',
      '--output-schema', join(workDir, 'schema.json'),
      '--json',
      '--output-last-message', join(workDir, 'result.json'),
      '-'
    ];
  },
  async extractReport(workDir) {
    return JSON.parse(await readFile(join(workDir, 'result.json'), 'utf8')) as unknown;
  }
};

/** claude --print：保留用户 provider/auth/model 配置；用 --restricted 移除执行类工具。 */
export const claudeProfile: ProviderProfile = {
  id: 'claude',
  buildArgs() {
    return [
      '--print',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(reportJsonSchema),
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      '--restricted',
      '--settings', '{"disableAllHooks":true}'
    ];
  },
  async extractReport(_workDir, stdout) {
    const envelope = JSON.parse(stdout) as {is_error?: boolean; result?: unknown; structured_output?: unknown};
    if (envelope.is_error === true) {
      const error = new Error(typeof envelope.result === 'string' ? envelope.result : 'Claude 审查失败');
      error.name = 'ProviderError';
      throw error;
    }
    if (envelope.structured_output !== undefined && envelope.structured_output !== null) {
      return envelope.structured_output;
    }
    if (typeof envelope.result === 'string') {
      // 兜底：模型把 JSON 包在代码围栏里时剥掉围栏
      return JSON.parse(envelope.result.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')) as unknown;
    }
    throw new Error('Claude 输出缺少结构化结果。');
  }
};

export function profileFor(provider: Provider): ProviderProfile {
  switch (provider) {
    case 'codex': return codexProfile;
    case 'claude': return claudeProfile;
  }
}

export interface FailureClassification {
  code: 'agent_auth_required' | 'agent_incompatible' | 'agent_failed';
  message: string;
}

const AUTH_PATTERN = /not logged in|需要登录|请先登录|unauthenticated|no credentials|authentication required|invalid api key|登录状态/i;
const MODEL_PATTERN = /unrecognized_model|unknown model|model_not_found|invalid model|不存在.*模型|模型.*不存在|no such model/i;
const FLAG_PATTERN = /unknown option|unrecognized option|unexpected argument|未知参数|invalid.*flag/i;

/** 把 CLI 非零退出/stderr 分类为可操作的错误码；只取尾部避免长输出刷屏。 */
export function classifyFailure(stderr: string, stdout: string, exitCode: number | null): FailureClassification {
  const tail = (source: string): string => {
    const trimmed = source.trim();
    return trimmed === '' ? '' : trimmed.split('\n').slice(-6).join('\n').slice(-1500);
  };
  const detail = tail(stderr) || tail(stdout) || `Agent 退出码 ${exitCode ?? 'unknown'}。`;
  if (AUTH_PATTERN.test(stderr + stdout)) {
    return {code: 'agent_auth_required', message: `Agent 未登录或凭据失效：${detail}`};
  }
  if (MODEL_PATTERN.test(stderr + stdout)) {
    return {code: 'agent_incompatible', message: `模型配置不被当前 CLI/服务商接受：${detail}`};
  }
  if (FLAG_PATTERN.test(stderr + stdout)) {
    return {code: 'agent_incompatible', message: `当前 CLI 版本不支持所用参数：${detail}`};
  }
  return {code: 'agent_failed', message: `Agent 运行失败：${detail}`};
}
