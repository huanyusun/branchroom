import { beforeEach, afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAgent } from '../../src/main/agents/capabilities';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'branchroom-capabilities-'));
});

afterEach(async () => {
  await rm(dir, {recursive: true, force: true});
});

async function writeExecutable(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/bash\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

test('missing executable reports status missing', async () => {
  const capability = await detectAgent('codex', {executablePath: join(dir, '不存在')});
  expect(capability).toMatchObject({provider: 'codex', status: 'missing'});
  expect(capability.executable).toBeNull();
});

test('available executable with version output is available', async () => {
  const exe = await writeExecutable('codex', 'echo "codex-cli 9.9.9"');
  const capability = await detectAgent('codex', {executablePath: exe});
  expect(capability).toMatchObject({
    provider: 'codex',
    status: 'available',
    version: 'codex-cli 9.9.9',
    executable: exe
  });
  expect(capability.diagnostic).toBeNull();
});

test('executable that fails version probe is incompatible with diagnostic', async () => {
  const exe = await writeExecutable('codex', 'echo "配置损坏" >&2; exit 7');
  const capability = await detectAgent('codex', {executablePath: exe});
  expect(capability.status).toBe('incompatible');
  expect(capability.diagnostic).toContain('配置损坏');
  expect(capability.version).toBeNull();
});

test('version output exceeding sanity limits is incompatible', async () => {
  const exe = await writeExecutable('claude', 'head -c 20000 /dev/zero | tr "\\0" "!"');
  const capability = await detectAgent('claude', {executablePath: exe});
  expect(capability.status).toBe('incompatible');
});
