// The one subscription every Locker surface makes.
//
// `locker-store.ts` holds the boundary; this is how a component reads it.
// `useSyncExternalStore` rather than a context provider on purpose: the store
// is PROCESS memory shared by ten routes, and a provider would let a remount
// somewhere in the stack hand a fresh subtree a session that the boundary
// thinks it ended.
//
// The mount effects are the frame's, not a screen's: `LockerScreen.tsx` wraps
// every surface, so the status read runs once and the AppState subscription
// exists once, however deep the member is in the stack.

import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { useReplica } from "../../kit/replica/ReplicaProvider";
import { coalesceWork } from "../../lib/coalesce";
import { attachLockerReadPlane } from "./locker-reads";
import {
  onLockerAppState,
  openLocker,
  readLockerVault,
  refreshLockerItems,
  subscribeLockerVault,
} from "./locker-store";
import type { LockerVaultState } from "./locker-store";

/**
 * Long enough to swallow one delta batch's invalidations, short enough that a
 * change made on another device still feels immediate. The same window
 * `useReplicaQuery` uses, for the same reason.
 */
const INVALIDATION_WINDOW_MS = 120;

export function useLockerVault(): LockerVaultState {
  return useSyncExternalStore(
    subscribeLockerVault,
    readLockerVault,
    readLockerVault
  );
}

/**
 * The frame's own effects. Called exactly once per mounted Locker frame: the
 * mounted read plane, the status read on arrival, and the hide → lock
 * subscription for as long as a Locker surface is on screen.
 *
 * The status read is idempotent by design — it asks the gateway whether a
 * passphrase exists, which is a fact about the vault rather than a session —
 * so a second Locker screen pushed onto the stack costs one extra read and
 * never disturbs an open session.
 *
 * The window itself is read from the replica now (`locker-reads.ts`), so a
 * change landing there has to reach the list: an RPC seat got that from
 * whoever called the read, a local seat gets it from the change stream, and
 * the burst a delta pull produces collapses into one re-read.
 */
export function useLockerBoundary(): void {
  const { session } = useReplica();
  useEffect(() => {
    attachLockerReadPlane(session);
    if (!session) return;
    const coalesced = coalesceWork(refreshLockerItems, INVALIDATION_WINDOW_MS);
    const unsubscribe = session.subscribe("locker", coalesced.signal);
    return () => {
      coalesced.cancel();
      unsubscribe();
      attachLockerReadPlane(undefined);
    };
  }, [session]);

  useEffect(() => {
    void openLocker();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      onLockerAppState(next);
    });
    return () => subscription.remove();
  }, []);
}
