/**
 * Yield one macrotask turn so queued timers/microtasks can drain.
 * Prefer this over ad-hoc `new Promise((r) => setTimeout(r, 0))` in tests
 * (#545) so yields stay consistent and greppable.
 *
 * Named for what it actually does (a macrotask), not "microtasks" alone.
 */
export function flushMacrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
