/**
 * Per-app serialization for the `app-upload` handler.
 *
 * Two desktops publishing the same app simultaneously would race on
 * `data.sqlite` (migrations) and `current.json` (atomic rename). The lock
 * chains uploads-for-the-same-appId through one promise; different appIds
 * run in parallel. Map entries self-clear on settle so it can't grow
 * unbounded.
 */
export function makeAppUploadLocks(): <T>(appId: string, fn: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<unknown>>();
  return <T>(appId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(appId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    locks.set(appId, next);
    next.finally(() => {
      if (locks.get(appId) === next) locks.delete(appId);
    });
    return next;
  };
}
