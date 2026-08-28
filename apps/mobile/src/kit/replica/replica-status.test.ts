import { describe, expect, it } from "vitest";

import type { AsyncStorageLike } from "../../lib/replica/native-change-feed";
import {
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
    // THE REGRESSION THIS PINS. `syncing` is optimistic — set before the pull
    // is attempted — so a pass with no failure branch left "Syncing recent
    // changes…" on twenty screens forever, permanent AND untrue. Observed by
    // killing the gateway under a running app.
    for (const landed of [true, false]) {
      expect(settledReachability(landed)).not.toBe("syncing");
    }
  });

  it("reads a pull that never landed as a gateway that is not answering", () => {
    // Not `device-offline`: we asked and got nothing back, which is about the
    // gateway, not the radio. `gateway-asleep` is also the only state that
    // offers an action, and waking the gateway is the thing that would help.
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

  // THE ONE THIS MODULE EXISTS FOR. This bar mounts on roughly twenty screens,
  // so a row here is twenty rows. Offline changes nothing any of them can show
  // — the bytes are already on the phone — so it earns none of them.
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
    // Drives the dot's ink. A red dot beside "Syncing recent changes…" reads as
    // a failure to sync, which is the opposite of what is happening.
    expect(replicaStatusRow("gateway-asleep").actionable).toBe(true);
    expect(replicaStatusRow("syncing").actionable).toBe(false);
  });

  it("offers an action only where pull-to-refresh would not help", () => {
    // Every screen carrying this bar scrolls, so the gesture already exists. A
    // sleeping gateway needs waking, not pulling; a sync in flight can be
    // hurried. Nothing else gets a button.
    expect(replicaStatusRow("gateway-asleep").action).toBe("Wake help");
    expect(replicaStatusRow("syncing").action).toBe("Sync now");
  });

  it("never asks a member to go check their network", () => {
    // "Check network" sent someone to fix something on behalf of an app that
    // did not need fixing. If it comes back, it comes back deliberately.
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
  // THE REGRESSION THIS PINS (#880 W2.2). A metered/battery refusal came back
  // from the facade as "nothing threw", settled as `current`, and the bar then
  // said nothing at all — the screen claiming freshness it never fetched.
  it("is neither current nor a sleeping gateway", () => {
    expect(settledReachability(false, true)).toBe("sync-paused");
    // Even a "landed" boolean cannot outrank a pull that never happened.
    expect(settledReachability(true, true)).toBe("sync-paused");
    expect(settledReachability(true)).toBe("current");
  });

  it("says what stopped it and stays out of the danger ink", () => {
    const row = replicaStatusRow("sync-paused");
    expect(row.label).toBe("Sync paused by transfer rules");
    // The member set these rules; a red dot would read as a fault they hit.
    expect(row.actionable).toBe(false);
    // And no button: pulling again re-hits the same rule.
    expect(row.action).toBeUndefined();
  });
});

describe("a library that is only partly here", () => {
  // #880 W2.4: an app killed mid-backfill and relaunched offline has no live
  // bootstrap to report pages, so coverage is the only thing left that knows.
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
    // THE POINT (#880 W4.4). The purge takes the rows, the cursor and the
    // mount, so nothing else on the phone can afterwards say where a vault
    // went. This record is written before the purge and outlives the process.
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
