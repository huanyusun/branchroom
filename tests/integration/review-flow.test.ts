import { beforeEach, afterEach, expect, test } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRepository, RepositoryRegistry } from '../../src/main/services/repositories';
import { buildSnapshot } from '../../src/main/services/snapshots';
import { createReviewStore, contentIdentityOf } from '../../src/main/services/review-store';
import { ReviewService, SnapshotRegistry } from '../../src/main/services/review-service';
import type { Repository } from '../../src/shared/contracts';

const exec = promisify(execFile);
const GIT_AUTHOR = ['-c', 'user.name=Branchroom Test', '-c', 'user.email=branchroom@example.invalid'];

let root: string;
let repo: Repository;
let store: ReturnType<typeof createReviewStore>;
let snapshotRegistry: SnapshotRegistry;
let service: ReviewService;
let registry: RepositoryRegistry;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'branchroom-review-'));
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(join(root, 'app.ts'), 'v1\n', 'utf8');
  await exec('git', [...GIT_AUTHOR, 'add', '-A'], {cwd: root});
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '-m', 'base'], {cwd: root});
  await writeFile(join(root, 'app.ts'), 'v2\n', 'utf8');
  repo = await openRepository(root);
  registry = new RepositoryRegistry();
  registry.remember(repo);
  store = createReviewStore(join(root, '..', 'branchroom-review-data'));
  snapshotRegistry = new SnapshotRegistry();
  service = new ReviewService(store, snapshotRegistry, registry);
});

afterEach(async () => {
  await rm(root, {recursive: true, force: true});
  await rm(join(root, '..', 'branchroom-review-data'), {recursive: true, force: true});
});

async function capture(): Promise<string> {
  const snapshot = await buildSnapshot(repo);
  snapshotRegistry.remember(snapshot);
  return snapshot.id;
}

/** 与 getSnapshot handler 相同的组合：构建快照并套用已保存的审查记录。 */
async function captureWithReviews(repository: Repository): Promise<string> {
  const data = await store.load(repository.id);
  const snapshot = await buildSnapshot(repository, {reviewData: data});
  snapshotRegistry.remember(snapshot);
  return snapshot.id;
}

test('mark reviewed, then a fresh snapshot still shows reviewed', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'reviewed', note: '确认无误'
  });

  const nextId = await capture(); // 重新读取快照（内容未变）
  const entries = await service.listEntries(repo.id);
  expect(entries.reviews['app.ts']).toMatchObject({state: 'reviewed', stale: false, note: '确认无误'});

  await captureWithReviews(repo);
  const fresh = await buildSnapshot(repo, {reviewData: await store.load(repo.id)});
  expect(fresh.files[0]!.reviewState).toBe('reviewed');
  expect(nextId).toBeDefined();
});

test('stage/unstage with the same content keeps the review valid', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'reviewed', note: ''
  });
  await exec('git', ['add', 'app.ts'], {cwd: root}); // 仅移动暂存位置

  await capture();
  const entries = await service.listEntries(repo.id);
  expect(entries.reviews['app.ts']!.stale).toBe(false);
  const fresh = await buildSnapshot(repo, {reviewData: await store.load(repo.id)});
  expect(fresh.files[0]!.reviewState).toBe('reviewed');
});

test('content change derives recheck and old note is preserved as stale', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'issue', note: '这里有问题'
  });
  await writeFile(join(root, 'app.ts'), 'v3 完全不同的内容\n', 'utf8');
  await capture();

  const entries = await service.listEntries(repo.id);
  expect(entries.reviews['app.ts']!.stale).toBe(true);
  expect(entries.reviews['app.ts']!.state).toBe('issue'); // 历史保留
  expect(entries.reviews['app.ts']!.note).toBe('这里有问题');

  const fresh = await buildSnapshot(repo, {reviewData: await store.load(repo.id)});
  expect(fresh.files[0]!.reviewState).toBe('recheck');
});

