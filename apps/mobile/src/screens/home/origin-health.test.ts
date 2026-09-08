import { describe, expect, it } from "vitest";

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
          failures: [{ lastError: "gateway refused the upload" }],
          pending: 1,
        }),
      })
    ).toMatchObject({
      copy: "1 item only on this phone · uploads need attention",
      destination: "notifications",
      notificationDetail: "phone",
      notificationCause: "Upload failed · vault host refused the upload",
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
