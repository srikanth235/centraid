// Boot wiring for the upload queue (#419 M0.4).
//
// Settlement reconciliation: on every foreground, re-drain. Because `begin` is
// keyed by content sha, a drain IS the reconciliation — an item whose bytes
// landed while the app was dead comes back `alreadyPresent` and settles
// without transferring anything. There is no separate reconcile path to keep
// in sync with the transfer path, which is the point.
//
// This imports native modules (op-sqlite, expo-file-system) and is therefore
// boot-only; nothing under test reaches it.

import { useEffect } from 'react';
import { AppState } from 'react-native';

import { authHeader, resolveGatewayBase } from '../gateway';
import type { NativeReplicaSession } from '../replica/native-session';
import { replaySettledUploadFollowups } from './followup';
import { UploadQueue } from './native-queue';
import { UploadForegroundService } from './foreground-service';
import { LAST_SUCCESSFUL_SYNC_KEY, nativeUploadPolicy } from './native-policy';
import { Store } from '../../storage';

/** Serializes drains: a second foreground must not race the first. */
let inFlight: Promise<void> | null = null;

async function reconcileOnce(session?: NativeReplicaSession): Promise<void> {
  let queue: UploadQueue | undefined;
  try {
    // Open the queue before resolving the gateway: with nothing pending there
    // is no reason to spin up the tunnel.
    const probe = UploadQueue.open({ gatewayBaseUrl: 'http://127.0.0.1', headers: authHeader });
    const hasTransfers = probe.pending().length > 0;
    const hasFollowups = probe.pendingFollowups().length > 0;
    if (!hasTransfers && (!session || !hasFollowups)) {
      probe.close();
      return;
    }
    probe.close();

    const gatewayBaseUrl = await resolveGatewayBase();
    if (!gatewayBaseUrl) return;
    queue = UploadQueue.open({
      gatewayBaseUrl,
      headers: authHeader,
      policy: nativeUploadPolicy(),
      onProgress: ({ completed, total }) => UploadForegroundService.update(completed, total),
    });
    if (hasTransfers) UploadForegroundService.start(queue.pending().length);
    const summary = hasTransfers
      ? await queue.drain()
      : { attempted: 0, settled: 0, deduped: 0, failed: 0 };
    const replayed = session
      ? await replaySettledUploadFollowups(queue, session, gatewayBaseUrl)
      : 0;
    if (summary.settled + summary.deduped + replayed > 0)
      Store.set(LAST_SUCCESSFUL_SYNC_KEY, new Date().toISOString());
  } catch {
    // A drain never surfaces to the UI: every item it could not settle is
    // still durably queued, and the next foreground tries again.
  } finally {
    queue?.close();
    UploadForegroundService.stop();
  }
}

/** Registered as an Android Headless JS task by index.ts. */
export async function drainUploadQueueInBackground(): Promise<void> {
  await reconcileOnce();
}

/** Drain on mount and on every return to the foreground. */
export function useUploadReconciliation(session?: NativeReplicaSession): void {
  useEffect(() => {
    const run = (): void => {
      if (inFlight) {
        void inFlight.finally(() => {
          if (AppState.currentState === 'active') run();
        });
        return;
      }
      inFlight = reconcileOnce(session).finally(() => {
        inFlight = null;
      });
    };
    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => subscription.remove();
  }, [session]);
}
