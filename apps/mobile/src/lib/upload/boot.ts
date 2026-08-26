// Upload-queue boot (#419.4). Drain on foreground; `begin` is keyed by
// content sha so a drain IS reconciliation. Never concurrent (`withDrainLock`);
// reconcile never starts or stops the Android FGS.

import { useEffect } from "react";
import { AppState } from "react-native";

import { Store } from "../../storage";
import { authHeader, resolveGatewayBase } from "../gateway";
import type { MobileReplicaSession } from "../replica/native-session";
import { withDrainLock } from "./drain-lock";
import { replaySettledUploadFollowups } from "./followup";
import { UploadForegroundService } from "./foreground-service";
import { LAST_SUCCESSFUL_SYNC_KEY, nativeUploadPolicy } from "./native-policy";
import { UploadQueue } from "./native-queue";
import { reconcileGate } from "./reconcile-gate";

export interface ReconcileSummary {
  settled: number;
  deduped: number;
  replayed: number;
  poisoned: number;
}

const EMPTY_RECONCILE: ReconcileSummary = {
  settled: 0,
  deduped: 0,
  replayed: 0,
  poisoned: 0,
};

async function reconcileOnce(
  session?: MobileReplicaSession
): Promise<ReconcileSummary> {
  let queue: UploadQueue | undefined;
  try {
    // Probe the queue before resolving the gateway: nothing pending ⇒ no tunnel.
    const probe = UploadQueue.open({
      gatewayBaseUrl: "http://127.0.0.1",
      headers: authHeader,
    });
    const hasTransfers = probe.pending().length > 0;
    const hasFollowups = probe.pendingFollowups().length > 0;
    probe.close();
    if (
      !reconcileGate({
        hasTransfers,
        hasFollowups,
        hasSession: Boolean(session),
      })
    ) {
      return EMPTY_RECONCILE;
    }

    const gatewayBaseUrl = await resolveGatewayBase();
    if (!gatewayBaseUrl) return EMPTY_RECONCILE;
    queue = UploadQueue.open({
      gatewayBaseUrl,
      headers: authHeader,
      policy: nativeUploadPolicy(),
      onProgress: ({ completed, total }) =>
        UploadForegroundService.update(completed, total),
    });
    // No FGS start here (F1): reconcile is an accelerator, not an owner.
    const drain = hasTransfers
      ? await queue.drain()
      : { settled: 0, failed: 0, deduped: 0, halted: false };
    const replay = session
      ? await replaySettledUploadFollowups(queue, session, gatewayBaseUrl)
      : { replayed: 0, poisoned: 0 };
    if (drain.settled + drain.deduped + replay.replayed > 0)
      Store.set(LAST_SUCCESSFUL_SYNC_KEY, new Date().toISOString());
    return {
      settled: drain.settled,
      deduped: drain.deduped,
      replayed: replay.replayed,
      poisoned: replay.poisoned,
    };
  } catch {
    // Drain never surfaces to the UI; unsettled items stay queued.
    return EMPTY_RECONCILE;
  } finally {
    queue?.close();
  }
}

export function drainUploadQueueNow(
  session?: MobileReplicaSession
): Promise<ReconcileSummary> {
  return withDrainLock(() => reconcileOnce(session));
}

/** Never touches the FGS. */
export async function drainUploadQueueInBackground(
  session?: MobileReplicaSession
): Promise<void> {
  await drainUploadQueueNow(session);
}

let reconcilePending = false;

function scheduleReconcile(session?: MobileReplicaSession): void {
  if (reconcilePending) return;
  reconcilePending = true;
  void withDrainLock(async () => {
    reconcilePending = false;
    await reconcileOnce(session);
  });
}

export function useUploadReconciliation(session?: MobileReplicaSession): void {
  useEffect(() => {
    scheduleReconcile(session);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") scheduleReconcile(session);
    });
    return () => subscription.remove();
  }, [session]);
}
