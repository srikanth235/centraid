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
