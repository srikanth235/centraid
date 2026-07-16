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
import { UploadQueue } from './native-queue';

/** Serializes drains: a second foreground must not race the first. */
let inFlight: Promise<void> | null = null;

async function reconcileOnce(): Promise<void> {
  // Edge sealing needs a WebCrypto polyfill that RN does not ship. Until it is
  // installed at boot there is nothing this can usefully do, and probing here
  // keeps the failure at the seam instead of deep inside a drain.
  if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) return;

  let queue: UploadQueue | undefined;
  try {
    // Open the queue before resolving the gateway: with nothing pending there
    // is no reason to spin up the tunnel.
    const probe = UploadQueue.open({ gatewayBaseUrl: 'http://127.0.0.1', headers: authHeader });
    if (probe.pending().length === 0) {
      probe.close();
      return;
    }
    probe.close();

    const gatewayBaseUrl = await resolveGatewayBase();
    if (!gatewayBaseUrl) return;
    queue = UploadQueue.open({ gatewayBaseUrl, headers: authHeader });
    await queue.drain();
  } catch {
    // A drain never surfaces to the UI: every item it could not settle is
    // still durably queued, and the next foreground tries again.
  } finally {
    queue?.close();
  }
}

/** Drain on mount and on every return to the foreground. */
export function useUploadReconciliation(): void {
  useEffect(() => {
    const run = (): void => {
      if (inFlight) return;
      inFlight = reconcileOnce().finally(() => {
        inFlight = null;
      });
    };
    run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => subscription.remove();
  }, []);
}
