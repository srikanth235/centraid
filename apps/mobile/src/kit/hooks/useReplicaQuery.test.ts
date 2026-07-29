import { describe, expect, test } from "vitest";

import {
  combineReplicaQueryStates,
  replicaQueryConnection,
} from "./replica-query-state";

describe("replica query connection state", () => {
  test("never represents a missing session as an empty/current query", () => {
    expect(replicaQueryConnection({ ready: true, hasSession: false })).toBe(
      "unavailable"
    );
  });

  test("distinguishes boot, offline cache, active sync, and current data", () => {
    expect(replicaQueryConnection({ ready: false, hasSession: false })).toBe(
      "loading"
    );
    expect(
      replicaQueryConnection({
        ready: true,
        hasSession: true,
        reachability: "device-offline",
      })
    ).toBe("offline");
    expect(
      replicaQueryConnection({
        ready: true,
        hasSession: true,
        reachability: "syncing",
      })
    ).toBe("syncing");
    expect(
      replicaQueryConnection({
        ready: true,
        hasSession: true,
        reachability: "current",
      })
    ).toBe("current");
  });

  test("combines every per-entity error instead of hiding secondary failures", () => {
    const state = combineReplicaQueryStates([
      {
        rows: [],
        loading: false,
        connection: "current",
        refresh: async () => undefined,
      },
      {
        rows: [],
        loading: false,
        connection: "offline",
        error: "Attendees could not be read",
        lastSyncedAt: "2026-07-29T10:00:00.000Z",
        refresh: async () => undefined,
      },
    ]);
    expect(state).toMatchObject({
      connection: "offline",
      error: "Attendees could not be read",
      lastSyncedAt: "2026-07-29T10:00:00.000Z",
    });
  });
});
