// The member's tile-size rung, shared by every Photos surface.
//
// A shelf is the same timeline under a filter (§5): same tile, same grouping,
// same tile-size control, same selection. So the rung cannot be per-screen
// state — Albums and Trash and Search must all be showing the size the member
// chose, and the stepper in one of them must move all of them.
//
// It is also a MEMBER preference, not a surface one (§4.2). This repo has no
// server-side member-preference plane, so it persists per device — the same
// reality the shipped web shell lives with for `bandOwner`.

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

/** Read the stored rung once per process, then keep it in memory. */
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

/** The rung, and the one way to change it. Every caller sees the same value. */
export function usePhotosRung(): [Rung, (next: Rung) => void] {
  hydrateRung();
  const rung = useSyncExternalStore(subscribe, getSnapshot);
  return [rung, useCallback((next: Rung) => setRung(next), [])];
}
