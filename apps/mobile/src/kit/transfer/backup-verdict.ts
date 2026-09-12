// WHAT "BACKED UP" MEANS, AND WHOSE ANSWER IT IS.
//
// Every verdict short of `complete` comes from the device's durable queue and
// nothing else (#712): a rollup cannot say a transfer was refused on this
// phone, and `readable: false` means UNKNOWN — never folded into `complete`.
//
// `complete` IS DIFFERENT, and #996 R7 is why. An empty queue says this phone
// has nothing left to send; it does not say the gateway HAS the bytes. Those
// are two claims, and the phone can only make the first. So `complete` now
// needs both: an empty, readable queue AND the gateway's own verified custody
// saying nothing is missing. A seat's presence claim is never by itself the
// durability answer.
//
// AN UNREAD ROLLUP IS NOT A REFUSAL. Offline, or a gateway that would not
// answer, leaves custody `undefined`/`null` — and the verdict is `unverified`,
// which says the queue is empty and this phone cannot yet prove the other
// half. Reading it as `complete` would put "Backup is complete" on screen on
// the strength of a claim nobody checked; reading it as `failing` would call a
// tunnel outage an integrity gap.

import { formatBytes } from "@centraid/design";

import type { CustodyStatus } from "../storage/custody-durability";
import { custodyDurability } from "../storage/custody-durability";
import type { TransferQueueCounts } from "./transfer-queue";

export type BackupVerdict =
  | "complete"
  | "unverified"
  | "pending"
  | "failing"
  | "unreadable";

export interface BackupVerdictCopy {
  verdict: BackupVerdict;
  title: string;
  detail: string;
  /** `--net` ink — `failing` only (§18). */
  net: boolean;
  icon: string;
}

export function backupVerdict(
  queue: TransferQueueCounts,
  /** `undefined` not read yet, `null` the read failed — both are UNVERIFIED. */
  custody?: CustodyStatus | null
): BackupVerdict {
  if (!queue.readable) return "unreadable";
  if (queue.failures.length > 0) return "failing";
  if (queue.pending > 0) return "pending";
  // The queue is empty. The other half of the claim is the gateway's.
  if (!custody || custody.computedAt === null) return "unverified";
  return custodyDurability(custody).notBackedUp.count > 0
    ? "failing"
    : "complete";
}

// `onOneDeviceCount`: photographs held only here — the actionable fact.
export function backupVerdictCopy(
  queue: TransferQueueCounts,
  onOneDeviceCount = queue.pending,
  custody?: CustodyStatus | null
): BackupVerdictCopy {
  const verdict = backupVerdict(queue, custody);
  if (verdict === "unreadable") {
    return {
      verdict,
      title: "The queue could not be read on this phone",
      detail: "Free up phone storage, then reopen this screen.",
      net: false,
      icon: "alert-circle",
    };
  }
  if (verdict === "unverified") {
    return {
      verdict,
      title: "Nothing left to send from this phone",
      detail:
        "Your vault has not confirmed it holds these yet — reconnect to check.",
      net: false,
      icon: "cloud",
    };
  }
  if (verdict === "failing" && queue.failures.length === 0) {
    // An empty queue and a gap at the gateway: the phone did its part and the
    // bytes are in neither tier, which is the one case a member must act on
    // somewhere other than this screen.
    const missing = custody ? custodyDurability(custody).notBackedUp.count : 0;
    return {
      verdict,
      title: `${missing} file${missing === 1 ? "" : "s"} missing at your vault`,
      detail:
        "This phone sent everything it had; the bytes are in neither tier.",
      net: true,
      icon: "cloud-off",
    };
  }
  if (verdict === "failing") {
    const refused = queue.failures.length;
    // `||`, not `??`: an empty message must fall through, or detail opens " · ".
    // The row is already the member's sentence (`transfer-failure.ts`).
    const first = queue.failures[0]?.lastError || "no reason was recorded";
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
    detail: "Your vault holds every one of these, verified.",
    net: false,
    // Registry name, not `check-circle`: the resolver throws on unknown keys.
    icon: "CheckCircle",
  };
}
