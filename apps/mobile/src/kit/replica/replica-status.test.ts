import { describe, expect, it } from "vitest";

import type { AsyncStorageLike } from "../../lib/replica/native-change-feed";
import {
  attemptedReachability,
  dismissRevokedNotice,
  loadRevokedNotices,
  recordRevokedNotice,
  replicaCoverageRow,
  replicaStatusRow,
  revokedNoticeRow,
  settledReachability,
} from "./replica-status";
import type { ReplicaReachability } from "./replica-status";

function memoryStorage(): AsyncStorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => Promise.resolve(values.get(key) ?? null),
    setItem: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

describe("where a reachability pass lands", () => {
  it("never leaves the pass in flight", () => {
    for (const landed of [true, false]) {
      expect(settledReachability(landed)).not.toBe("syncing");
    }
  });

  it("reads a pull that never landed as a gateway that is not answering", () => {
    expect(settledReachability(false)).toBe("gateway-asleep");
    expect(replicaStatusRow(settledReachability(false)).action).toBe(
      "Wake help"
    );
  });

  it("reads a landed pull as current, and says nothing about it", () => {
    expect(settledReachability(true)).toBe("current");
    expect(replicaStatusRow(settledReachability(true)).label).toBeUndefined();
  });
});

describe("what the replica bar says", () => {
  it("says nothing when the replica is settled", () => {
    expect(replicaStatusRow("current")).toStrictEqual({ actionable: false });
  });

  it("says nothing when the phone is offline", () => {
    const row = replicaStatusRow("device-offline");
    expect(row.label, "offline is not an incident worth a row").toBeUndefined();
    expect(row.action, "there is nothing for a member to fix").toBeUndefined();
    expect(row.actionable).toBe(false);
  });

  it("speaks only for states a member can act on or is waiting for", () => {
    const speaking = (
      [
        "current",
        "device-offline",
        "gateway-asleep",
        "sync-paused",
        "syncing",
      ] as const
    ).filter((state: ReplicaReachability) => replicaStatusRow(state).label);
    expect(speaking).toStrictEqual([
      "gateway-asleep",
      "sync-paused",
      "syncing",
    ]);
  });

  it("marks only the asleep gateway as actionable", () => {
    expect(replicaStatusRow("gateway-asleep").actionable).toBe(true);
    expect(replicaStatusRow("syncing").actionable).toBe(false);
  });

  it("offers an action only where pull-to-refresh would not help", () => {
    expect(replicaStatusRow("gateway-asleep").action).toBe("Wake help");
    expect(replicaStatusRow("syncing").action).toBe("Sync now");
  });

  it("never asks a member to go check their network", () => {
    for (const state of [
      "current",
      "device-offline",
      "gateway-asleep",
      "sync-paused",
      "syncing",
    ] as const) {
      expect(replicaStatusRow(state).action ?? "").not.toContain("network");
    }
  });
});

describe("a sync the member's own rules paused", () => {
  it("is neither current nor a sleeping gateway", () => {
    expect(settledReachability(false, true)).toBe("sync-paused");
    expect(settledReachability(true, true)).toBe("sync-paused");
    expect(settledReachability(true)).toBe("current");
  });

  it("says what stopped it and stays out of the danger ink", () => {
    const row = replicaStatusRow("sync-paused");
    expect(row.label).toBe("Sync paused by transfer rules");
    expect(row.actionable).toBe(false);
    expect(row.action).toBeUndefined();
  });
});

describe("a library that is only partly here", () => {
  it("labels a partial replica even with no bootstrap running", () => {
    expect(
      replicaCoverageRow({ coverage: "partial", bootstrapping: false }).label
    ).toBe("Recent items ready; older history syncing");
  });

  it("stays silent for a complete replica, and for an unknown one", () => {
    expect(
      replicaCoverageRow({ coverage: "complete", bootstrapping: false })
    ).toStrictEqual({ actionable: false });
    expect(replicaCoverageRow({ bootstrapping: false }).label).toBeUndefined();
  });

  it("defers to a live bootstrap, which has the exact page count", () => {
    expect(
      replicaCoverageRow({ coverage: "partial", bootstrapping: true }).label
    ).toBeUndefined();
  });
});

describe("the trace a revoked scope leaves", () => {
  const notice = {
    vaultId: "family",
    label: "Family",
    at: "2026-08-27T09:00:00.000Z",
  };

  it("names the vault and how it left, and offers only dismissal", () => {
    expect(revokedNoticeRow(notice)).toStrictEqual({
      label: "No longer shared with you — Family was removed from this phone",
      action: "Dismiss",
    });
  });

  it("survives the relaunch after the purge, and clears on dismiss", async () => {
    const storage = memoryStorage();
    await recordRevokedNotice(storage, "gateway-1", notice);

    await expect(
      loadRevokedNotices(storage, "gateway-1")
    ).resolves.toStrictEqual([notice]);
    await expect(
      dismissRevokedNotice(storage, "gateway-1", "family")
    ).resolves.toStrictEqual([]);
    await expect(
      loadRevokedNotices(storage, "gateway-1")
    ).resolves.toStrictEqual([]);
    expect([...storage.values.keys()]).toStrictEqual([]);
  });

  it("keeps the first instant when the same revoked frame arrives twice", async () => {
    const storage = memoryStorage();
    await recordRevokedNotice(storage, "gateway-1", notice);
    const again = await recordRevokedNotice(storage, "gateway-1", {
      ...notice,
      at: "2026-08-27T10:00:00.000Z",
    });
    expect(again).toStrictEqual([notice]);
  });

  it("keeps each gateway's notices apart, and reads a corrupt list as none", async () => {
    const storage = memoryStorage();
    await recordRevokedNotice(storage, "gateway-1", notice);
    await expect(
      loadRevokedNotices(storage, "gateway-2")
    ).resolves.toStrictEqual([]);

    storage.values.set("centraid:replica-revoked:gateway-3", "{not json");
    await expect(
      loadRevokedNotices(storage, "gateway-3")
    ).resolves.toStrictEqual([]);
  });
});

describe("what a pass may claim before it has asked the gateway anything", () => {
  it("does not call an unreachable vault `syncing` just because a URL resolved", () => {
    expect(attemptedReachability(true, true, false)).toBe("gateway-asleep");
  });

  it("says it is trying when the last answer was a good one", () => {
    expect(attemptedReachability(true, true, true)).toBe("syncing");
  });

  it("blames the radio over the gateway when the device itself is off", () => {
    expect(attemptedReachability(false, true, true)).toBe("device-offline");
  });

  it("has no gateway to be syncing with when no base resolved", () => {
    expect(attemptedReachability(true, false, true)).toBe("gateway-asleep");
  });
});
