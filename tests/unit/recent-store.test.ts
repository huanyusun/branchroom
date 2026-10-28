import { beforeEach, afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecentStore } from '../../src/main/services/recent-store';
import type { Repository } from '../../src/shared/contracts';

function fakeRepository(root: string): Repository {
  return {
    id: `id-${root}`,
    name: 'demo',
    root,
    gitDir: join(root, '.git'),
    commonGitDir: join(root, '.git'),
    branch: 'main',
    head: null
  };
}

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'branchroom-store-'));
  filePath = join(dir, 'recent-repositories.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('starts empty when no file exists', async () => {
  const store = createRecentStore(filePath);
  expect(await store.list()).toEqual([]);
});

test('persists an entry and reads it back', async () => {
  const store = createRecentStore(filePath);
  await store.add(fakeRepository('/tmp/demo 一'));
  const entries = await store.list();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.repository.root).toBe('/tmp/demo 一');
  expect(entries[0]!.repository?.branch).toBe('main');
  const second = createRecentStore(filePath);
  expect(await second.list()).toHaveLength(1);
});

test('upserts by id instead of duplicating', async () => {
  const store = createRecentStore(filePath);
  const repo = fakeRepository('/tmp/demo');
  await store.add(repo);
  await store.add({ ...repo, branch: 'feature' });
  const entries = await store.list();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.repository?.branch).toBe('feature');
});

test('caps the list and drops the oldest entry', async () => {
  const store = createRecentStore(filePath);
  for (let i = 0; i < 25; i++) {
    await store.add(fakeRepository(`/tmp/repo-${i}`));
  }
  const entries = await store.list();
  expect(entries).toHaveLength(20);
  expect(entries.at(-1)?.repository.root).toBe('/tmp/repo-24');
  expect(entries[0]?.repository.root).toBe('/tmp/repo-5');
});

test('removes an entry', async () => {
  const store = createRecentStore(filePath);
  await store.add(fakeRepository('/tmp/demo'));
  await store.remove(`id-/tmp/demo`);
  expect(await store.list()).toEqual([]);
});

test('recovers from a corrupt file by backing it up and starting empty', async () => {
  await writeFile(filePath, '{ 这不是 JSON');
  const store = createRecentStore(filePath);
  expect(await store.list()).toEqual([]);
  const files = await readdir(dir);
  expect(files.some((name) => name.includes('recent-repositories.json.corrupt-'))).toBe(true);
  await store.add(fakeRepository('/tmp/demo'));
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number };
  expect(raw.schemaVersion).toBe(1);
});

test('concurrent adds do not lose entries or fail', async () => {
  const store = createRecentStore(filePath);
  const results = await Promise.allSettled([
    store.add(fakeRepository('/tmp/a')),
    store.add(fakeRepository('/tmp/b')),
    store.add(fakeRepository('/tmp/c'))
  ]);
  expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  const entries = await store.list();
  expect(entries.map((e) => e.repository.root).sort()).toEqual(['/tmp/a', '/tmp/b', '/tmp/c']);
});

test('concurrent add and remove keep consistent state', async () => {
  const store = createRecentStore(filePath);
  await store.add(fakeRepository('/tmp/keep'));
  await store.add(fakeRepository('/tmp/kill'));
  await Promise.allSettled([
    store.add(fakeRepository('/tmp/newcomer')),
    store.remove('id-/tmp/kill')
  ]);
  const roots = (await store.list()).map((e) => e.repository.root).sort();
  expect(roots).toEqual(['/tmp/keep', '/tmp/newcomer']);
});

test('shallow entries with missing fields are rejected as corrupt', async () => {
  await writeFile(
    filePath,
    JSON.stringify({schemaVersion: 1, entries: [{repository: {}, lastOpenedAt: 'bad'}]}),
    'utf8'
  );
  const store = createRecentStore(filePath);
  expect(await store.list()).toEqual([]);
  const files = await readdir(dir);
  expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
});

test('entries with non-string required fields are rejected', async () => {
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      entries: [{
        repository: {id: 42, name: null, root: '', gitDir: '', commonGitDir: '', branch: 1, head: 0},
        lastOpenedAt: 'not-a-date'
      }]
    }),
    'utf8'
  );
  const store = createRecentStore(filePath);
  expect(await store.list()).toEqual([]);
});

test('read failures other than a missing file propagate instead of faking empty', async () => {
  const {mkdir} = await import('node:fs/promises');
  // 让存储路径指向一个目录：readFile 会抛 EISDIR 而不是 ENOENT
  await mkdir(filePath, {recursive: true});
  const store = createRecentStore(filePath);
  await expect(store.list()).rejects.toThrow();
});
