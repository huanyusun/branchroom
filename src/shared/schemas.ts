// IPC 输入的运行时校验。纯函数、无 Electron/Node 依赖，主进程与测试共用。
// 后续 Agent 输出与持久化结构的校验也放在本文件。

export type Parsed<T> = {ok: true; value: T} | {ok: false; message: string};

const fail = (message: string): {ok: false; message: string} => ({ok: false, message});

export function parseNoInput(input: unknown): Parsed<null> {
  if (input !== undefined && input !== null) return fail('此操作不接受参数');
  return {ok: true, value: null};
}

export function parseOpenRepositoryInput(input: unknown): Parsed<{root: string}> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const root = (input as {root?: unknown}).root;
  if (typeof root !== 'string' || root.trim() === '') return fail('root 必须是非空字符串');
  return {ok: true, value: {root}};
}

export function parseRemoveRepositoryInput(input: unknown): Parsed<{id: string}> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const id = (input as {id?: unknown}).id;
  if (typeof id !== 'string' || id.trim() === '') return fail('id 必须是非空字符串');
  return {ok: true, value: {id}};
}

export function parseGetSnapshotInput(input: unknown): Parsed<{repoId: string}> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const repoId = (input as {repoId?: unknown}).repoId;
  if (typeof repoId !== 'string' || repoId.trim() === '') return fail('repoId 必须是非空字符串');
  return {ok: true, value: {repoId}};
}

const REVIEW_SAVE_STATES = new Set(['pending', 'reviewed', 'issue']);

export interface SaveReviewInput {
  repoId: string;
  snapshotId: string;
  fileId: string;
  expectedFingerprint: string;
  state: 'pending' | 'reviewed' | 'issue';
  note: string;
}

export function parseSaveReviewInput(input: unknown): Parsed<SaveReviewInput> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const record = input as Record<string, unknown>;
  for (const field of ['repoId', 'snapshotId', 'fileId', 'expectedFingerprint'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      return fail(`${field} 必须是非空字符串`);
    }
  }
  if (typeof record.state !== 'string' || !REVIEW_SAVE_STATES.has(record.state)) {
    return fail('state 必须是 pending / reviewed / issue');
  }
  if (typeof record.note !== 'string') return fail('note 必须是字符串');
  return {
    ok: true,
    value: {
      repoId: record.repoId as string,
      snapshotId: record.snapshotId as string,
      fileId: record.fileId as string,
      expectedFingerprint: record.expectedFingerprint as string,
      state: record.state as SaveReviewInput['state'],
      note: record.note
    }
  };
}

export interface SaveDraftInput {
  repoId: string;
  snapshotId: string;
  fileId: string;
  expectedFingerprint: string;
  note: string;
}

/** 草稿与结论共用身份字段，但草稿不需要 state。 */
function parseReviewIdentity(input: unknown): Parsed<{repoId: string; snapshotId: string; fileId: string; expectedFingerprint: string; note: string}> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const record = input as Record<string, unknown>;
  for (const field of ['repoId', 'snapshotId', 'fileId', 'expectedFingerprint'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      return fail(`${field} 必须是非空字符串`);
    }
  }
  if (typeof record.note !== 'string') return fail('note 必须是字符串');
  return {
    ok: true,
    value: {
      repoId: record.repoId as string,
      snapshotId: record.snapshotId as string,
      fileId: record.fileId as string,
      expectedFingerprint: record.expectedFingerprint as string,
      note: record.note
    }
  };
}

export function parseSaveDraftInput(input: unknown): Parsed<SaveDraftInput> {
  return parseReviewIdentity(input);
}

export function parseFileScopedInput(input: unknown): Parsed<{repoId: string; fileId: string}> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const record = input as Record<string, unknown>;
  for (const field of ['repoId', 'fileId'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      return fail(`${field} 必须是非空字符串`);
    }
  }
  return {ok: true, value: {repoId: record.repoId as string, fileId: record.fileId as string}};
}

const PROVIDERS = new Set(['codex', 'claude']);

export interface StartReviewInput {
  repoId: string;
  snapshotId: string;
  fileIds: string[];
  provider: 'codex' | 'claude';
}

export function parseStartReviewInput(input: unknown): Parsed<StartReviewInput> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const record = input as Record<string, unknown>;
  for (const field of ['repoId', 'snapshotId'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      return fail(`${field} 必须是非空字符串`);
    }
  }
  if (!Array.isArray(record.fileIds) || record.fileIds.length === 0
    || !record.fileIds.every((id) => typeof id === 'string' && id !== '')) {
    return fail('fileIds 必须是非空字符串数组');
  }
  if (typeof record.provider !== 'string' || !PROVIDERS.has(record.provider)) {
    return fail('provider 必须是 codex 或 claude');
  }
  return {
    ok: true,
    value: {
      repoId: record.repoId as string,
      snapshotId: record.snapshotId as string,
      fileIds: record.fileIds as string[],
      provider: record.provider as StartReviewInput['provider']
    }
  };
}

export function parseCancelReviewInput(input: unknown): Parsed<{runId: string}> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const runId = (input as {runId?: unknown}).runId;
  if (typeof runId !== 'string' || runId.trim() === '') return fail('runId 必须是非空字符串');
  return {ok: true, value: {runId}};
}

export interface PathsInput {
  repoId: string;
  paths: string[];
}

export function parsePathsInput(input: unknown): Parsed<PathsInput> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const record = input as Record<string, unknown>;
  if (typeof record.repoId !== 'string' || record.repoId.trim() === '') {
    return fail('repoId 必须是非空字符串');
  }
  if (!Array.isArray(record.paths) || record.paths.length === 0
    || !record.paths.every((path) => typeof path === 'string' && path !== '')) {
    return fail('paths 必须是非空字符串数组');
  }
  return {ok: true, value: {repoId: record.repoId as string, paths: record.paths as string[]}};
}

export interface CommitInput {
  repoId: string;
  message: string;
  paths?: string[];
}

export function parseCommitInput(input: unknown, requirePaths: boolean): Parsed<CommitInput> {
  if (typeof input !== 'object' || input === null) return fail('参数必须是对象');
  const record = input as Record<string, unknown>;
  if (typeof record.repoId !== 'string' || record.repoId.trim() === '') {
    return fail('repoId 必须是非空字符串');
  }
  if (typeof record.message !== 'string' || record.message.trim() === '') {
    return fail('message 必须是非空字符串');
  }
  if (requirePaths) {
    if (!Array.isArray(record.paths) || record.paths.length === 0
      || !record.paths.every((path) => typeof path === 'string' && path !== '')) {
      return fail('paths 必须是非空字符串数组');
    }
    return {
      ok: true,
      value: {repoId: record.repoId as string, message: record.message as string, paths: record.paths as string[]}
    };
  }
  return {ok: true, value: {repoId: record.repoId as string, message: record.message as string}};
}
