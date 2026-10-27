import { beforeEach, afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { openRepository, RepositoryError } from '../../src/main/services/repositories';

const exec = promisify(execFile);
// 单次 git -c 提供作者信息，绝不修改全局 Git 配置。
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'branchroom-中文 仓库-'));
  await exec('git', ['init', '-q', root]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('opens a repository without an initial commit', async () => {
  const repo = await openRepository(root);
  expect(repo.head).toBeNull();
  expect(repo.root).toContain('branchroom-中文 仓库-');
  expect(repo.branch).not.toBeNull();
  expect(repo.gitDir).not.toBe('');
  expect(repo.commonGitDir).not.toBe('');
  expect(repo.id).not.toBe('');
  expect(repo.name).toBe(basename(repo.root));
});

test('rejects a non-Git directory', async () => {
  const other = await mkdtemp(join(tmpdir(), 'branchroom-not-git-'));
  try {
    await expect(openRepository(other)).rejects.toSatisfy(
      (error: unknown) => error instanceof RepositoryError && error.code === 'not_git_repository'
    );
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test('rejects a path that does not exist', async () => {
  await expect(openRepository(join(root, '不存在的目录'))).rejects.toSatisfy(
    (error: unknown) => error instanceof RepositoryError && error.code === 'path_not_found'
  );
});

test('rejects a bare repository', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'branchroom-bare-'));
  try {
    await exec('git', ['init', '-q', '--bare', bare]);
    await expect(openRepository(bare)).rejects.toSatisfy(
      (error: unknown) => error instanceof RepositoryError && error.code === 'bare_repository'
    );
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('detects a detached HEAD', async () => {
  await exec('git', [...GIT_AUTHOR, 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: root });
  await exec('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: root });
  const repo = await openRepository(root);
  expect(repo.branch).toBeNull();
  expect(repo.head).toMatch(/^[0-9a-f]{40}$/);
});

test('accepts a subdirectory and resolves to the worktree root', async () => {
  const sub = join(root, 'nested', ' deeper dir');
  await mkdir(sub, { recursive: true });
  const repo = await openRepository(sub);
  expect(repo.root).toContain('branchroom-中文 仓库-');
});

test('linked worktree has a distinct id but the same common git dir', async () => {
  await exec('git', [...GIT_AUTHOR, 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: root });
  const worktree = join(root, '..', 'branchroom-wt-fixture');
  try {
    await exec('git', ['worktree', 'add', '-q', '-b', 'topic', worktree, 'HEAD'], { cwd: root });
    const main = await openRepository(root);
    const linked = await openRepository(worktree);
    expect(linked.id).not.toBe(main.id);
    expect(linked.commonGitDir).toBe(main.commonGitDir);
    expect(linked.gitDir).not.toBe(main.gitDir);
    expect(linked.branch).toBe('topic');
    expect(main.branch).toMatch(/^main$|^master$/);
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
});
