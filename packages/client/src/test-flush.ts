/**
 * Yield once so microtasks + a single macrotask (setTimeout 0) drain.
 * Prefer this over ad-hoc `new Promise((r) => setTimeout(r, 0))` in client tests
 * (#545 E3) so yields stay consistent and greppable.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
