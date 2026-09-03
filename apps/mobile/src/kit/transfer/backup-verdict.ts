import { formatBytes } from "@centraid/design";

import { memberFacingError } from "../member-error";
import type { TransferQueueCounts } from "./transfer-queue";

export type BackupVerdict = "complete" | "pending" | "failing" | "unreadable";

export interface BackupVerdictCopy {
  verdict: BackupVerdict;
  title: string;
  detail: string;
  net: boolean;
  icon: string;
}

export function backupVerdict(queue: TransferQueueCounts): BackupVerdict {
  if (!queue.readable) return "unreadable";
  if (queue.failures.length > 0) return "failing";
  return queue.pending > 0 ? "pending" : "complete";
}

export function backupVerdictCopy(
  queue: TransferQueueCounts,
  onOneDeviceCount = queue.pending
): BackupVerdictCopy {
  const verdict = backupVerdict(queue);
  if (verdict === "unreadable") {
    return {
      verdict,
      title: "The queue could not be read on this phone",
      detail: "Free up phone storage, then reopen this screen.",
      net: false,
      icon: "alert-circle",
    };
  }
  if (verdict === "failing") {
    const refused = queue.failures.length;
    const first = memberFacingError(
      queue.failures[0]?.lastError || "no reason was recorded"
    );
    return {
      verdict,
      title: `${refused} transfer${refused === 1 ? "" : "s"} refused`,
      detail: `${first} · ${onOneDeviceCount} photograph${
        onOneDeviceCount === 1 ? " is" : "s are"
      } on this device only.`,
      net: true,
      icon: "cloud-off",
    };
  }
  if (verdict === "pending") {
    return {
      verdict,
      title: `${queue.pending} pending`,
      detail: `${formatBytes(queue.bytes)} remaining.`,
      net: false,
      icon: "cloud",
    };
  }
  return {
    verdict,
    title: "Backup is complete",
    detail: "The durable queue is empty.",
    net: false,
    icon: "CheckCircle",
  };
}
