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
      // Intentionally empty.
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      // Intentionally empty.
    }
  },
  removeByPrefix(prefix: string): void {
    try {
      const full = PREFIX + prefix;
      for (const key of Object.keys(localStorage))
        if (key.startsWith(full)) localStorage.removeItem(key);
    } catch {
      // Intentionally empty.
    }
  },
};
