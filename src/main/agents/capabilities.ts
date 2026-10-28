import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentCapability, Provider } from '../../shared/contracts';

const execFileP = promisify(execFile);
const PROVIDER_NAMES: Record<Provider, string> = {codex: 'Codex', claude: 'Claude Code'};
const VERSION_MAX_BUFFER = 64 * 1024;

export interface DetectOptions {
  /** 用户显式指定的可执行文件路径（settings 文件或测试注入）。 */
  executablePath?: string;
  /** PATH 查找失败时的补充目录（如 GUI 启动时缺少 nvm 路径的场景）。 */
  extraPathDirs?: string[];
}

async function resolveExecutable(provider: Provider, options: DetectOptions): Promise<string | null> {
  if (options.executablePath !== undefined && options.executablePath !== '') {
    return options.executablePath;
  }
  try {
    const {stdout} = await execFileP('which', [provider]);
    const found = stdout.trim();
    return found === '' ? null : found;
  } catch {
    return null;
  }
}

interface VersionProbe {
  kind: 'ok' | 'not_found' | 'broken';
  version: string | null;
  diagnostic: string | null;
}

async function probeVersion(executable: string, extraPathDirs: string[]): Promise<VersionProbe> {
  try {
    const {stdout} = await execFileP(executable, ['--version'], {
      maxBuffer: VERSION_MAX_BUFFER,
      env: extraPathDirs.length > 0
        ? {...process.env, PATH: [...extraPathDirs, process.env.PATH ?? ''].join(':')}
        : process.env
    });
    const version = stdout.trim().split('\n')[0] ?? '';
    if (version === '' || version.length > 200) {
      return {kind: 'broken', version: null, diagnostic: '--version 输出异常，无法确认版本。'};
    }
    return {kind: 'ok', version, diagnostic: null};
  } catch (error) {
    const err = error as {code?: unknown; stderr?: string; stdout?: string; message?: string};
    if (err.code === 'ENOENT') {
      return {kind: 'not_found', version: null, diagnostic: '可执行文件不存在。'};
    }
    const detail = (err.stderr ?? err.stdout ?? err.message ?? '').trim().split('\n')[0] ?? '';
    return {kind: 'broken', version: null, diagnostic: detail === '' ? '--version 探测失败。' : detail};
  }
}

/**
 * 能力检测：解析可执行文件并探测版本。
 * 认证与模型路由的成本只在真实运行时产生，其失败在运行错误里分类
 * （agent_auth_required / agent_incompatible），这里不猜测、不试运行审查。
 */
export async function detectAgent(provider: Provider, options: DetectOptions = {}): Promise<AgentCapability> {
  const base: AgentCapability = {
    provider,
    executable: null,
    version: null,
    status: 'missing',
    diagnostic: null
  };
  const executable = await resolveExecutable(provider, options);
  if (executable === null) {
    return {
      ...base,
      diagnostic: `未在 PATH 中找到 ${PROVIDER_NAMES[provider]} CLI。可稍后在设置中显式指定可执行文件路径。`
    };
  }
  const probe = await probeVersion(executable, options.extraPathDirs ?? []);
  if (probe.kind === 'not_found') {
    return {...base, status: 'missing', diagnostic: probe.diagnostic};
  }
  if (probe.kind === 'broken') {
    return {...base, executable, status: 'incompatible', diagnostic: probe.diagnostic};
  }
  return {...base, executable, version: probe.version, status: 'available'};
}
