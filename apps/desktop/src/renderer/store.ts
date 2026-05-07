// Tiny localStorage-backed store with namespaced keys.
// Each app picks its own namespace; values are JSON-encoded.

(function () {
  const PREFIX = 'centraid.v1.';

  const Store = {
    get<T>(key: string, fallback: T): T {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        if (raw == null) {
          return fallback;
        }
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

  function todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
  function daysAgoKey(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function dayOfWeek(): number {
    return new Date().getDay();
  }
  function formatDate(
    d: string,
    opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', weekday: 'long' },
  ): string {
    return new Date(d).toLocaleDateString(undefined, opts);
  }
  function formatShort(d: string): string {
    return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  window.Store = Store;
  window.DateUtil = { dayOfWeek, daysAgoKey, formatDate, formatShort, todayKey };
})();
