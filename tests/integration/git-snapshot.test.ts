import { beforeEach, afterEach, expect, test } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository, RepositoryError } from '../../src/main/services/repositories';
import { buildSnapshot, SnapshotError } from '../../src/main/services/snapshots';
import { runGit } from '../../src/main/services/git';
import type { Repository } from '../../src/shared/contracts';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

let root: string;
let repo: Repository;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'branchroom-snap-'));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  repo = await openRepository(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function commitAll(message: string): Promise<string> {
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], { cwd: root });
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '--allow-empty', '-m', message], { cwd: root });
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  return stdout.trim();
}

test('modified worktree file: base/current/patch from the same snapshot', async () => {
  const head = await commitAll('base');
  await writeFile(join(root, 'app.ts'), '第一行\n旧的第二行\n第三行\n', 'utf8');
  await exec('git', ['add', '-A'], { cwd: root });
  await commitAll('v1');
  await writeFile(join(root, 'app.ts'), '第一行\n新的第二行（更长一些）\n第三行\n', 'utf8');

  const snap = await buildSnapshot(repo);
  expect(snap.head).toBe(await exec('git', ['rev-parse', 'HEAD'], { cwd: root }).then((r) => r.stdout.trim()));
  expect(snap.repoId).toBe(repo.id);
  expect(snap.files).toHaveLength(1);

  const file = snap.files[0]!;
  expect(file.path).toBe('app.ts');
  expect(file.kind).toBe('modified');
  expect(file.indexStatus).toBe('.');
  expect(file.worktreeStatus).toBe('M');
  expect(file.baseContent).toContain('旧的第二行');
  expect(file.currentContent).toContain('新的第二行');
  expect(file.patch).toContain('-旧的第二行');
  expect(file.patch).toContain('+新的第二行');
  expect(file.reviewable).toBe(true);
  expect(file.unavailableReason).toBeNull();
  expect(file.reviewState).toBe('pending');
  expect(file.fingerprint).not.toBe('');
  expect(snap.head).not.toBe(head); // 快照基于最新 HEAD
});

test('unborn HEAD with staged and untracked files', async () => {
  await writeFile(join(root, 'staged.ts'), '已暂存\n', 'utf8');
  await exec('git', ['add', 'staged.ts'], { cwd: root });
  await writeFile(join(root, 'untracked.txt'), '未跟踪\n', 'utf8');

  const snap = await buildSnapshot(repo);
  expect(snap.head).toBeNull();
  const byPath = new Map(snap.files.map((f) => [f.path, f]));
  expect(byPath.get('staged.ts')).toMatchObject({
    kind: 'added',
    indexStatus: 'A',
    baseContent: null,
    reviewable: true
  });
  expect(byPath.get('untracked.txt')).toMatchObject({
    kind: 'added',
    indexStatus: '?',
    worktreeStatus: '?',
    baseContent: null,
    currentContent: '未跟踪\n'
  });
});

test('deleted file keeps base content and patch', async () => {
  await writeFile(join(root, 'gone.md'), '将被删除\n', 'utf8');
  await commitAll('add file');
  await exec('git', ['rm', '-q', 'gone.md'], { cwd: root });

  const snap = await buildSnapshot(repo);
  const file = snap.files.find((f) => f.path === 'gone.md');
  expect(file).toMatchObject({
    kind: 'deleted',
    currentContent: null,
    reviewable: true
  });
  expect(file!.baseContent).toBe('将被删除\n');
  expect(file!.patch).toContain('--- a/gone.md');
  expect(file!.patch).toContain('-将被删除');
});

test('rename with edit: previousPath, rename patch, old base content', async () => {
  await writeFile(join(root, 'old.md'), '第一版\n', 'utf8');
  await commitAll('add');
  await exec('git', ['mv', 'old.md', '新位置.md'], { cwd: root });
  await writeFile(join(root, '新位置.md'), '第一版\n第二版\n', 'utf8');

  const snap = await buildSnapshot(repo);
  expect(snap.files).toHaveLength(1);
  const file = snap.files[0]!;
  expect(file.kind).toBe('renamed');
  expect(file.path).toBe('新位置.md');
  expect(file.previousPath).toBe('old.md');
  expect(file.baseContent).toBe('第一版\n');
  expect(file.currentContent).toBe('第一版\n第二版\n');
  expect(file.patch).toContain('rename from old.md');
  expect(file.patch).toContain('rename to 新位置.md');
});

