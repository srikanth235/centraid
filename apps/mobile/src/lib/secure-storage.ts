import * as SecureStore from "expo-secure-store";

const PREFIX = "centraid.v1.";

const cache = new Map<string, string>();

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
