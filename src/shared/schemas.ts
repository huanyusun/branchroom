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