test('saving against a stale fingerprint is rejected with content_changed', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await service.saveDraft({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, note: '未保存的草稿'
  });

  // 磁盘内容变化后，旧 snapshotId 的 fingerprint 已不是当前真实状态
  await writeFile(join(root, 'app.ts'), 'v3\n', 'utf8');
  await expect(service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'reviewed', note: ''
  })).rejects.toSatisfy(
    (error: unknown) => (error as {code?: string}).code === 'content_changed'
  );

  // 草稿仍在（未因保存失败丢失）
  const entries = await service.listEntries(repo.id);
  expect(entries.drafts['app.ts']!.note).toBe('未保存的草稿');
});

test('unknown snapshot or file returns content_changed', async () => {
  const snapshotId = await capture();
  await expect(service.saveReview({
    repoId: repo.id, snapshotId: '不存在的快照', fileId: 'app.ts',
    expectedFingerprint: 'x', state: 'reviewed', note: ''
  })).rejects.toSatisfy((error: unknown) => (error as {code?: string}).code === 'content_changed');
  await expect(service.saveReview({
    repoId: repo.id, snapshotId, fileId: '不存在的文件',
    expectedFingerprint: 'x', state: 'reviewed', note: ''
  })).rejects.toSatisfy((error: unknown) => (error as {code?: string}).code === 'content_changed');
});

test('oversized note is rejected without truncation', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await expect(service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'issue', note: 'x'.repeat(64 * 1024 + 1)
  })).rejects.toSatisfy((error: unknown) => (error as {code?: string}).code === 'note_too_large');
});

test('reset to pending clears the stored review', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'reviewed', note: ''
  });
  await service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'pending', note: ''
  });
  expect((await store.load(repo.id)).reviews['app.ts']).toBeUndefined();
});

test('saving a review promotes and clears the draft', async () => {
  const snapshotId = await capture();
  const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
  await service.saveDraft({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, note: '草稿内容'
  });
  await service.saveReview({
    repoId: repo.id, snapshotId, fileId: 'app.ts',
    expectedFingerprint: file.fingerprint, state: 'issue', note: '正式问题反馈'
  });
  const entries = await service.listEntries(repo.id);
  expect(entries.drafts['app.ts']).toBeUndefined();
  expect(entries.reviews['app.ts']!.note).toBe('正式问题反馈');
});

test('main repo and linked worktree do not share review records', async () => {
  await exec('git', [...GIT_AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'init'], {cwd: root});
  const worktreePath = join(root, '..', 'branchroom-review-wt');
  try {
    await exec('git', ['worktree', 'add', '-q', '-b', 'topic', worktreePath, 'HEAD'], {cwd: root});
    // worktree 内制造自己的变更，避免空快照
    await writeFile(join(worktreePath, 'app.ts'), 'v1\nwt 内的修改\n', 'utf8');
    const wtRepo = await openRepository(worktreePath);
    expect(wtRepo.id).not.toBe(repo.id);

    const snapshotId = await capture();
    const file = snapshotRegistry.fileOf(snapshotId, 'app.ts')!;
    await service.saveReview({
      repoId: repo.id, snapshotId, fileId: 'app.ts',
      expectedFingerprint: file.fingerprint, state: 'reviewed', note: ''
    });

    // worktree 打开后是独立记录
    registry.remember(wtRepo);
    const wtSnapshot = await buildSnapshot(wtRepo, {reviewData: await store.load(wtRepo.id)});
    snapshotRegistry.remember(wtSnapshot);
    expect(wtSnapshot.files[0]!.reviewState).toBe('pending');
    const wtEntries = await service.listEntries(wtRepo.id);
    expect(wtEntries.reviews['app.ts']).toBeUndefined();
  } finally {
    await exec('git', ['worktree', 'remove', '--force', worktreePath], {cwd: root}).catch(() => undefined);
  }
});

test('identity treats identical content across different paths independently', async () => {
  const identity = contentIdentityOf('a', 'b');
  expect(identity).toBe(contentIdentityOf('a', 'b'));
  expect(identity).not.toBe(contentIdentityOf('a', 'c'));
  expect(contentIdentityOf(null, 'x')).toBe(contentIdentityOf('', 'x'));
});
