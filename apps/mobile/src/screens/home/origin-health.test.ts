import { describe, expect, it } from "vitest";

import {
  CUSTODY_BUCKETS,
  custodyDurability,
} from "../../kit/storage/custody-durability";
import type {
  CustodyBucket,
  CustodyStatus,
  CustodyTotals,
} from "../../kit/storage/custody-durability";
import type { TransferQueueCounts } from "../../kit/transfer/transfer-queue";
import { originHealthSignal } from "./origin-health";

function queue(
  overrides: Partial<TransferQueueCounts> = {}
): TransferQueueCounts {
  return {
    bytes: 0,
    failures: [],
    pending: 0,
    pendingVideos: 0,
    poisonedFollowups: 0,
    readable: true,
    ...overrides,
  };
}

describe(originHealthSignal, () => {
  it("is quiet when the phone has uploaded everything", () => {
    expect(
      originHealthSignal({ online: true, paired: true, queue: queue() })
    ).toStrictEqual({ copy: "Everything's uploaded", tone: "quiet" });
  });

  it("promotes only-copy videos to attention", () => {
    expect(
      originHealthSignal({
        online: true,
        paired: true,
        queue: queue({ pending: 2, pendingVideos: 2 }),
      })
    ).toMatchObject({
      action: "Upload on Wi-Fi",
      copy: "2 videos only on this phone",
      destination: "phone",
      tone: "attention",
    });
  });

  it("turns unreachable only-copy content urgent", () => {
    expect(
      originHealthSignal({
        online: false,
        paired: true,
        queue: queue({ pending: 2, pendingVideos: 2 }),
      })
    ).toMatchObject({
      copy: "Can't reach your vault · 2 videos only on this phone",
      destination: "notifications",
      notificationDetail: "phone",
      notificationCause: "Can't reach your vault · 2 videos only on this phone",
      tone: "urgent",
    });
  });

  it("carries a refused upload toward Notifications and phone detail", () => {
    expect(
      originHealthSignal({
        online: true,
        paired: true,
        queue: queue({
          failures: [
            {
              itemId: "item-1",
              lastError: "Your vault is out of space",
              terminal: true,
            },
          ],
          pending: 1,
        }),
      })
    ).toMatchObject({
      copy: "1 item only on this phone · uploads need attention",
      destination: "notifications",
      notificationDetail: "phone",
      notificationCause: "Upload failed · Your vault is out of space",
      tone: "urgent",
    });
  });

  it("does not call an unreadable queue healthy", () => {
    expect(
      originHealthSignal({
        online: true,
        paired: true,
        queue: queue({ readable: false }),
      }).tone
    ).toBe("attention");
  });

  it("never claims the vault is caught up while it cannot be reached", () => {
    const signal = originHealthSignal({
      online: false,
      paired: true,
      queue: queue(),
    });
    expect(signal.copy).toContain("Can't reach your vault");
    expect(signal.copy).not.toContain("uploaded");
    expect(signal.tone).toBe("attention");
  });

  it("says nothing about a vault on a phone that has never paired with one", () => {
    expect(
      originHealthSignal({ online: false, paired: false, queue: queue() }).copy
    ).toBe("On this phone · pair a vault when ready");
  });
});

// #1015 B13 — Home and Backup health each folded the custody rollup their own
// way, so the same `8` was "items with no verified backup" on one screen and
// "backed up" on the other. There is one arithmetic now: `custodyDurability`,
// the #996 R7 ruling that four of the five custody states all mean the
// gateway's CAS holds the sha.
function custody(
  buckets: Partial<Record<CustodyBucket, CustodyTotals>> = {},
  computedAt: string | null = "2026-09-10T09:00:00.000Z"
): CustodyStatus {
  const zero = { bytes: 0, count: 0 };
  return {
    buckets: Object.fromEntries(
      CUSTODY_BUCKETS.map((name) => [name, buckets[name] ?? zero])
    ) as Record<CustodyBucket, CustodyTotals>,
    computedAt,
    uncounted: [],
  };
}

describe("Home's custody claim is Backup health's own", () => {
  it("does not call a photograph the gateway's disk holds an unbacked one", () => {
    const status = custody({ "local-only": { bytes: 15_000_000, count: 8 } });
    // The gateway HAS these; Backup health counts them under Backed up.
    expect(custodyDurability(status).notBackedUp.count).toBe(0);
    expect(
      originHealthSignal({
        custody: status,
        online: true,
        paired: true,
        queue: queue(),
      })
    ).toStrictEqual({
      copy: "Everything's uploaded · vault backup verified",
      tone: "quiet",
    });
  });

  it("raises exactly the count Backup health calls missing, and no other", () => {
    const status = custody({
      "local-only": { bytes: 15_000_000, count: 8 },
      missing: { bytes: 2000, count: 3 },
    });
    expect(custodyDurability(status).notBackedUp.count).toBe(3);
    expect(
      originHealthSignal({
        custody: status,
        online: true,
        paired: true,
        queue: queue(),
      })
    ).toStrictEqual({
      action: "Review",
      copy: "3 vault items have no verified backup",
      destination: "backup",
      tone: "attention",
    });
  });

  it("does not claim the vault verified anything before a sweep has run", () => {
    expect(
      originHealthSignal({
        custody: custody({}, null),
        online: true,
        paired: true,
        queue: queue(),
      })
    ).toStrictEqual({ copy: "Everything's uploaded", tone: "quiet" });
  });
});
