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

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { coalesceWork } from "../../lib/coalesce";
import { attachTallyReadPlane } from "./tally-reads";
import {
  openTally,
  readTallyVault,
  refreshTally,
  subscribeTallyVault,
} from "./tally-store";
import type { TallyVaultState } from "./tally-store";

/**
 * Long enough to swallow one delta batch's invalidations, short enough that a
 * change made on another device still feels immediate. The same window
 * `useReplicaQuery` uses, for the same reason.
 */
const INVALIDATION_WINDOW_MS = 120;

export function useTallyVault(): TallyVaultState {
  return useSyncExternalStore(
    subscribeTallyVault,
    readTallyVault,
    readTallyVault
  );
}

/**
 * The frame's own effect: attach the mounted read plane, take the spine read,
 * and re-read when the vault changes underneath.
 *
 * Tally's seven queries run ON THIS DEVICE now (`tally-reads.ts`), so the
 * store needs the replica session the provider holds, and a change landing in
 * the replica has to reach the ledger — an RPC seat got that from whoever
 * called `refreshTally`, a local seat gets it from the change stream. The
 * burst a delta pull produces collapses into one re-read, exactly as
 * `useReplicaQuery` collapses it.
 */
export function useTallySpine(): void {
  const { session } = useReplica();
  useEffect(() => {
    attachTallyReadPlane(session);
    if (!session) return;
    void openTally();
    const coalesced = coalesceWork(refreshTally, INVALIDATION_WINDOW_MS);
    const unsubscribe = session.subscribe("tally", coalesced.signal);
    return () => {
      coalesced.cancel();
      unsubscribe();
      attachTallyReadPlane(undefined);
    };
  }, [session]);
}
