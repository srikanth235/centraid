export function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

export async function applyAvailableInOrder<T>(
  values: AsyncIterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
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

export async function mapWithConcurrency<T, R>(
  values: Iterable<T>,
  limit: number,
  map: (value: T, index: number) => R | PromiseLike<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(
      `mapWithConcurrency: limit must be a positive integer (received ${limit})`
    );
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

  await Promise.all(
    Array.from({ length: Math.min(limit, input.length) }, runWorker)
  );
  return results;
}
