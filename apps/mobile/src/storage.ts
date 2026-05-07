// AsyncStorage-backed mirror of the desktop Store API.
// Same `centraid.v1.` namespace so a future shared core can switch backends
// without touching app code.

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'centraid.v1.';

// In-memory cache so app code can stay synchronous on the render path.
// Apps call `Store.hydrate(key, fallback)` once at mount, then use `get/set`.
const cache = new Map<string, unknown>();

export const Store = {
  get<T>(key: string, fallback: T): T {
    return cache.has(key) ? (cache.get(key) as T) : fallback;
  },
  async hydrate<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await AsyncStorage.getItem(PREFIX + key);
      const value = raw == null ? fallback : (JSON.parse(raw) as T);
      cache.set(key, value);
      return value;
    } catch {
      cache.set(key, fallback);
      return fallback;
    }
  },
  set<T>(key: string, value: T): void {
    cache.set(key, value);
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(value)).catch(() => {
      /* swallow */
    });
  },
};