test('pure rename keeps identical content and is reviewable', async () => {
  await writeFile(join(root, 'a.md'), '内容\n', 'utf8');
  await commitAll('add');
  await exec('git', ['mv', 'a.md', 'b.md'], { cwd: root });

  const snap = await buildSnapshot(repo);
  const file = snap.files[0]!;
  expect(file.kind).toBe('renamed');
  expect(file.baseContent).toBe(file.currentContent);
  expect(file.reviewable).toBe(true);
});

test('merge conflict: visible but not reviewable, with explicit reason', async () => {
  await writeFile(join(root, 'c.txt'), 'base\n', 'utf8');
  await commitAll('base');
  await exec('git', ['checkout', '-q', '-b', 'feature'], { cwd: root });
  await writeFile(join(root, 'c.txt'), 'feature\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-am', 'feature'], { cwd: root });
  await exec('git', ['checkout', '-q', 'main'], { cwd: root });
  await writeFile(join(root, 'c.txt'), 'mainline\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-am', 'mainline'], { cwd: root });
  await exec('git', ['merge', '--no-edit', 'feature'], { cwd: root }).catch(() => undefined); // 预期冲突

  const snap = await buildSnapshot(repo);
  const file = snap.files.find((f) => f.path === 'c.txt');
  expect(file!.kind).toBe('conflicted');
  expect(file!.reviewable).toBe(false);
  expect(file!.unavailableReason).toContain('冲突');
  expect(file!.currentContent).toContain('<<<<<<<');
});

test('binary file: not reviewable with explicit reason', async () => {
  await writeFile(join(root, 'data.bin'), Buffer.from([0x41, 0x42, 0x00, 0x43]));
  await commitAll('add binary');
  await writeFile(join(root, 'data.bin'), Buffer.from([0x41, 0x42, 0x00, 0x44]));

  const snap = await buildSnapshot(repo);
  const file = snap.files.find((f) => f.path === 'data.bin');
  expect(file!.reviewable).toBe(false);
  expect(file!.unavailableReason).toContain('二进制');
});

test('symlink: shows link target, not the linked file content', async () => {
  await symlink('../elsewhere.txt', join(root, 'link.txt'));

  const snap = await buildSnapshot(repo);
  const file = snap.files.find((f) => f.path === 'link.txt');
  expect(file!.reviewable).toBe(false);
  expect(file!.unavailableReason).toContain('符号链接');
  expect(file!.currentContent).toBe('../elsewhere.txt');
});

test('oversized file: explicit size limit reason, no silent truncation', async () => {
  await writeFile(join(root, 'big.txt'), 'x'.repeat(200), 'utf8');
  const snap = await buildSnapshot(repo, { contentLimitBytes: 64 });
  const file = snap.files.find((f) => f.path === 'big.txt');
  expect(file!.reviewable).toBe(false);
  expect(file!.unavailableReason).toContain('过大');
  expect(file!.currentContent).toBeNull();
});

test('unchanged files are not listed; files are sorted by path', async () => {
  await writeFile(join(root, 'kept.ts'), '不变\n', 'utf8');
  await writeFile(join(root, 'z-change.ts'), '旧\n', 'utf8');
  await writeFile(join(root, 'a-change.ts'), '旧\n', 'utf8');
  await commitAll('base');
  await writeFile(join(root, 'z-change.ts'), '新\n', 'utf8');
  await writeFile(join(root, 'a-change.ts'), '新\n', 'utf8');

  const snap = await buildSnapshot(repo);
  expect(snap.files.map((f) => f.path)).toEqual(['a-change.ts', 'z-change.ts']);
});

test('mixed staged and unstaged changes keep both statuses', async () => {
  await writeFile(join(root, 'm.ts'), 'v1\n', 'utf8');
  await commitAll('base');
  await writeFile(join(root, 'm.ts'), 'v2\n', 'utf8');
  await exec('git', ['add', 'm.ts'], { cwd: root });
  await writeFile(join(root, 'm.ts'), 'v3\n', 'utf8');

  const snap = await buildSnapshot(repo);
  const file = snap.files.find((f) => f.path === 'm.ts')!;
  expect(file.indexStatus).toBe('M');
  expect(file.worktreeStatus).toBe('M');
  expect(file.currentContent).toBe('v3\n'); // 当前工作区内容
  expect(file.baseContent).toBe('v1\n');
});

