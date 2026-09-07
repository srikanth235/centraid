// THE PHONE'S BYTE POLICY, ON THE SEAT'S RULE (#996 R7/R25).
//
// The candidate list is a STRUCTURAL exclusion, not a filter at the end that
// gets forgotten (#883): what may not be evicted never enters it. What may not
// be evicted is `seatByteEvictable`'s answer and not this module's opinion —
// the fetch path and the eviction path are written by different callers and
// must not each re-derive the rule, which is exactly why wave 2 put it in one
// function.
//
// THREE THINGS SURVIVE THE LRU, and none of them is a heuristic:
//
//   - A PIN. "Keep offline" is an instruction; a cache that evicts what
//     someone asked it to keep is a surprise, not a cache.
//   - A CAPTURE. What this phone took may be the only copy anywhere until the
//     gateway verifies it, and the LRU is not the place to gamble on that.
//   - BYTES A QUEUED INTENT NEEDS (R25). The gateway executes an
//     attachment-dependent intent only once those hashes are uploaded and
//     verified; evicting them makes the member's own queued work unsendable
//     from the one device that has it.

import { seatByteEvictable } from "@centraid/client/replica/native";
import type { SeatBlobKind } from "@centraid/client/replica/native";

export interface StoredContentEntry {
  key: string;
  bytes: number;
  /** Epoch ms. */
  lastUsedAt: number;
  pinned: boolean;
  /**
   * `preview` or `original`. A `thumb` is a replicated ROW and never a cache
   * entry; `seatByteEvictable` throws rather than answering, because a caller
   * that put one here has confused a row with a file.
   */
  kind: SeatBlobKind;
  /** This phone took the photograph or made the recording. */
  capturedHere?: boolean;
  /** A queued intent names this hash as a prerequisite (R25). */
  referencedByPendingIntent?: boolean;
}

export interface ContentEvictionPlan {
  evict: string[];
  keptBytes: number;
  /** Bytes the LRU may not touch, whichever of the three reasons held them. */
  pinnedBytes: number;
  overBudgetBy: number;
}

export function planContentEviction(
  entries: readonly StoredContentEntry[],
  budgetBytes: number
): ContentEvictionPlan {
  let pinned = 0;
  let total = 0;
  const candidates: StoredContentEntry[] = [];
  for (const entry of entries) {
    total += entry.bytes;
    if (seatByteEvictable(entry)) candidates.push(entry);
    else pinned += entry.bytes;
  }
  const evict: string[] = [];
  if (total > budgetBytes) {
    const ordered = [...candidates].sort(
      (left, right) =>
        left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key)
    );
    for (const entry of ordered) {
      if (total <= budgetBytes) break;
      total -= entry.bytes;
      evict.push(entry.key);
    }
  }
  return {
    evict,
    keptBytes: total,
    pinnedBytes: pinned,
    overBudgetBy: Math.max(0, total - budgetBytes),
  };
}
