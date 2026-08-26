// The one subscription every Tally surface makes.
//
// `tally-store.ts` holds the read plane; this is how a component reads it.
// `useSyncExternalStore` rather than a context provider on purpose: the store
// is PROCESS memory shared by fifteen routes, and a provider would let a
// remount somewhere in the stack hand a fresh subtree a payload the member has
// already navigated away from.
//
// The spine read is the FRAME's, not a screen's: `TallyScreen.tsx` wraps every
// surface, so the dashboard read runs once however deep the member is in the
// stack. It is idempotent — it asks the vault what it owes and is owed, which
// is a fact about the vault rather than a session — so a second Tally screen
// pushed onto the stack costs one extra read and disturbs nothing.

import { useEffect, useSyncExternalStore } from "react";

import { openTally, readTallyVault, subscribeTallyVault } from "./tally-store";
import type { TallyVaultState } from "./tally-store";

export function useTallyVault(): TallyVaultState {
  return useSyncExternalStore(
    subscribeTallyVault,
    readTallyVault,
    readTallyVault
  );
}

/** The frame's own effect: the spine read on arrival, and nothing else. */
export function useTallySpine(): void {
  useEffect(() => {
    void openTally();
  }, []);
}
