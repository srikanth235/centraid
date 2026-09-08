import { memberFacingError } from "../../kit/member-error";
import type { CustodyStatus } from "../../kit/storage/custody-status";
import type { TransferQueueCounts } from "../../kit/transfer/transfer-queue";

export type SignalTone = "quiet" | "attention" | "urgent";
export type SignalDestination = "phone" | "notifications" | "backup";

export interface OriginHealthSignal {
  tone: SignalTone;
  copy: string;
  action?: string;
  destination?: SignalDestination;
  notificationDetail?: "phone" | "backup";
  notificationCause?: string;
}

export interface OriginHealthFacts {
  paired: boolean;
  online: boolean;
  queue: TransferQueueCounts;
  custody?: CustodyStatus | null;
}

function pendingCopy(queue: TransferQueueCounts): string {
  if (queue.pendingVideos > 0) {
    return `${queue.pendingVideos} video${queue.pendingVideos === 1 ? "" : "s"} only on this phone`;
  }
  return `${queue.pending} item${queue.pending === 1 ? "" : "s"} only on this phone`;
}

export function originHealthSignal(
  facts: OriginHealthFacts
): OriginHealthSignal {
  const { queue } = facts;
  if (!queue.readable) {
    return {
      tone: "attention",
      copy: "Upload status could not be read on this phone",
      action: "Open",
      destination: "phone",
    };
  }
  if (queue.failures.length > 0) {
    return {
      tone: "urgent",
      copy: `${pendingCopy(queue)} · uploads need attention`,
      action: "What to do",
      destination: "notifications",
      notificationDetail: "phone",
      notificationCause: `Upload failed · ${memberFacingError(queue.failures[0]?.lastError ?? "no reason was recorded")}`,
    };
  }
  if (!facts.online && queue.pending > 0) {
    return {
      tone: "urgent",
      copy: `Can't reach your vault · ${pendingCopy(queue).toLowerCase()}`,
      action: "What to do",
      destination: "notifications",
      notificationDetail: "phone",
      notificationCause: `Can't reach your vault · ${pendingCopy(queue).toLowerCase()}`,
    };
  }
  if (queue.pending > 0) {
    return {
      tone: "attention",
      copy: pendingCopy(queue),
      action: "Upload on Wi-Fi",
      destination: "phone",
    };
  }
  if (facts.paired && !facts.online) {
    return {
      tone: "attention",
      copy: "Can't reach your vault · nothing is waiting on this phone",
      action: "What to do",
      destination: "notifications",
      notificationDetail: "phone",
      notificationCause:
        "Can't reach your vault · nothing is waiting to upload",
    };
  }

  const unsafeCopies = facts.custody
    ? facts.custody.buckets["local-only"].count +
      facts.custody.buckets.missing.count
    : 0;
  if (unsafeCopies > 0) {
    return {
      tone: "attention",
      copy: `${unsafeCopies} vault item${unsafeCopies === 1 ? " has" : "s have"} no verified backup`,
      action: "Review",
      destination: "backup",
    };
  }
  if (!facts.paired) {
    return { tone: "quiet", copy: "On this phone · pair a vault when ready" };
  }
  return {
    tone: "quiet",
    copy:
      facts.custody?.computedAt && facts.custody.uncounted.length === 0
        ? "Everything's uploaded · vault backup verified"
        : "Everything's uploaded",
  };
}
