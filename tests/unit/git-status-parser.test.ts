import { describe, expect, test } from 'vitest';
import { parseStatusZ } from '../../src/main/services/git';

// porcelain v2 -z：记录间 NUL 分隔，rename 记录的 origPath 额外用 NUL 跟在 path 后。
// `1 XY sub mH mI mW hH hI path` / `2 ... Xscore path NUL origPath` / `u XY sub m1 m2 m3 mW h1 h2 h3 path`
const ZERO = '0'.repeat(40);
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function changedLine(xy: string, path: string, options?: {hH?: string; hI?: string; sub?: boolean}): string {
  const sub = options?.sub ? 'S' : 'N...';
  const hH = options?.hH ?? HASH_A;
  const hI = options?.hI ?? HASH_B;
  return `1 ${xy} ${sub} 100644 100644 100644 ${hH} ${hI} ${path}`;
}

describe('parseStatusZ', () => {
  test('parses ordinary changed entries', () => {
    const records = parseStatusZ(`${changedLine('M.', 'path/a.ts')}\x00`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: 'changed',
      indexStatus: 'M',
      worktreeStatus: '.',
      path: 'path/a.ts',
      origPath: null,
      headBlob: HASH_A,
      indexBlob: HASH_B
    });
  });

  test('parses worktree-only changes and untracked entries with spaces and Chinese', () => {
    const records = parseStatusZ(
      `${changedLine('.M', '笔记/设计文档 v2.md')}\x00? 未跟踪 新文件.md\x00`
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ worktreeStatus: 'M', path: '笔记/设计文档 v2.md' });
    expect(records[1]).toMatchObject({ code: 'untracked', path: '未跟踪 新文件.md' });
  });

  test('parses rename records with the original path', () => {
    const line = `2 R. N... 100644 100644 100644 ${HASH_A} ${HASH_B} R100 新名字.md\x00旧名字.md\x00`;
    const records = parseStatusZ(line);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: 'renamed',
      path: '新名字.md',
      origPath: '旧名字.md',
      indexStatus: 'R'
    });
  });

  test('parses unmerged records', () => {
    const line = `u UU N... 100644 100644 100644 100644 ${ZERO} ${ZERO} ${ZERO} 冲突.txt\x00`;
    const records = parseStatusZ(line);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: 'unmerged',
      unmerged: true,
      path: '冲突.txt'
    });
    expect(records[0]!.headBlob).toBeNull();
  });

  test('treats all-zero blob hashes as absent', () => {
    const records = parseStatusZ(`${changedLine('A.', 'staged-new.txt', {hH: ZERO})}\x00`);
    expect(records[0]!.headBlob).toBeNull();
    expect(records[0]!.indexBlob).toBe(HASH_B);
  });

  test('flags submodule entries', () => {
    const records = parseStatusZ(`${changedLine('.M', 'vendor/lib', {sub: true})}\x00`);
    expect(records[0]!.submodule).toBe(true);
  });

  test('paths may contain multiple spaces; fixed fields stay intact', () => {
    const records = parseStatusZ(`${changedLine('.M', 'a b  c/文件 名.md')}\x00`);
    expect(records[0]!.path).toBe('a b  c/文件 名.md');
  });

  test('tolerates missing trailing NUL and skips empty segments', () => {
    const records = parseStatusZ(changedLine('.D', 'gone.txt'));
    expect(records).toHaveLength(1);
    expect(parseStatusZ('\x00\x00')).toHaveLength(0);
  });
});
