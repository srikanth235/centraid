import { useCallback, useSyncExternalStore } from "react";

import { Store } from "../../storage";
import { DEFAULT_RUNG, RUNG_KEY, clampRung } from "./photos-rungs";
import type { Rung } from "./photos-rungs";

let current: Rung = DEFAULT_RUNG;
let hydrated = false;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function hydrateRung(): void {
  if (hydrated) return;
  hydrated = true;
  void Store.hydrate(RUNG_KEY, DEFAULT_RUNG).then((stored) => {
    const next = clampRung(stored);
    if (next === current) return;
    current = next;
    publish();
  });
}

export function setRung(next: Rung): void {
  if (next === current) return;
  current = next;
  Store.set(RUNG_KEY, next);
  publish();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = (): Rung => current;

export function usePhotosRung(): [Rung, (next: Rung) => void] {
  hydrateRung();
  const rung = useSyncExternalStore(subscribe, getSnapshot);
  return [rung, useCallback((next: Rung) => setRung(next), [])];
}
