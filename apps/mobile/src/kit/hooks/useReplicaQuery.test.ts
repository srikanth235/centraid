import { describe, expect, test } from "vitest";

import {
  combineReplicaQueryStates,
  replicaBootstrapActive,
  replicaQueryConnection,
  replicaQueryLoading,
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
    // #880 W2.2. The apps do not need a sixth connection value to learn about
    // transfer rules — they need to know the rows may be behind, which is
    // exactly what `offline` already tells them. The reason is the status
    // bar's sentence.
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
  // #880 W2.4. An app killed mid-backfill and relaunched offline renders the
  // rows it has. Dropping `coverage` on the floor let that truncated library
  // present itself as the whole thing — against docs/mobile-offline.md, where
  // a partial preview is readable and searchable but is labeled partial.
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

describe(replicaBootstrapActive, () => {
  test("a first-page preview is an active walk, an absent list is not", () => {
    expect(replicaBootstrapActive(undefined)).toBe(false);
    expect(replicaBootstrapActive([])).toBe(false);
    expect(
      replicaBootstrapActive([
        {
          vaultId: "home",
          vaultLabel: "Home",
          phase: "first-page",
          pages: 1,
        },
      ])
    ).toBe(true);
  });
});

describe(replicaQueryLoading, () => {
  test("treats a progressive first-page preview as loading, not an empty vault", () => {
    expect(
      replicaQueryLoading({
        connection: replicaQueryConnection({
          ready: true,
          hasSession: true,
          reachability: "current",
        }),
        bootstrapActive: true,
        hasSession: true,
        loading: false,
      })
    ).toBe(true);
  });

  test("drops the preview-as-loading once the walk retires and a read settled", () => {
    expect(
      replicaQueryLoading({
        connection: replicaQueryConnection({
          ready: true,
          hasSession: true,
          reachability: "current",
        }),
        bootstrapActive: false,
        hasSession: true,
        loading: false,
      })
    ).toBe(false);
  });
});
