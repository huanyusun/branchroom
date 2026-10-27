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
