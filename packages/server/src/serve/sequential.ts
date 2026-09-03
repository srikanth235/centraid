export function forEachSequentially<T>(
  values: Iterable<T>,
  visit: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => visit(value, index++)),
    Promise.resolve()
  );
}

export function findSequentially<T>(
  values: Iterable<T>,
  predicate: (value: T, index: number) => boolean | PromiseLike<boolean>
): Promise<T | undefined> {
  const entries = Array.from(values);
  const visit = (index: number): Promise<T | undefined> => {
    if (index >= entries.length) return Promise.resolve(undefined);
    const value = entries[index] as T;
    return Promise.resolve(predicate(value, index)).then((matches) =>
      matches ? value : visit(index + 1)
    );
  };
  return visit(0);
}
