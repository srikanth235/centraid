// The three dynamic states the Backup surface has to be able to say (#712),
// plus the fourth the fail-closed queue read forces. What is pinned here is
// which EVIDENCE produces which verdict — the whole reason the phone may claim
// "failing" where the web's Storage screen honestly may not.

import { describe, expect, it } from "vitest";

import { CUSTODY_BUCKETS } from "../storage/custody-durability";
import type {
  CustodyBucket,
  CustodyStatus,
} from "../storage/custody-durability";
import { backupVerdict, backupVerdictCopy } from "./backup-verdict";
import type { TransferQueueCounts } from "./transfer-queue";

/** A swept rollup with the named buckets filled and the rest at zero. */
const rollup = (
  counts: Partial<Record<CustodyBucket, number>>,
  computedAt: string | null = "2026-09-07T00:00:00Z"
): CustodyStatus => ({
  computedAt,
  uncounted: [],
  buckets: Object.fromEntries(
    CUSTODY_BUCKETS.map((bucket) => [
      bucket,
      { count: counts[bucket] ?? 0, bytes: (counts[bucket] ?? 0) * 1_000 },
    ])
  ) as CustodyStatus["buckets"],
});

const queue = (
  fields: Partial<TransferQueueCounts> = {}
): TransferQueueCounts => ({
  pending: 0,
  pendingVideos: 0,
  bytes: 0,
  failures: [],
  readable: true,
  ...fields,
});

describe(backupVerdict, () => {
  // #996 R7: an empty queue is this phone's claim, and "backed up" is the
  // gateway's answer. The two are different sentences and the phone can only
  // make the first, so `complete` needs both.
  it("an empty queue with a verified rollup is complete", () => {
    expect(backupVerdict(queue(), rollup({ replicated: 12 }))).toBe("complete");
  });

  it("an empty queue with NO rollup is unverified, never complete", () => {
    // Offline, or a gateway that would not answer. Reading it as complete puts
    // "Backup is complete" on screen on the strength of a claim nobody checked.
    expect(backupVerdict(queue())).toBe("unverified");
    expect(backupVerdict(queue(), null)).toBe("unverified");
    expect(backupVerdict(queue(), rollup({}, null))).toBe("unverified");
  });

  it("an empty queue over a gap at the gateway is failing", () => {
    // The phone sent everything it had and the bytes are in neither tier.
    expect(backupVerdict(queue(), rollup({ replicated: 4, missing: 1 }))).toBe(
      "failing"
    );
  });

  it("counts every state that means the gateway holds it as backed up", () => {
    // Four spellings of one fact. A member cannot act on the difference, and
    // R7 says they see two states.
    for (const bucket of [
      "replicated",
      "remote-only",
      "local-only",
      "pending-offsite",
    ] as const)
      expect(backupVerdict(queue(), rollup({ [bucket]: 3 }))).toBe("complete");
  });

  it("rows still waiting are pending, not a fault", () => {
    expect(backupVerdict(queue({ pending: 3, bytes: 900 }))).toBe("pending");
  });

  it("a refusal outranks a backlog", () => {
    // Severity, not size: a thousand rows merely waiting is bytes moving; one
    // row the device tried to send and was told no is the thing to say first.
    expect(
      backupVerdict(
        queue({ pending: 1000, failures: [{ lastError: "413 too large" }] })
      )
    ).toBe("failing");
  });

  it("an unreadable ledger is its OWN verdict, never 'complete'", () => {
    // `readTransferQueue` fails closed: the zeroes it returns are UNKNOWN, and
    // printing "Backup is complete" over them would tell a member their
    // photographs are safe on the strength of a failed read.
    expect(backupVerdict(queue({ readable: false }))).toBe("unreadable");
  });
});

describe(backupVerdictCopy, () => {
  it("failing says WHAT refused and HOW MANY are on one device", () => {
    const copy = backupVerdictCopy(
      queue({
        pending: 11,
        failures: [
          { filename: "IMG_1.HEIC", lastError: "gateway refused: 507" },
          { lastError: "gateway refused: 507" },
        ],
      })
    );
    expect(copy.title).toBe("2 transfers refused");
    // The transport's own words, not a paraphrase.
    expect(copy.detail).toContain("vault host refused: 507");
    expect(copy.detail).toContain("11 photographs are on this device only");
  });

  it("only failing takes the net ink", () => {
    expect(
      backupVerdictCopy(queue(), undefined, rollup({ replicated: 1 })).net
    ).toBe(false);
    expect(backupVerdictCopy(queue()).net).toBe(false);
    expect(backupVerdictCopy(queue({ pending: 2 })).net).toBe(false);
    expect(backupVerdictCopy(queue({ readable: false })).net).toBe(false);
    expect(
      backupVerdictCopy(queue({ failures: [{ lastError: "no" }] })).net
    ).toBe(true);
  });

  it("says one photograph in the singular", () => {
    const copy = backupVerdictCopy(
      queue({ pending: 1, failures: [{ lastError: "offline" }] })
    );
    expect(copy.detail).toContain("1 photograph is on this device only");
  });

  it("names a refusal even when the queue recorded no reason", () => {
    // A row that failed with no message is still a refusal; saying "no reason
    // was recorded" beats an empty clause that reads as a rendering bug.
    const copy = backupVerdictCopy(queue({ failures: [{ lastError: "" }] }));
    expect(copy.detail).toContain("no reason was recorded");
  });

  it("every verdict names an icon the mobile resolver actually knows", () => {
    // `icon-resolver.ts` throws on an unknown name: a hyphenated `check-circle`
    // is neither a registry name nor an alias, so the healthy state raises
    // rather than renders.
    const known = new Set([
      "CheckCircle",
      "cloud",
      "cloud-off",
      "alert-circle",
    ]);
    for (const counts of [
      queue(),
      queue({ pending: 1 }),
      queue({ failures: [{ lastError: "x" }] }),
      queue({ readable: false }),
    ]) {
      expect(known.has(backupVerdictCopy(counts).icon)).toBe(true);
    }
  });
});
