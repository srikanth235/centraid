// THE FRAME'S VIEW OF THE DURABLE QUEUE (#711).
//
// `lib/upload/native-queue.ts` owns the sqlite ledger. This module owns the
// READOUT of it — the counts a member is shown, in one place, so Photos' backup
// screen and (next) Docs' and the frame's own settings cannot disagree about
// how many things are waiting.
//
// A one-shot read of an external system: the handle is opened and closed around
// it so no screen ever holds a sqlite connection across a render. Lives outside
// any component for exactly that reason.
//
// FAILS CLOSED, and says so. If the queue cannot be opened — low disk, a purge
// mid-read — the counts come back zeroed and `readable: false`, never a
// fabricated total. docs/mobile-offline.md is explicit that low disk pauses
// sync and preserves the last readable projection: the ledger is intact, only
// this view of it is not, and a screen that quietly printed `0 pending` over a
// full queue would be telling the member their photographs are safe.

import { authHeader } from "../../lib/gateway";
import { UploadQueue } from "../../lib/upload/native-queue";
import { memberFacingError } from "../member-error";

export interface TransferQueueFailure {
  filename?: string;
  lastError: string;
}

export interface TransferQueueCounts {
  /** Rows the queue has not settled. Exact — never "some", never a spinner. */
  pending: number;
  /** Pending rows whose recorded MIME type is a video. */
  pendingVideos: number;
  /** Plaintext bytes those rows represent. */
  bytes: number;
  /** Rows carrying a last error, so the screen can state each one inline. */
  failures: TransferQueueFailure[];
  /** False when the ledger could not be read at all; the counts are then zero
   *  because they are UNKNOWN, and the caller must say so rather than reassure. */
  readable: boolean;
}

const UNREADABLE: TransferQueueCounts = {
  pending: 0,
  pendingVideos: 0,
  bytes: 0,
  failures: [],
  readable: false,
};

export function readTransferQueue(gatewayBase: string): TransferQueueCounts {
  let queue: UploadQueue | undefined;
  try {
    queue = UploadQueue.open({
      gatewayBaseUrl: gatewayBase,
      headers: authHeader,
    });
    const pending = queue.pending();
    return {
      pending: pending.length,
      pendingVideos: pending.filter((item) =>
        item.mediaType?.startsWith("video/")
      ).length,
      bytes: pending.reduce((sum, item) => sum + item.plaintextSize, 0),
      failures: pending.flatMap((item) =>
        item.lastError
          ? [
              {
                ...(item.filename ? { filename: item.filename } : {}),
                lastError: memberFacingError(item.lastError),
              },
            ]
          : []
      ),
      readable: true,
    };
  } catch {
    return UNREADABLE;
  } finally {
    queue?.close();
  }
}
