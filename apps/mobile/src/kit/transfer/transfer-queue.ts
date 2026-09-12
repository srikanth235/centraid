// Member-facing readout of native-queue.ts's ledger (#711), one place so
// screens cannot disagree. Totals are SQL. FAILS CLOSED: unreadable →
// zeroed + readable:false.

import { authHeader } from "../../lib/gateway";
import { foldPendingUploadGroups } from "../../lib/replica/storage-accounting";
import { UploadQueue } from "../../lib/upload/native-queue";
import type { UploadItem } from "../../lib/upload/store";

export interface TransferQueueFailure {
  /** Needed to act on it: the Retry below is addressed by item. */
  itemId: string;
  filename?: string;
  lastError: string;
  /**
   * TERMINAL: the item spent its attempts and will not try again on its own
   * (#1014, P7). Until this lane, such a row was in no list at all — the
   * failure surface read only rows still being retried, so an item that gave
   * up disappeared from Backup health entirely.
   */
  terminal: boolean;
}

export interface TransferQueueCounts {
  pending: number;
  pendingVideos: number;
  bytes: number;
  failures: TransferQueueFailure[];
  /**
   * Follow-ups quarantined after exhausting their replays (F4): bytes are
   * durable in the CAS and the canonical write never landed, so the vault has
   * the photograph's content and no row for it. Nothing surfaced this count
   * (#1014, P7) — `poisonedFollowupCount()` had no production caller.
   */
  poisonedFollowups: number;
  readable: boolean;
}

const UNREADABLE: TransferQueueCounts = {
  pending: 0,
  pendingVideos: 0,
  bytes: 0,
  failures: [],
  poisonedFollowups: 0,
  readable: false,
};

export function readTransferQueue(gatewayBase: string): TransferQueueCounts {
  let queue: UploadQueue | undefined;
  try {
    queue = UploadQueue.open({
      gatewayBaseUrl: gatewayBase,
      headers: authHeader,
    });
    const totals = foldPendingUploadGroups(queue.pendingStorageGroups());
    return {
      pending: totals.total.itemCount,
      pendingVideos: totals.videoCount,
      bytes: totals.total.bytes,
      failures: readFailures(queue),
      poisonedFollowups: queue.poisonedFollowupCount(),
      readable: true,
    };
  } catch {
    return UNREADABLE;
  } finally {
    queue?.close();
  }
}

/**
 * Every row whose last try failed: the ones that gave up FIRST, then the ones
 * still retrying.
 *
 * The retrying list is `retrying()`, not `pending()`: a row inside its backoff
 * window is hidden from the drain by design, and hiding it here as well would
 * make a refusal vanish from Backup health for minutes at a time.
 */
function readFailures(queue: UploadQueue): TransferQueueFailure[] {
  const failed = queue.failed().map((item) => describe(item, true));
  return [...failed, ...queue.retrying().map((item) => describe(item, false))];
}

function describe(item: UploadItem, terminal: boolean): TransferQueueFailure {
  return {
    itemId: item.itemId,
    ...(item.filename ? { filename: item.filename } : {}),
    lastError: item.lastError ?? "no reason was recorded",
    terminal,
  };
}

/**
 * Put a terminally failed transfer back in the queue with a fresh attempt
 * budget — the member's answer to the failure list above (#1014, P7).
 */
export function retryTransfer(gatewayBase: string, itemId: string): void {
  let queue: UploadQueue | undefined;
  try {
    queue = UploadQueue.open({
      gatewayBaseUrl: gatewayBase,
      headers: authHeader,
    });
    queue.retry(itemId);
  } catch {
    // Unreadable ledger: the list this acts on is already `readable: false`.
  } finally {
    queue?.close();
  }
}
