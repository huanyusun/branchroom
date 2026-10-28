import { diffArrays } from 'diff';
import type { ChangeFile } from '../../shared/contracts';

export type AlignedRow =
  | {type: 'equal'; baseLine: number; currentLine: number; text: string}
  | {type: 'modify'; baseLine: number; currentLine: number; base: string; current: string}
  | {type: 'add'; currentLine: number; text: string}
  | {type: 'del'; baseLine: number; text: string};

export interface Alignment {
  rows: AlignedRow[];
  additions: number;
  deletions: number;
}

/**
 * 生成左右对齐的行级视图：相邻的删除/新增块按下标配对成 modify 行，
 * 多余部分保留为纯 add/del 行。渲染端保证同一行左右格共享高度，
 * 因此长行换行时两侧仍逐行对齐。
 */
export function alignLines(base: string[], current: string[]): Alignment {
  const parts = diffArrays(base, current);
  const rows: AlignedRow[] = [];
  let additions = 0;
  let deletions = 0;
  let baseLine = 0;
  let currentLine = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lines = part.value as string[];
    if (part.removed) {
      const next = parts[i + 1];
      if (next !== undefined && next.added) {
        const addedLines = next.value as string[];
        const paired = Math.min(lines.length, addedLines.length);
        for (let k = 0; k < paired; k++) {
          baseLine += 1;
          currentLine += 1;
          rows.push({type: 'modify', baseLine, currentLine, base: lines[k]!, current: addedLines[k]!});
          additions += 1;
          deletions += 1;
        }
        for (let k = paired; k < lines.length; k++) {
          baseLine += 1;
          rows.push({type: 'del', baseLine, text: lines[k]!});
          deletions += 1;
        }
        for (let k = paired; k < addedLines.length; k++) {
          currentLine += 1;
          rows.push({type: 'add', currentLine, text: addedLines[k]!});
          additions += 1;
        }
        i += 1;
      } else {
        for (const line of lines) {
          baseLine += 1;
          rows.push({type: 'del', baseLine, text: line});
          deletions += 1;
        }
      }
    } else if (part.added) {
      for (const line of lines) {
        currentLine += 1;
        rows.push({type: 'add', currentLine, text: line});
        additions += 1;
      }
    } else {
      for (const line of lines) {
        baseLine += 1;
        currentLine += 1;
        rows.push({type: 'equal', baseLine, currentLine, text: line});
      }
    }
  }

  return {rows, additions, deletions};
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

/** 统计单个文件的 +/- 行数：优先解析 patch；新增/删除文件回退到内容行数。 */
export function fileChangeStats(file: ChangeFile): {additions: number | null; deletions: number | null} {
  if (file.patch !== null) {
    let additions = 0;
    let deletions = 0;
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    return {additions, deletions};
  }
  if (file.kind === 'added' && file.currentContent !== null) {
    return {additions: countLines(file.currentContent), deletions: 0};
  }
  if (file.kind === 'deleted' && file.baseContent !== null) {
    return {additions: 0, deletions: countLines(file.baseContent)};
  }
  return {additions: null, deletions: null};
}
