// Draft writes the editor must not lose: a library re-read never carries a
// body, and one trailing debounce must not eat another note's pending save.
import type { Note } from "./types.ts";

/** Keep bodies the editor already loaded (or typed) across a library window
 *  that only ships previews. A row that arrived with its own body wins. */
export function carryLoadedBodies(
  previous: readonly Note[],
  next: readonly Note[]
): Note[] {
  const kept = new Map<string, string>();
  for (const row of previous) {
    if (typeof row.body === "string") kept.set(row.note_id, row.body);
  }
  if (kept.size === 0) return next as Note[];
  return next.map((row) => {
    if (typeof row.body === "string") return row;
    const body = kept.get(row.note_id);
    return body === undefined ? row : { ...row, body };
  });
}

/**
 * Trailing debounce keyed by identity. A burst on one key still coalesces;
 * a different key flushes the previous burst immediately so a fast switch
 * cannot drop it. `flush` is the unmount / leave-the-surface path.
 */
export function coalesceByKey<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  keyOf: (...args: Args) => unknown,
  ms: number,
  merge?: (previous: Args, next: Args) => Args
): { run: (...args: Args) => void; flush: () => Promise<void> } {
  let timer = 0;
  let pending: Args | null = null;

  const fire = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    const args = pending;
    pending = null;
    if (!args) return;
    await fn(...args);
  };

  return {
    run: (...args: Args) => {
      if (pending && keyOf(...pending) !== keyOf(...args)) {
        void fire();
        pending = args;
      } else if (pending && merge) {
        pending = merge(pending, args);
      } else {
        pending = args;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        void fire();
      }, ms) as unknown as number;
    },
    flush: fire,
  };
}
