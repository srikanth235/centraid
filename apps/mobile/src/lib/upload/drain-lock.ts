let tail: Promise<unknown> = Promise.resolve();

export function withDrainLock<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => undefined);
  return result;
}
