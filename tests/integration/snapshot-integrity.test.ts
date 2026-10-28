import { beforeEach, afterEach, expect, test } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository } from '../../src/main/services/repositories';
import { buildSnapshot } from '../../src/main/services/snapshots';
import type { Repository } from '../../src/shared/contracts';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

let root: string;
let repo: Repository;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'branchroom-integrity-'));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  repo = await openRepository(root);
});

afterEach(async () => {
  await rm(root, {recursive: true, force: true});
});

// CHECK-01：初始干净仓库，捕获期间文件变脏 → 必须重试并包含变更
test('detects worktree changes appearing during capture of a clean repo', async () => {
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'empty'], {cwd: root});
  await writeFile(join(root, 'f.txt'), 'old\n', 'utf8');
  await exec('git', ['add', 'f.txt'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await rm(join(root, 'f.txt'));

  let mutated = false;
  const snap = await buildSnapshot(repo, {
    hooks: {
      beforeVerify: async () => {
        if (!mutated) {
          mutated = true;
          await writeFile(join(root, 'f.txt'), 'new\n', 'utf8'); // 被删除的路径重新出现
        }
      }
    }
  });
  expect(mutated).toBe(true);
  // 重试后的快照必须反映磁盘真实状态：f 已恢复为 new 内容 → 与 HEAD 不同 → 变更可见
  const paths = snap.files.map((f) => f.path);
  expect(paths).toContain('f.txt');
  expect(snap.files.find((f) => f.path === 'f.txt')).toMatchObject({
    kind: 'modified',
    currentContent: 'new\n',
    baseContent: 'old\n'
  });
});

// CHECK-01：捕获期间出现新的未跟踪文件
test('detects new untracked file appearing during capture', async () => {
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'base'], {cwd: root});
  let mutated = false;
  const snap = await buildSnapshot(repo, {
    hooks: {
      beforeVerify: async () => {
        if (!mutated) {
          mutated = true;
          await writeFile(join(root, 'late.txt'), '迟到的新文件\n', 'utf8');
        }
      }
    }
  });
  expect(mutated).toBe(true);
  expect(snap.files.map((f) => f.path)).toContain('late.txt');
});

// CHECK-01：捕获期间仅有 index 变化（同一文件被 add）
test('detects index-only changes during capture', async () => {
  await writeFile(join(root, 'g.txt'), 'base\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await writeFile(join(root, 'g.txt'), 'modified\n', 'utf8');

  let staged = false;
  const snap = await buildSnapshot(repo, {
    hooks: {
      beforeVerify: async () => {
        if (!staged) {
          staged = true;
          await exec('git', ['add', 'g.txt'], {cwd: root}); // 仅 index 变化
        }
      }
    }
  });
  expect(staged).toBe(true);
  const file = snap.files.find((f) => f.path === 'g.txt');
  expect(file).toBeDefined();
  // 重试后的快照与当时 index 一致：indexStatus 应为 M（已暂存）而非 '.'
  expect(file!.indexStatus).toBe('M');
});

// CHECK-02：暂存删除后重建同名文件 → 单一条目、内容正确
test('staged deletion plus recreated file merges into one consistent entry', async () => {
  await writeFile(join(root, 'f.txt'), 'old\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await exec('git', ['rm', '-q', 'f.txt'], {cwd: root});
  await writeFile(join(root, 'f.txt'), 'new\n', 'utf8');

  const snap = await buildSnapshot(repo);
  const entries = snap.files.filter((f) => f.path === 'f.txt');
  expect(entries).toHaveLength(1); // 无重复 ID
  const file = entries[0]!;
  expect(file.baseContent).toBe('old\n');
  expect(file.currentContent).toBe('new\n'); // 不再复用删除 patch 的旧正文
  expect(file.kind).toBe('modified'); // HEAD → 工作区的净效果
  expect(file.id).toBe('f.txt');
});

// CHECK-03：变化的子模块不拖垮整份快照
test('changed submodule yields explicit unavailable entry without breaking other files', async () => {
  const child = await mkdtemp(join(tmpdir(), 'branchroom-submodule-'));
  try {
    await exec('git', ['init', '-q', '-b', 'main', child]);
    await writeFile(join(child, 'inner.txt'), 'inner\n', 'utf8');
    await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: child});
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'c1'], {cwd: child});

    await writeFile(join(root, 'outer.txt'), 'outer\n', 'utf8');
    // 本地临时路径以 file:// 添加子模块，且不触发递归网络操作
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child'], {cwd: root});
    await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'with submodule'], {cwd: root});

    // 子模块指针前移：必须提交到父仓库内的 clone（vendor/child），源仓库不参与父仓库状态
    const clonePath = join(root, 'vendor/child');
    await writeFile(join(clonePath, 'pointer.txt'), '指针前进\n', 'utf8');
    await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: clonePath});
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'c2'], {cwd: clonePath});
    await exec('git', ['add', 'vendor/child'], {cwd: root});

    const snap = await buildSnapshot(repo);
    const paths = snap.files.map((f) => f.path);
    expect(paths).toContain('vendor/child');
    const sub = snap.files.find((f) => f.path === 'vendor/child')!;
    expect(sub.reviewable).toBe(false);
    expect(sub.unavailableReason).toContain('子模块');
    // 未变更的普通文件不出现；快照成功说明子模块没有拖垮整份结果
    expect(paths).not.toContain('outer.txt');
  } finally {
    await rm(child, {recursive: true, force: true});
  }
});

test('dirty worktree inside a submodule also stays isolated', async () => {
  const child = await mkdtemp(join(tmpdir(), 'branchroom-submodule-'));
  try {
    await exec('git', ['init', '-q', '-b', 'main', child]);
    await writeFile(join(child, 'inner.txt'), 'inner\n', 'utf8');
    await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: child});
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'c1'], {cwd: child});
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child'], {cwd: root});
    await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
    await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'with submodule'], {cwd: root});

    // 只弄脏父仓库内 clone 的工作区（不产生新提交，不移动指针）
    await writeFile(join(root, 'vendor/child', 'extra.txt'), '脏\n', 'utf8');

    const snap = await buildSnapshot(repo);
    const sub = snap.files.find((f) => f.path === 'vendor/child');
    expect(sub).toBeDefined();
    expect(sub!.reviewable).toBe(false);
  } finally {
    await rm(child, {recursive: true, force: true});
  }
});
