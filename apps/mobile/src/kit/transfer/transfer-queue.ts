// Member-facing readout of native-queue.ts's ledger (#711), one place so
// screens cannot disagree. Totals are SQL. FAILS CLOSED: unreadable →
// zeroed + readable:false.

import { authHeader } from "../../lib/gateway";
import { foldPendingUploadGroups } from "../../lib/replica/storage-accounting";
import { UploadQueue } from "../../lib/upload/native-queue";
import { memberFacingError } from "../member-error";

export interface TransferQueueFailure {
  filename?: string;
  lastError: string;
}

export interface TransferQueueCounts {
  pending: number;
  pendingVideos: number;
  bytes: number;
  failures: TransferQueueFailure[];
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
    const totals = foldPendingUploadGroups(queue.pendingStorageGroups());
    return {
      pending: totals.total.itemCount,
      pendingVideos: totals.videoCount,
      bytes: totals.total.bytes,
      failures: readFailures(queue),
      readable: true,
    };
  } catch {
    return UNREADABLE;
  } finally {
    queue?.close();
  }
}

function readFailures(queue: UploadQueue): TransferQueueFailure[] {
  return queue.pending().flatMap((item) =>
    item.lastError
      ? [
          {
            ...(item.filename ? { filename: item.filename } : {}),
            lastError: memberFacingError(item.lastError),
          },
        ]
      : []
  );
}
