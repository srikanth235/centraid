import type { Note } from "./types.ts";

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
