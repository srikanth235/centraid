// Appearance pref (#498), persisted in `Store`, exposed as an external store.

import { useSyncExternalStore } from "react";

import { Store } from "../../storage";
import type { Scheme } from "./resolve";

export type Appearance = "system" | "light" | "dark";

const KEY = "settings.appearance";
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function coerce(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

// Sync read; call `hydrateAppearance()` once at boot.
export function getAppearance(): Appearance {
  return coerce(Store.get<Appearance>(KEY, "system"));
}

export async function hydrateAppearance(): Promise<Appearance> {
  const value = coerce(await Store.hydrate<Appearance>(KEY, "system"));
  emit();
  return value;
}

export function setAppearance(value: Appearance): void {
  Store.set(KEY, value);
  emit();
}

export function subscribeAppearance(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    subscribeAppearance,
    getAppearance,
    getAppearance
  );
}

// 'system' follows the OS; RN 0.86 'unspecified' (like null) means none.
export function resolveScheme(
  pref: Appearance,
  osScheme: "light" | "dark" | "unspecified" | null | undefined
): Scheme {
  if (pref === "light" || pref === "dark") return pref;
  return osScheme === "dark" ? "dark" : "light";
}
