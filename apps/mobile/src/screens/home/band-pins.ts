// Persisted pin state for the mobile navigation band (issue #707 Phase 5, the
// Binding Layer). Pins are user data and must persist (the brief's State
// section), so this module owns the one persisted list, backed by the same
// AsyncStorage `Store` every other device-local preference uses. The pure
// shape/merge logic lives in ./band, which this module layers storage on top
// of — see that file for why: a Store import pulls in AsyncStorage, which
// pure unit tests should never have to mock just to check a list merge.

import { useSyncExternalStore } from "react";

import { Store } from "../../storage";
import { DEFAULT_PINS, MAX_PINS, sanitizePins } from "./band";

const KEY = "settings.bandPins";

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getPins(): string[] {
  return Store.get<string[]>(KEY, DEFAULT_PINS as string[]);
}

export async function hydratePins(): Promise<string[]> {
  const raw = await Store.hydrate<string[]>(KEY, DEFAULT_PINS as string[]);
  const clean = sanitizePins(raw);
  // Repair a corrupted/duplicated stored list once, rather than carrying the
  // mess forward on every read.
  if (clean.length !== raw.length || clean.some((id, i) => id !== raw[i])) {
    Store.set(KEY, clean);
  }
  return clean;
}

export function setPins(ids: readonly string[]): void {
  Store.set(KEY, sanitizePins(ids));
  emit();
}

/** Pin `id` (a no-op once `MAX_PINS` is already reached) or unpin it. */
export function togglePin(id: string, pinned: boolean): void {
  const current = getPins();
  if (pinned) {
    if (current.includes(id) || current.length >= MAX_PINS) return;
    setPins([...current, id]);
  } else {
    setPins(current.filter((existing) => existing !== id));
  }
}

export function isPinned(id: string): boolean {
  return getPins().includes(id);
}

export function subscribePins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePins(): string[] {
  return useSyncExternalStore(subscribePins, getPins, getPins);
}
