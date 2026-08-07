import { describe, expect, it } from "vitest";

import { replicaStatusRow, settledReachability } from "./replica-status";
import type { ReplicaReachability } from "./replica-status";

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
      ["current", "device-offline", "gateway-asleep", "syncing"] as const
    ).filter((state: ReplicaReachability) => replicaStatusRow(state).label);
    expect(speaking).toStrictEqual(["gateway-asleep", "syncing"]);
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
      "syncing",
    ] as const) {
      expect(replicaStatusRow(state).action ?? "").not.toContain("network");
    }
  });
});
