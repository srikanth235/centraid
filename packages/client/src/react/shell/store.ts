// Tiny localStorage-backed store with namespaced, JSON-encoded values. The
// renderer's client-local preferences (starred apps, home pins, appearance,
// per-view toggles) persist through here. A plain module — imported where
// needed rather than reached through a window global.

const PREFIX = 'centraid.v1.';

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
};
