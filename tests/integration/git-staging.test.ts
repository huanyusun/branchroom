import { beforeEach, afterEach, expect, test } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stageFiles,
  unstageFiles,
  commitStaged,
  commitFiles,
  previewCommit
} from '../../src/main/services/git-staging';
import { StagingError } from '../../src/main/services/git-staging';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'branchroom-staging-'));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'base.txt'), 'base\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
});

afterEach(async () => {
  await rm(root, {recursive: true, force: true});
});

const statusOf = async (): Promise<string> =>
  (await exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1'], {cwd: root})).stdout;

test('stage stages modified and untracked paths explicitly', async () => {
  await writeFile(join(root, 'base.txt'), 'changed\n', 'utf8');
  await writeFile(join(root, 'new.txt'), 'new\n', 'utf8');
  await stageFiles(root, ['base.txt', 'new.txt']);
  const status = await statusOf();
  expect(status).toContain('M  base.txt');
  expect(status).toContain('A  new.txt');
});

test('stage accepts paths with spaces and Chinese names', async () => {
  await mkdir(join(root, '目录 一'), {recursive: true});
  await writeFile(join(root, '目录 一', '说明 文件.md'), '内容\n', 'utf8');
  await stageFiles(root, ['目录 一/说明 文件.md']);
  expect(await statusOf()).toContain('目录 一/说明 文件.md');
});

test('unstage removes entries from the index without touching worktree', async () => {
  await writeFile(join(root, 'new.txt'), 'new\n', 'utf8');
  await stageFiles(root, ['new.txt']);
  await unstageFiles(root, ['new.txt']);
  const status = await statusOf();
  expect(status).toContain('?? new.txt');
  expect(status).not.toContain('A  new.txt');
  // 工作区内容仍在
  await expect(statusOf()).toBeDefined();
});

test('commitStaged commits only the index with the given message', async () => {
  await writeFile(join(root, 'base.txt'), 'staged-change\n', 'utf8');
  await stageFiles(root, ['base.txt']);
  await writeFile(join(root, 'base.txt'), 'worktree-only\n', 'utf8');

  const result = await commitStaged(root, '提交已暂存的修改');
  expect(result.commitHash).toMatch(/^[0-9a-f]{7,40}$/);
  // 已暂存内容被提交；工作区-only 的改动保留
  const {stdout: show} = await exec('git', ['show', '--format=%s', '--stat', 'HEAD'], {cwd: root});
  expect(show).toContain('提交已暂存的修改');
  const after = await statusOf();
  expect(after).toContain(' M base.txt'); // worktree-only 改动未提交
});

test('commitFiles commits the worktree content of only those paths', async () => {
  await writeFile(join(root, 'a.txt'), 'a-new\n', 'utf8');
  await writeFile(join(root, 'base.txt'), 'b-new\n', 'utf8');
  const result = await commitFiles(root, '只提交 a', ['a.txt']);
  expect(result.commitHash).toMatch(/^[0-9a-f]{7,40}$/);
  const {stdout} = await exec('git', ['show', '--name-only', '--format='], {cwd: root});
  expect(stdout.trim()).toBe('a.txt');
  expect(await statusOf()).toContain(' M base.txt');
});

test('previewCommit lists staged files, stats and message-independent info', async () => {
  await writeFile(join(root, 'base.txt'), 'preview\nadded line\n', 'utf8');
  await writeFile(join(root, 'extra.txt'), 'extra\n', 'utf8');
  await stageFiles(root, ['base.txt', 'extra.txt']);
  const preview = await previewCommit(root);
  expect(preview.files).toContain('base.txt');
  expect(preview.files).toContain('extra.txt');
  expect(preview.additions).toBeGreaterThanOrEqual(2);
});

test('empty message or nothing staged is rejected without side effects', async () => {
  await writeFile(join(root, 'base.txt'), 'x\n', 'utf8');
  await stageFiles(root, ['base.txt']);
  await expect(commitStaged(root, '   ')).rejects.toSatisfy(
    (error: unknown) => error instanceof StagingError && error.code === 'invalid_input'
  );
  await unstageFiles(root, ['base.txt']);
  await expect(commitStaged(root, 'msg')).rejects.toSatisfy(
    (error: unknown) => error instanceof StagingError && error.code === 'nothing_staged'
  );
  await expect(commitFiles(root, 'msg', [])).rejects.toSatisfy(
    (error: unknown) => error instanceof StagingError && error.code === 'invalid_input'
  );
});

test('paths outside the repo or escaping it are rejected', async () => {
  await expect(stageFiles(root, ['../outside.txt'])).rejects.toSatisfy(
    (error: unknown) => error instanceof StagingError && error.code === 'invalid_input'
  );
  await expect(stageFiles(root, ['/etc/hosts'])).rejects.toSatisfy(
    (error: unknown) => error instanceof StagingError && error.code === 'invalid_input'
  );
});

test('empty commit is refused by git and surfaced as nothing_staged', async () => {
  await expect(commitStaged(root, '没有暂存任何东西')).rejects.toSatisfy(
    (error: unknown) => error instanceof StagingError && error.code === 'nothing_staged'
  );
});
