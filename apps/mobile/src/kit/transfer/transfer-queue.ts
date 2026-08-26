// Member-facing readout of native-queue.ts's ledger (#711), one place so
// screens cannot disagree. FAILS CLOSED: unreadable → zeroed + readable:false.

import { authHeader } from "../../lib/gateway";
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
