// Secure storage adapter for sensitive keys (issue #468 J4).
// Secrets (link ticket/secret, gateway token, device keys) live in
// expo-secure-store. Non-secret prefs stay on AsyncStorage via Store.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const PREFIX = 'centraid.v1.';

// Sync cache so call sites that already use Store.get can stay synchronous
// after hydrateSecure().
const cache = new Map<string, string>();

function storageKey(key: string): string {
  return PREFIX + key;
}

export function getSecure(key: string, fallback = ''): string {
  return cache.has(key) ? (cache.get(key) as string) : fallback;
}

export async function hydrateSecure(key: string, fallback = ''): Promise<string> {
  try {
    const raw = await SecureStore.getItemAsync(storageKey(key));
    if (raw != null) {
      cache.set(key, raw);
      return raw;
    }
    // One-shot migrate from legacy AsyncStorage (pre-#468 J4).
    const legacy = await AsyncStorage.getItem(storageKey(key));
    if (legacy != null) {
      let value = legacy;
      try {
        value = JSON.parse(legacy) as string;
        if (typeof value !== 'string') value = legacy;
      } catch {
        value = legacy;
      }
      await SecureStore.setItemAsync(storageKey(key), value);
      await AsyncStorage.removeItem(storageKey(key)).catch(() => undefined);
      cache.set(key, value);
      return value;
    }
    cache.set(key, fallback);
    return fallback;
  } catch {
    cache.set(key, fallback);
    return fallback;
  }
}

export async function setSecure(key: string, value: string): Promise<void> {
  cache.set(key, value);
  try {
    if (value === '') {
      await SecureStore.deleteItemAsync(storageKey(key));
    } else {
      await SecureStore.setItemAsync(storageKey(key), value);
    }
  } catch {
    /* best-effort: cache still holds the value for this session */
  }
}
