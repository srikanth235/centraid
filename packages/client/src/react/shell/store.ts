// Tiny localStorage-backed store with namespaced, JSON-encoded values. The
// renderer's client-local preferences (starred apps, home pins, appearance,
// per-view toggles) persist through here. A plain module — imported where
// needed rather than reached through a window global.

const PREFIX = "centraid.v1.";

export const Store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw == null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* swallow quota errors — non-essential */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* a store that cannot forget is worse than one that cannot remember,
         but there is nothing useful to do about a throwing localStorage */
    }
  },
  /** Every key under a namespace — the bulk-forget the query cache needs when a
   *  vault change makes a whole generation of answers wrong. */
  removeByPrefix(prefix: string): void {
    try {
      const full = PREFIX + prefix;
      for (const key of Object.keys(localStorage))
        if (key.startsWith(full)) localStorage.removeItem(key);
    } catch {
      /* see above */
    }
  },
};
