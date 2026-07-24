// Device-local Appearance preference (issue #498) — the theme override the user
// picks in Settings → Appearance, folded over the OS colour scheme. Persisted in
// the same AsyncStorage `Store` as the rest of the mobile prefs and exposed as an
// external store so `useAppearance()` re-renders every themed surface the instant
// the preference changes (no reload).
//
// 'system' defers to the OS scheme (the default); 'light'/'dark' pin it. Both
// App.tsx (nav container + status bar) and `useTheme()` resolve through
// `resolveScheme` here so the whole app agrees on one scheme.

import { useSyncExternalStore } from 'react';
import { Store } from '../../storage';
import type { Scheme } from './resolve';

export type Appearance = 'system' | 'light' | 'dark';

const KEY = 'settings.appearance';
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function coerce(value: unknown): Appearance {
  return value === 'light' || value === 'dark' ? value : 'system';
}

// Synchronous read off the Store's in-memory cache — call `hydrateAppearance()`
// once at boot so this reflects the persisted choice from the first render.
export function getAppearance(): Appearance {
  return coerce(Store.get<Appearance>(KEY, 'system'));
}

export async function hydrateAppearance(): Promise<Appearance> {
  const value = coerce(await Store.hydrate<Appearance>(KEY, 'system'));
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
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

// Fold the preference over the live OS scheme into the single scheme the theme
// resolver consumes. 'system' → follow the OS; otherwise the pinned choice wins.
export function resolveScheme(
  pref: Appearance,
  osScheme: 'light' | 'dark' | null | undefined,
): Scheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return osScheme === 'dark' ? 'dark' : 'light';
}
