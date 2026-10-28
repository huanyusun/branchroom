export interface LatestGuard {
  /** 开始一次新请求，返回本次令牌。 */
  begin(): number;
  /** 该令牌是否仍是最新一次请求。 */
  isCurrent(token: number): boolean;
  /** 使所有进行中的请求失效（组件卸载或切换上下文时）。 */
  invalidate(): void;
}

/** 异步请求竞态防护：只有最后一次 begin 的结果允许落地（CHECK-07）。 */
export function createLatestGuard(): LatestGuard {
  let counter = 0;
  return {
    begin: () => {
      counter += 1;
      return counter;
    },
    isCurrent: (token) => token === counter,
    invalidate: () => {
      counter += 1;
    }
  };
}
