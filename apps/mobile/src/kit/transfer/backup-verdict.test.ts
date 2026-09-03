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
    expect(
      backupVerdict(
        queue({ pending: 1000, failures: [{ lastError: "413 too large" }] })
      )
    ).toBe("failing");
  });

  it("an unreadable ledger is its OWN verdict, never 'complete'", () => {
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
    const copy = backupVerdictCopy(queue({ failures: [{ lastError: "" }] }));
    expect(copy.detail).toContain("no reason was recorded");
  });

  it("every verdict names an icon the mobile resolver actually knows", () => {
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
