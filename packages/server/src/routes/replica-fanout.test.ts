// The MECHANISM of the shared replica projection (#883 C2); the cost it buys is
// proven by `tests/scale/replica-sse-fanout.scale.test.ts`.

import { describe, expect, test } from "vitest";

import {
  bootstrapVault,
  currentReplicaLogState,
  notifyReplicaCommit,
  openVaultDb,
} from "@centraid/vault";

import {
  PROJECTION_MEMO_MAX_ENTRIES,
  PROJECTION_MEMO_TTL_MS,
  ReplicaProjectionHub,
  replicaProjectionHub,
} from "./replica-fanout.js";

function vault(): ReturnType<typeof openVaultDb> {
  const db = openVaultDb();
  void db.blobTransfers.close();
  bootstrapVault(db, { ownerName: "Priya" });
  return db;
}

const ACCESS = { canWrite: true, rememberDevice: false } as const;
const CURSOR = { epoch: "", seq: 0 };

// Count prepared statements on the handle across one window.
function countStatements(
  db: ReturnType<typeof openVaultDb>,
  work: () => void
): number {
  const original = db.vault.prepare.bind(db.vault);
  let statements = 0;
  Object.defineProperty(db.vault, "prepare", {
    configurable: true,
    value: ((sql: string) => {
      statements += 1;
      return original(sql);
    }) as typeof db.vault.prepare,
  });
  try {
    work();
  } finally {
    Object.defineProperty(db.vault, "prepare", {
      configurable: true,
      value: original,
    });
  }
  return statements;
}

describe("replica projection hub", () => {
  test("subscribers at one cursor share ONE projection per commit", () => {
    const db = vault();
    const epoch = currentReplicaLogState(db.vault).epoch;
    const since = { ...CURSOR, epoch };
    const hub = new ReplicaProjectionHub(db.vault);
    hub.subscribe(() => undefined);

    const first = countStatements(db, () => {
      hub.project(ACCESS, since, 100);
    });
    // Sixteen more askers in the SAME generation must cost nothing.
    const rest = countStatements(db, () => {
      for (let index = 0; index < 16; index += 1)
        hub.project(ACCESS, since, 100);
    });
    expect(first).toBeGreaterThan(0);
    expect(rest).toBe(0);
    db.close();
  });

  test("a commit raises the generation and drops the memo", () => {
    const db = vault();
    const epoch = currentReplicaLogState(db.vault).epoch;
    const since = { ...CURSOR, epoch };
    const hub = new ReplicaProjectionHub(db.vault);
    let woke = 0;
    const release = hub.subscribe(() => {
      woke += 1;
    });
    const beforePage = hub.project(ACCESS, since, 100);
    const before = hub.currentGeneration();

    notifyReplicaCommit(db.vault);
    expect(hub.currentGeneration()).toBe(before + 1);
    expect(woke).toBe(1);
    expect(hub.project(ACCESS, since, 100)).not.toBe(beforePage);

    release();
    notifyReplicaCommit(db.vault);
    expect(woke).toBe(1);
    expect(hub.subscriberCount()).toBe(0);
    db.close();
  });

  test("an answer never outlives its TTL, even with no commit", () => {
    const db = vault();
    const epoch = currentReplicaLogState(db.vault).epoch;
    const since = { ...CURSOR, epoch };
    let now = 1_000;
    const hub = new ReplicaProjectionHub(db.vault, () => now);
    hub.subscribe(() => undefined);
    const beforeExpiry = hub.project(ACCESS, since, 100);
    expect(hub.project(ACCESS, since, 100)).toBe(beforeExpiry);
    // Only the CLOCK moved — a grant whose `expires_at` elapses in silence is
    // this case, and it must not be served stale.
    now += PROJECTION_MEMO_TTL_MS;
    expect(hub.project(ACCESS, since, 100)).not.toBe(beforeExpiry);
    db.close();
  });

  test("a different authorization is a different answer, never a shared one", () => {
    const db = vault();
    const epoch = currentReplicaLogState(db.vault).epoch;
    const since = { ...CURSOR, epoch };
    const hub = new ReplicaProjectionHub(db.vault);
    hub.subscribe(() => undefined);
    const first = hub.project(ACCESS, since, 100);
    for (const other of [
      { ...ACCESS, canWrite: false },
      { ...ACCESS, rememberDevice: true },
      { ...ACCESS, appId: "notes" },
    ]) {
      expect(
        hub.project(other, since, 100),
        `${JSON.stringify(other)} must not read another caller's page`
      ).not.toBe(first);
    }
    expect(hub.project(ACCESS, { ...since, seq: 1 }, 100)).not.toBe(first);
    expect(hub.project(ACCESS, since, 99)).not.toBe(first);
    expect(hub.project(ACCESS, since, 100, { doorbellOnly: true })).not.toBe(
      first
    );
    db.close();
  });

  // `deviceId` is the one input that is NOT a different answer (#922 A4): the
  // projection is device-neutral, and an intent's outcome is layered on top of
  // the shared page per device. The per-device half of that contract — an
  // outcome only ever reaches the device that queued the intent — is owned by
  // `replica-routes.test.ts` ("device-scoped outcomes through the snapshot
  // cursor") and `replica-intent-route.test.ts`.
  test("identically-authorized devices share ONE projection per commit", () => {
    const db = vault();
    const epoch = currentReplicaLogState(db.vault).epoch;
    const since = { ...CURSOR, epoch };
    const hub = new ReplicaProjectionHub(db.vault);
    hub.subscribe(() => undefined);
    const first = hub.project({ ...ACCESS, deviceId: "device-1" }, since, 100);
    // Nine more household devices in the same generation: no second projection.
    expect(
      countStatements(db, () => {
        for (let index = 2; index <= 10; index += 1)
          hub.project({ ...ACCESS, deviceId: `device-${index}` }, since, 100);
      })
    ).toBe(0);
    // Nothing device-specific may be baked into the shared page: unresolved
    // intent entries are what the per-device layer resolves.
    expect(first.batch.outcomes).toBeUndefined();
    expect(first.intentEntries).toStrictEqual([]);
    db.close();
  });

  test("a fleet of divergent readers cannot grow the memo without bound", () => {
    const db = vault();
    const since = { ...CURSOR, epoch: currentReplicaLogState(db.vault).epoch };
    const hub = new ReplicaProjectionHub(db.vault);
    hub.subscribe(() => undefined);
    // Distinct page shapes, not cursors: a cursor past the watermark is a
    // rebootstrap, a different question than eviction.
    const first = hub.project(ACCESS, since, 1);
    let last: ReturnType<typeof hub.project> | undefined;
    for (let limit = 2; limit <= PROJECTION_MEMO_MAX_ENTRIES + 20; limit += 1) {
      last = hub.project(ACCESS, since, limit);
    }
    expect(hub.project(ACCESS, since, 1)).not.toBe(first);
    expect(hub.project(ACCESS, since, PROJECTION_MEMO_MAX_ENTRIES + 20)).toBe(
      last
    );
    db.close();
  });

  test("one hub per vault handle, and it does not outlive the handle", () => {
    const first = vault();
    const second = vault();
    expect(replicaProjectionHub(first.vault)).toBe(
      replicaProjectionHub(first.vault)
    );
    expect(replicaProjectionHub(first.vault)).not.toBe(
      replicaProjectionHub(second.vault)
    );
    first.close();
    second.close();
  });
});
