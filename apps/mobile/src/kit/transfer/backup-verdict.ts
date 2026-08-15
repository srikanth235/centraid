// THE BACKUP VERDICT — complete, pending, or FAILING (issue #712, P5).
//
// The design handoff (§12) gives the Backup surface three dynamic states, and
// the third is the one nothing in this repo could say before: **failing**. The
// web Storage screen states plainly why it has no such verdict
// (`packages/blueprints/apps/photos/storage-model.ts`): the custody rollup
// carries no error, no attempt count and no next-run time, so a browser tab
// claiming "the last three runs were refused" would be inventing it.
//
// The PHONE can say it, from a different source. `readTransferQueue` reads the
// device's own durable upload ledger, and every row it returns with a
// `lastError` is a transfer this device actually attempted and this device
// actually saw refused. That is evidence, not inference — which is exactly why
// the verdict is computed here from the queue and never from the rollup.
//
// FAIL-CLOSED IS ITS OWN ANSWER. `readTransferQueue` returns zeroes with
// `readable: false` when the ledger cannot be opened at all. Those zeroes are
// UNKNOWN, not "nothing pending", so `unreadable` is a fourth verdict rather
// than being folded into `complete` — a screen that printed "Backup is
// complete" over an unreadable queue would be telling a member their
// photographs are safe on the strength of a failed read.
//
// Pure and react-native-free so every branch is asserted directly
// (`backup-verdict.test.ts`); `screens/BackupHealth.tsx` renders it.

import { formatBytes } from "@centraid/design";

import { memberFacingError } from "../member-error";
import type { TransferQueueCounts } from "./transfer-queue";

export type BackupVerdict = "complete" | "pending" | "failing" | "unreadable";

export interface BackupVerdictCopy {
  verdict: BackupVerdict;
  /** The headline, already carrying its own number where it has one. */
  title: string;
  /** One line under it. Never a reassurance the evidence cannot support. */
  detail: string;
  /**
   * Drawn in `--net` — `failing` only. `pending` is not a fault (bytes are
   * moving) and `unreadable` is a gap in this view, not in the ledger, so
   * neither takes the net ink (§18).
   */
  net: boolean;
  /** Semantic icon key, resolved by `kit/components/icon-resolver`. */
  icon: string;
}

/**
 * Severity order, worst first: a refusal outranks a backlog, because only one
 * of them means the device has tried and been told no.
 */
export function backupVerdict(queue: TransferQueueCounts): BackupVerdict {
  if (!queue.readable) return "unreadable";
  if (queue.failures.length > 0) return "failing";
  return queue.pending > 0 ? "pending" : "complete";
}

/**
 * The verdict, with its numbers.
 *
 * @param onOneDeviceCount How many photographs this phone still holds the only
 *   copy of — the rows the durable queue has not settled. The failing branch
 *   names it because "three transfers were refused" is a fact about the
 *   network and "eleven photographs are on one device" is the fact about the
 *   member's photographs, and the second is the one they can act on.
 */
export function backupVerdictCopy(
  queue: TransferQueueCounts,
  onOneDeviceCount = queue.pending
): BackupVerdictCopy {
  const verdict = backupVerdict(queue);
  if (verdict === "unreadable") {
    return {
      verdict,
      // The ledger is intact; only this view of it failed. Saying "healthy"
      // here would be a reassurance we cannot support.
      title: "The queue could not be read on this phone",
      detail:
        "Nothing queued has been lost. Free up phone storage and reopen this screen.",
      net: false,
      icon: "alert-circle",
    };
  }
  if (verdict === "failing") {
    const refused = queue.failures.length;
    // WHAT refused, in the transport's own words, not a paraphrase. Only the
    // first is quoted in the verdict line; every failing row is listed in full
    // below it on the screen, so nothing is hidden by the summary.
    // An EMPTY message counts as no message: `?? ` alone would leave a leading
    // " · " that reads as a rendering bug rather than as a missing reason.
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
    // The registry's own name, not a hyphenated alias: `icon-resolver.ts`
    // carries no `check-circle` entry and throws on an unknown name, which is
    // exactly what the old Backup screen did on its healthy branch.
    icon: "CheckCircle",
  };
}
