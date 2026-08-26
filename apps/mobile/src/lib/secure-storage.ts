// Secure storage adapter for sensitive keys (#468).
// Secrets (link ticket/secret, gateway token, device keys) live in
// expo-secure-store. Non-secret prefs stay on AsyncStorage via Store.

import * as SecureStore from "expo-secure-store";

const PREFIX = "centraid.v1.";

// Sync cache so call sites that already use Store.get can stay synchronous
// after hydrateSecure().
const cache = new Map<string, string>();

/** Drop every decrypted credential from JS memory when the app locks. */
export function clearSecureCache(): void {
  cache.clear();
}

function storageKey(key: string): string {
  return PREFIX + key;
}

export function getSecure(key: string, fallback = ""): string {
  return cache.has(key) ? (cache.get(key) as string) : fallback;
}

export async function hydrateSecure(
  key: string,
  fallback = ""
): Promise<string> {
  const raw = await SecureStore.getItemAsync(storageKey(key));
  if (raw !== null) {
    cache.set(key, raw);
    return raw;
  }
  cache.set(key, fallback);
  return fallback;
}

export async function setSecure(key: string, value: string): Promise<void> {
  if (value === "") {
    await SecureStore.deleteItemAsync(storageKey(key));
  } else {
    await SecureStore.setItemAsync(storageKey(key), value);
  }
  cache.set(key, value);
}
