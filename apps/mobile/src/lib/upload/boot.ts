// Boot wiring for the upload queue (#419 M0.4).
//
// Settlement reconciliation: on every foreground, re-drain. Because `begin` is
// keyed by content sha, a drain IS the reconciliation — an item whose bytes
// landed while the app was dead comes back `alreadyPresent` and settles
// without transferring anything. There is no separate reconcile path to keep
// in sync with the transfer path, which is the point.
//
// Two invariants this file exists to keep (F1):
//   * A drain is NEVER concurrent with another drain. Every entry point here —
//     the foreground hook and the Android headless task — routes through the
//     shared `withDrainLock`, the same guard the producers use.
//   * Reconcile never starts (or stops) the Android foreground service. Only an
//     explicit producer owns that lifecycle; a background reconcile that spun
//     the service up would fight the producer that already owns it.
//
// This imports native modules (op-sqlite, expo-file-system) and is therefore
// boot-only; only the pure `reconcileGate` below is reached by tests.

import { useEffect } from 'react';
import { AppState } from 'react-native';

import { authHeader, resolveGatewayBase } from '../gateway';
import type { NativeReplicaSession } from '../replica/native-session';
import { withDrainLock } from './drain-lock';
import { replaySettledUploadFollowups } from './followup';
import { UploadQueue } from './native-queue';
import { UploadForegroundService } from './foreground-service';
import { LAST_SUCCESSFUL_SYNC_KEY, nativeUploadPolicy } from './native-policy';
import { reconcileGate } from './reconcile-gate';
import { Store } from '../../storage';

export { reconcileGate } from './reconcile-gate';

export interface ReconcileSummary {
  settled: number;
  deduped: number;
  replayed: number;
  /** Follow-ups quarantined this run — a health signal, not a hard failure. */
  poisoned: number;
}

const EMPTY_RECONCILE: ReconcileSummary = { settled: 0, deduped: 0, replayed: 0, poisoned: 0 };

async function reconcileOnce(session?: NativeReplicaSession): Promise<ReconcileSummary> {
  let queue: UploadQueue | undefined;
  try {
    // Open the queue before resolving the gateway: with nothing pending there
    // is no reason to spin up the tunnel.
    const probe = UploadQueue.open({ gatewayBaseUrl: 'http://127.0.0.1', headers: authHeader });
    const hasTransfers = probe.pending().length > 0;
    const hasFollowups = probe.pendingFollowups().length > 0;
    probe.close();
    if (!reconcileGate({ hasTransfers, hasFollowups, hasSession: Boolean(session) })) {
      return EMPTY_RECONCILE;
    }

    const gatewayBaseUrl = await resolveGatewayBase();
    if (!gatewayBaseUrl) return EMPTY_RECONCILE;
    queue = UploadQueue.open({
      gatewayBaseUrl,
      headers: authHeader,
      policy: nativeUploadPolicy(),
      onProgress: ({ completed, total }) => UploadForegroundService.update(completed, total),
    });
    // No foreground-service start here (F1): reconcile is an accelerator, not
    // an owner. The drain resumes across process death regardless.
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
    // A drain never surfaces to the UI: every item it could not settle is
    // still durably queued, and the next foreground tries again.
    return EMPTY_RECONCILE;
  } finally {
    queue?.close();
  }
}

/** Registered as an Android Headless JS task by index.ts. Never touches the FGS. */
export async function drainUploadQueueInBackground(): Promise<void> {
  await withDrainLock(() => reconcileOnce());
}

/** Coalesces repeated foreground events into at most one queued reconcile. */
let reconcilePending = false;

function scheduleReconcile(session?: NativeReplicaSession): void {
  if (reconcilePending) return;
  reconcilePending = true;
  void withDrainLock(async () => {
    reconcilePending = false;
    await reconcileOnce(session);
  });
}

/** Drain on mount and on every return to the foreground. */
export function useUploadReconciliation(session?: NativeReplicaSession): void {
  useEffect(() => {
    scheduleReconcile(session);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') scheduleReconcile(session);
    });
    return () => subscription.remove();
  }, [session]);
}
