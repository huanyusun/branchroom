import { describe, expect, test } from 'vitest';
import { createLatestGuard } from '../../src/renderer/lib/latest-guard';

describe('createLatestGuard', () => {
  test('newest request wins', async () => {
    const guard = createLatestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  test('invalidate rejects every in-flight token', () => {
    const guard = createLatestGuard();
    const token = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(token)).toBe(false);
    const next = guard.begin();
    expect(guard.isCurrent(next)).toBe(true);
  });

  test('tokens are unique across calls', () => {
    const guard = createLatestGuard();
    expect(guard.begin()).not.toBe(guard.begin());
  });
});
