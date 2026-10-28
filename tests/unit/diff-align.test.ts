import { describe, expect, test } from 'vitest';
import { alignLines, fileChangeStats, splitContentLines } from '../../src/renderer/lib/diff';
import type { ChangeFile } from '../../src/shared/contracts';

function split(text: string): string[] {
  return splitContentLines(text);
}

describe('splitContentLines', () => {
  test('empty content has no lines', () => {
    expect(splitContentLines('')).toEqual([]);
  });

  test('trailing newline does not create a phantom line', () => {
    expect(splitContentLines('x\n')).toEqual(['x']);
    expect(splitContentLines('a\nb\n')).toEqual(['a', 'b']);
  });

  test('missing trailing newline still counts the last line', () => {
    expect(splitContentLines('a\nb')).toEqual(['a', 'b']);
  });

  test('a lone newline is one empty line', () => {
    expect(splitContentLines('\n')).toEqual(['']);
  });
});

describe('fileChangeStats', () => {
  const makeFile = (overrides: Partial<ChangeFile>): ChangeFile => ({
    id: 'f',
    path: 'f',
    previousPath: null,
    kind: 'modified',
    indexStatus: '.',
    worktreeStatus: 'M',
    fingerprint: 'x',
    baseContent: null,
    currentContent: null,
    patch: null,
    reviewable: true,
    unavailableReason: null,
    reviewState: 'pending',
    ...overrides
  });

  test('trailing newline counts as one line for added files', () => {
    const stats = fileChangeStats(makeFile({kind: 'added', currentContent: 'x\n', baseContent: null}));
    expect(stats).toEqual({additions: 1, deletions: 0});
  });

  test('patch stats only count lines inside hunks', () => {
    const patch = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      ' context',
      '-删除行',
      '+增加行',
      '++这行正文以加号开头，也要计入新增',
      '\\ No newline at end of file'
    ].join('\n');
    const stats = fileChangeStats(makeFile({patch}));
    expect(stats).toEqual({additions: 2, deletions: 1});
  });

  test('non-reviewable files without material report null stats', () => {
    const stats = fileChangeStats(makeFile({reviewable: false, kind: 'modified'}));
    expect(stats).toEqual({additions: null, deletions: null});
  });
});

describe('alignLines', () => {
  test('identical content yields equal rows only', () => {
    const { rows } = alignLines(split('a\nb\nc'), split('a\nb\nc'));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.type === 'equal')).toBe(true);
    expect(rows[0]).toMatchObject({ type: 'equal', baseLine: 1, currentLine: 1 });
  });

  test('one modified line pairs base and current into a modify row', () => {
    const { rows } = alignLines(split('a\nb\nc'), split('a\nB\nc'));
    const modify = rows.filter((row) => row.type === 'modify');
    expect(modify).toHaveLength(1);
    expect(modify[0]).toMatchObject({ base: 'b', current: 'B', baseLine: 2, currentLine: 2 });
    expect(rows.filter((row) => row.type === 'equal')).toHaveLength(2);
  });

  test('insertion in the middle yields add rows', () => {
    const { rows } = alignLines(split('a\nc'), split('a\nb1\nb2\nc'));
    const adds = rows.filter((row) => row.type === 'add');
    expect(adds.map((row) => (row as {text: string}).text)).toEqual(['b1', 'b2']);
    expect(rows.at(-1)).toMatchObject({ type: 'equal', text: 'c' });
  });

  test('deletion in the middle yields delete rows', () => {
    const { rows } = alignLines(split('a\nx1\nx2\nc'), split('a\nc'));
    const dels = rows.filter((row) => row.type === 'del');
    expect(dels.map((row) => (row as {text: string}).text)).toEqual(['x1', 'x2']);
  });

  test('counting separate edits', () => {
    const { rows } = alignLines(split('A\nb\nc\nd\nE'), split('a\nb\nc\nd\ne'));
    expect(rows.filter((row) => row.type === 'modify')).toHaveLength(2);
    expect(rows.filter((row) => row.type === 'equal')).toHaveLength(3);
  });

  test('empty base means everything is added', () => {
    const { rows } = alignLines([], split('新\n文件'));
    expect(rows.every((row) => row.type === 'add')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  test('empty current means everything is deleted', () => {
    const { rows } = alignLines(split('旧\n文件'), []);
    expect(rows.every((row) => row.type === 'del')).toBe(true);
  });

  test('change blocks pair index by index with leftovers as pure rows', () => {
    // 删 3 行、加 2 行 → 2 个 modify + 1 个 del
    const { rows } = alignLines(split('d1\nd2\nd3'), split('n1\nn2'));
    expect(rows.filter((row) => row.type === 'modify')).toHaveLength(2);
    expect(rows.filter((row) => row.type === 'del')).toHaveLength(1);
  });

  test('summary counts additions and deletions', () => {
    const { rows, additions, deletions } = alignLines(split('a\nx\nc'), split('a\ny\ny2\nc'));
    expect(rows.filter((r) => r.type === 'modify')).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'add')).toHaveLength(1);
    expect(additions).toBe(2); // add 1 行 + modify 1 行
    expect(deletions).toBe(1); // modify 1 行
  });
});
