// The three dynamic states the Backup surface has to be able to say (#712 P5),
// plus the fourth the fail-closed queue read forces. What is pinned here is
// which EVIDENCE produces which verdict — the whole reason the phone may claim
// "failing" where the web's Storage screen honestly may not.

import { describe, expect, it } from "vitest";

import { backupVerdict, backupVerdictCopy } from "./backup-verdict";
import type { TransferQueueCounts } from "./transfer-queue";

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
  it("an empty, readable queue is complete", () => {
    expect(backupVerdict(queue())).toBe("complete");
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
    // `icon-resolver.ts` throws on an unknown name, and the previous Backup
    // screen shipped `check-circle`, which is neither a registry name nor an
    // alias — so the healthy state raised rather than rendered.
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
