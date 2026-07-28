/**
 * Run each callback only after the preceding callback has fulfilled.
 *
 * This deliberately does not begin later work early: use it when the order is
 * part of the behavior (for example, applying a journal or draining queued
 * UI work). Independent work should use `Promise.all` instead.
 */
export function forEachSequentially<T>(
  values: Iterable<T>,
  visit: (value: T, index: number) => void | PromiseLike<void>,
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => visit(value, index++)),
    Promise.resolve(),
  );
}
