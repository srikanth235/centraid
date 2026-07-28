/**
 * Apply work in input order, starting an item only after the preceding item
 * succeeds. Use this for ordered I/O boundaries; use `Promise.all` when the
 * work is independent.
 */
export function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>,
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve(),
  );
}

/**
 * Consume an asynchronous source in source order. The recursive form keeps
 * the ordering contract visible without putting a raw await in a loop.
 */
export async function applyAvailableInOrder<T>(
  values: AsyncIterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>,
): Promise<void> {
  const iterator = values[Symbol.asyncIterator]();

  async function applyNext(index: number): Promise<void> {
    const next = await iterator.next();
    if (next.done) return;
    await apply(next.value, index);
    return applyNext(index + 1);
  }

  try {
    await applyNext(0);
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}

/**
 * Map independent work with an explicit in-flight limit and stable result
 * order. Use `applyInOrder` instead when starting later work early is unsafe.
 */
export async function mapWithConcurrency<T, R>(
  values: Iterable<T>,
  limit: number,
  map: (value: T, index: number) => R | PromiseLike<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`mapWithConcurrency: limit must be a positive integer (received ${limit})`);
  }
  const input = Array.from(values);
  const results = Array.from<R>({ length: input.length });
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    const index = nextIndex++;
    if (index >= input.length) return;
    results[index] = await map(input[index]!, index);
    return runWorker();
  }

  await Promise.all(Array.from({ length: Math.min(limit, input.length) }, runWorker));
  return results;
}