test('fingerprint is invariant to staging position', async () => {
  await writeFile(join(root, 'f.ts'), 'v1\n', 'utf8');
  await commitAll('base');
  await writeFile(join(root, 'f.ts'), 'v2\n', 'utf8');
  const unstaged = await buildSnapshot(repo);
  const before = unstaged.files[0]!.fingerprint;

  await exec('git', ['add', 'f.ts'], { cwd: root });
  const staged = await buildSnapshot(repo);
  expect(staged.files[0]!.fingerprint).toBe(before);
});

test('retries when HEAD moves during capture and settles on the new head', async () => {
  await writeFile(join(root, 'doc.md'), '内容\n', 'utf8');
  const head = await commitAll('base');

  let mutated = false;
  const snap = await buildSnapshot(repo, {
    hooks: {
      beforeVerify: async () => {
        if (!mutated) {
          mutated = true;
          await writeFile(join(root, 'doc.md'), '内容\n第二行\n', 'utf8');
          await commitAll('move head');
        }
      }
    }
  });
  expect(mutated).toBe(true);
  expect(snap.head).not.toBe(head);
  // 重试后的快照与新 HEAD 一致：doc.md 相对 HEAD 无变更
  expect(snap.files).toHaveLength(0);
});

test('persistent HEAD movement returns snapshot_changed instead of a mixed snapshot', async () => {
  await writeFile(join(root, 'doc.md'), '内容\n', 'utf8');
  await commitAll('base');
  await writeFile(join(root, 'doc.md'), '内容\n改\n', 'utf8');

  await expect(
    buildSnapshot(repo, {
      maxAttempts: 3,
      hooks: {
        beforeVerify: async () => {
          await exec('git', [...GIT_AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'keep moving'], { cwd: root });
        }
      }
    })
  ).rejects.toSatisfy((error: unknown) => error instanceof SnapshotError && error.code === 'snapshot_changed');
});

test('snapshot id is unique per capture', async () => {  await writeFile(join(root, 'x.txt'), 'x\n', 'utf8');
  const a = await buildSnapshot(repo);
  await writeFile(join(root, 'x.txt'), 'y\n', 'utf8');
  const b = await buildSnapshot(repo);
  expect(a.id).not.toBe(b.id);
});

test('reads Chinese and space file names exactly', async () => {
  await mkdir(join(root, '设计 文档'), { recursive: true });
  await writeFile(join(root, '设计 文档/说明 v2.md'), '正文\n', 'utf8');

  const snap = await buildSnapshot(repo);
  expect(snap.files.map((f) => f.path)).toEqual(['设计 文档/说明 v2.md']);
  expect((await readFile(join(root, '设计 文档/说明 v2.md'), 'utf8'))).toBe(snap.files[0]!.currentContent);
});

// CHECK-06：Tab 等特殊字符路径会被 Git C 风格引用，patch 仍必须能关联
test('paths with tabs keep their patch via quoted-path decoding', async () => {
  const weird = join(root, 'tab\t名字.md');
  await writeFile(weird, 'v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await writeFile(weird, 'v2\n', 'utf8');

  const snap = await buildSnapshot(repo);
  const file = snap.files.find((f) => f.path === 'tab\t名字.md');
  expect(file).toBeDefined();
  expect(file!.reviewable).toBe(true);
  expect(file!.patch).not.toBeNull();
  expect(file!.patch).toContain('-v1');
  expect(file!.patch).toContain('+v2');
});

// CHECK-09：diff 输出超过缓冲上限时必须报 diff_too_large，而不是被包装吞掉
test('diff buffer overflow maps to diff_too_large', async () => {
  await writeFile(join(root, 'big.txt'), `${'x'.repeat(1000)}\n`, 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await writeFile(join(root, 'big.txt'), `${'y'.repeat(1000)}\n`, 'utf8');

  await expect(
    runGit(root, ['diff', 'HEAD'], {maxBuffer: 16, overflowCode: 'diff_too_large'})
  ).rejects.toSatisfy(
    (error: unknown) => error instanceof RepositoryError && error.code === 'diff_too_large'
  );
});
