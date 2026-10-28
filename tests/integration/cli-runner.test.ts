import { beforeEach, afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCli } from '../../src/main/agents/runner';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'branchroom-cli-runner-'));
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

async function writeScript(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/bash\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

test('successful run captures stdout and stdin input', async () => {
  const exe = await writeScript('ok.sh', 'cat');
  const run = spawnCli({executable: exe, args: [], cwd: dir, stdin: '提示词内容', timeoutMs: 10_000});
  const result = await run.result;
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('提示词内容');
  expect(result.stderr).toBe('');
  expect(result.killed).toBe(false);
});

test('non-zero exit with stderr is captured and not killed', async () => {
  const exe = await writeScript('fail.sh', 'echo "boom 失败" >&2; exit 3');
  const run = spawnCli({executable: exe, args: [], cwd: dir, stdin: '', timeoutMs: 10_000});
  const result = await run.result;
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain('boom');
  expect(result.killed).toBe(false);
});

test('timeout kills the process', async () => {
  const exe = await writeScript('slow.sh', 'sleep 30');
  const run = spawnCli({executable: exe, args: [], cwd: dir, stdin: '', timeoutMs: 150});
  const started = Date.now();
  const result = await run.result;
  expect(result.killed).toBe(true);
  expect(run.killedReason).toBe('timeout');
  expect(Date.now() - started).toBeLessThan(10_000);
});

test('explicit cancel kills the process tree including descendants', async () => {
  // 子脚本再派生两个 sleep 孙进程；取消后整组都必须退出
  const exe = await writeScript('parent.sh', '"$DIR/cd-cancel-child.sh" &\nwait');
  await writeFile(
    join(dir, 'cd-cancel-child.sh'),
    '#!/bin/bash\nsleep 30 &\nsleep 30',
    'utf8'
  );
  await chmod(join(dir, 'cd-cancel-child.sh'), 0o755);
  const run = spawnCli({
    executable: exe,
    args: [],
    cwd: dir,
    stdin: '',
    timeoutMs: 60_000,
    env: {DIR: dir}
  });

  const countByPattern = async (pattern: string): Promise<number> => {
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    try {
      const {stdout} = await promisify(execFile)('pgrep', ['-f', pattern]);
      return stdout.trim() === '' ? 0 : stdout.trim().split('\n').length;
    } catch (error) {
      // pgrep 无匹配时退出码为 1，这是“零个”而不是错误
      if ((error as {code?: unknown}).code === 1) return 0;
      throw error;
    }
  };
  const waitFor = async (predicate: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`等待条件未满足：${what}`);
  };

  // 等待进程树真正建立（fixture 专属标记 + 孙进程）
  await waitFor(async () => (await countByPattern('cd-cancel-child.sh')) >= 1, 'fixture 子进程出现');
  await waitFor(async () => (await countByPattern('sleep 30')) >= 2, 'sleep 孙进程出现');

  run.cancel();
  const result = await run.result;
  expect(result.killed).toBe(true);
  expect(run.killedReason).toBe('cancelled');

  // 整组进程都必须消失
  await waitFor(async () => (await countByPattern('cd-cancel-child.sh')) === 0, '子进程退出');
  await waitFor(async () => (await countByPattern('sleep 30')) === 0, '孙进程退出');
}, 30_000);

test('output beyond the cap terminates the run as output_limit', async () => {
  const exe = await writeScript('flood.sh', 'head -c 200000 /dev/zero | tr "\\0" "x"');
  const run = spawnCli({
    executable: exe, args: [], cwd: dir, stdin: '', timeoutMs: 30_000, maxOutputBytes: 4096
  });
  const result = await run.result;
  expect(result.killed).toBe(true);
  expect(run.killedReason).toBe('output_limit');
});

test('missing executable surfaces ENOENT as spawn error', async () => {
  const run = spawnCli({
    executable: join(dir, '不存在'), args: [], cwd: dir, stdin: '', timeoutMs: 1000
  });
  await expect(run.result).rejects.toSatisfy(
    (error: unknown) => (error as {code?: string}).code === 'cli_spawn_failed'
  );
});
