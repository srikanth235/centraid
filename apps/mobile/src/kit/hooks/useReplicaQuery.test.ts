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

  test("a sync the member's transfer rules paused reads as stale, not current", () => {
    expect(
      replicaQueryConnection({
        ready: true,
        hasSession: true,
        reachability: "sync-paused",
      })
    ).toBe("offline");
  });
});

describe("how much of the library a query is speaking for", () => {
  test("one partial entity keeps the combined screen partial", () => {
    expect(
      combineReplicaQueryStates([
        {
          rows: [],
          loading: false,
          connection: "offline",
          coverage: "complete",
          refresh: async () => undefined,
        },
        {
          rows: [],
          loading: false,
          connection: "offline",
          coverage: "partial",
          refresh: async () => undefined,
        },
      ]).coverage
    ).toBe("partial");
  });

  test("claims complete only when every part claims it", () => {
    expect(
      combineReplicaQueryStates([
        {
          rows: [],
          loading: false,
          connection: "current",
          coverage: "complete",
          refresh: async () => undefined,
        },
      ]).coverage
    ).toBe("complete");
  });

  test("says nothing when no part knows its coverage", () => {
    expect(
      combineReplicaQueryStates([
        {
          rows: [],
          loading: false,
          connection: "current",
          refresh: async () => undefined,
        },
      ]).coverage
    ).toBeUndefined();
  });
});
