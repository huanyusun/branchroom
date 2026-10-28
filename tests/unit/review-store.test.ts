import { beforeEach, afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewStore, contentIdentityOf, applyReviewStates } from '../../src/main/services/review-store';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'branchroom-review-store-'));
});

afterEach(async () => {
  await rm(baseDir, {recursive: true, force: true});
});

const IDENTITY_A = contentIdentityOf('旧内容', '新内容');
const IDENTITY_B = contentIdentityOf('旧内容', '更新的内容');

test('review entry roundtrip persists across store instances', async () => {
  const store = createReviewStore(baseDir);
  await store.setReview('repo1', 'src/a.ts', {
    state: 'reviewed',
    note: '看过，没问题',
    contentIdentity: IDENTITY_A,
    snapshotId: 'snap-1',
    updatedAt: '2026-10-28T00:00:00.000Z'
  });
  const second = createReviewStore(baseDir);
  const data = await second.load('repo1');
  expect(data.reviews['src/a.ts']).toMatchObject({state: 'reviewed', note: '看过，没问题'});
});

test('draft roundtrip, replace and clear', async () => {
  const store = createReviewStore(baseDir);
  await store.setDraft('repo1', 'src/a.ts', {
    note: '正在写反馈',
    contentIdentity: IDENTITY_A,
    snapshotId: 'snap-1',
    updatedAt: '2026-10-28T00:00:00.000Z'
  });
  await store.setDraft('repo1', 'src/a.ts', {
    note: '正在写反馈（更新）',
    contentIdentity: IDENTITY_A,
    snapshotId: 'snap-1',
    updatedAt: '2026-10-28T00:01:00.000Z'
  });
  expect((await store.load('repo1')).drafts['src/a.ts']?.note).toBe('正在写反馈（更新）');
  await store.clearDraft('repo1', 'src/a.ts');
  expect((await store.load('repo1')).drafts['src/a.ts']).toBeUndefined();
});

test('repos are isolated by id (repo vs worktree)', async () => {
  const store = createReviewStore(baseDir);
  await store.setReview('repo-main', 'f.ts', {
    state: 'issue',
    note: '主仓库的问题',
    contentIdentity: IDENTITY_A,
    snapshotId: 's',
    updatedAt: 'x'
  });
  const other = await store.load('repo-wt');
  expect(other.reviews['f.ts']).toBeUndefined();
});

test('corrupt file is backed up and starts empty', async () => {
  const store = createReviewStore(baseDir);
  await store.setReview('repo1', 'f.ts', {
    state: 'reviewed', note: '', contentIdentity: IDENTITY_A, snapshotId: 's', updatedAt: 'x'
  });
  const filePath = join(baseDir, 'repo1', 'state.json');
  const raw = await readFile(filePath, 'utf8');
  const {writeFile} = await import('node:fs/promises');
  await writeFile(filePath, raw.slice(0, 20) + '!!!', 'utf8');
  expect((await store.load('repo1')).reviews).toEqual({});
  const files = await readdir(join(baseDir, 'repo1'));
  expect(files.some((name) => name.includes('state.json.corrupt-'))).toBe(true);
});

test('no temp file left after atomic save', async () => {
  const store = createReviewStore(baseDir);
  await store.setReview('repo1', 'f.ts', {
    state: 'issue', note: 'n', contentIdentity: IDENTITY_A, snapshotId: 's', updatedAt: 'x'
  });
  const files = await readdir(join(baseDir, 'repo1'));
  expect(files.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
});

describe('applyReviewStates', () => {
  const makeFile = (path: string, base: string | null, current: string | null) => ({
    path,
    baseContent: base,
    currentContent: current,
    reviewState: 'pending' as const
  });

  test('matching identity keeps the stored state', async () => {
    const store = createReviewStore(baseDir);
    await store.setReview('r', 'a.ts', {
      state: 'reviewed', note: '', contentIdentity: IDENTITY_A, snapshotId: 's', updatedAt: 'x'
    });
    const data = await store.load('r');
    const files = [makeFile('a.ts', '旧内容', '新内容')];
    applyReviewStates(files, data);
    expect(files[0]!.reviewState).toBe('reviewed');
  });

  test('changed content derives recheck without rewriting history', async () => {
    const store = createReviewStore(baseDir);
    await store.setReview('r', 'a.ts', {
      state: 'reviewed', note: '', contentIdentity: IDENTITY_A, snapshotId: 's', updatedAt: 'x'
    });
    const data = await store.load('r');
    const files = [makeFile('a.ts', '旧内容', '更新的内容')];
    applyReviewStates(files, data);
    expect(files[0]!.reviewState).toBe('recheck');
    expect(data.reviews['a.ts']!.state).toBe('reviewed'); // 历史不被改写
  });

  test('base content change also derives recheck', async () => {
    const store = createReviewStore(baseDir);
    await store.setReview('r', 'a.ts', {
      state: 'issue', note: '', contentIdentity: IDENTITY_A, snapshotId: 's', updatedAt: 'x'
    });
    const data = await store.load('r');
    const files = [makeFile('a.ts', '别的基线', '新内容')];
    applyReviewStates(files, data);
    expect(files[0]!.reviewState).toBe('recheck');
  });

  test('files without entry stay pending', () => {
    const files = [makeFile('b.ts', null, '内容')];
    applyReviewStates(files, {reviews: {}});
    expect(files[0]!.reviewState).toBe('pending');
  });
});
