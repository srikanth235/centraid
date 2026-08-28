import { describe, expect, test, vi } from "vitest";

import type { ReplicaStatus } from "@centraid/client/replica/native";

import type {
  MountedReplicaScope,
  MultiVaultReplicaReader,
  PlacementIntent,
  PlacementRecord,
} from "./multi-vault-reader";
import { MultiVaultReplicaSession } from "./multi-vault-session";
import type { MultiVaultSessionOptions } from "./multi-vault-session";
import type { NativeReplicaSession } from "./native-session";

function scope(
  vaultId: string,
  overrides: Partial<MountedReplicaScope> = {}
): MountedReplicaScope {
  return {
    vaultId,
    label: `${vaultId} vault`,
    canWrite: true,
    databaseName: vaultId,
    ...overrides,
  };
}

interface FakeSession {
  session: NativeReplicaSession;
  pullNow: ReturnType<typeof vi.fn>;
  purge: ReturnType<typeof vi.fn>;
}

function fakeSession(input: {
  pulls?: boolean;
  coverage?: "partial" | "complete";
  onPurge?: () => void;
  /** Rows this scope's outbox is holding, in the native session's own shape. */
  pending?: unknown[];
  storageFull?: boolean;
}): FakeSession {
  const pullNow = vi.fn<() => Promise<boolean>>(() =>
    Promise.resolve(input.pulls ?? true)
  );
  const purge = vi.fn<() => Promise<void>>(() => {
    input.onPurge?.();
    return Promise.resolve();
  });
  const parked = { storageFull: input.storageFull ?? false };
  const resume = (): void => {
    parked.storageFull = false;
  };
  const session = {
    pullNow,
    purge,
    resumeAfterStorageFull: resume,
    get storageFull(): boolean {
      return parked.storageFull;
    },
    pendingChanges: () => Promise.resolve(input.pending ?? []),
    status: () =>
      Promise.resolve({
        mode: "native",
        cursor: { epoch: "1", seq: 4 },
        schemaEpoch: "1",
        ...(input.coverage ? { coverage: input.coverage } : {}),
      } satisfies ReplicaStatus),
    close: () => Promise.resolve(),
  } as unknown as NativeReplicaSession;
  return { session, pullNow, purge };
}

function fakeReader(): MultiVaultReplicaReader & {
  revoked: string[];
  records: Map<string, PlacementRecord>;
} {
  const records = new Map<string, PlacementRecord>();
  const revoked: string[] = [];
  return {
    records,
    revoked,
    revokeScope: (vaultId: string) => {
      revoked.push(vaultId);
    },
    close: () => undefined,
    enqueuePlacement: (input: PlacementIntent) => {
      const record: PlacementRecord = {
        ...input,
        status: "queued",
        createdAt: "2026-08-27T09:00:00.000Z",
        updatedAt: "2026-08-27T09:00:00.000Z",
      };
      records.set(record.linkToken, record);
      return record;
    },
    placements: () => [...records.values()],
    placement: (linkToken: string) => records.get(linkToken),
    updatePlacement: (record: PlacementRecord) => {
      records.set(record.linkToken, record);
    },
  } as unknown as MultiVaultReplicaReader & {
    revoked: string[];
    records: Map<string, PlacementRecord>;
  };
}

function build(
  overrides: Partial<MultiVaultSessionOptions> & {
    sessions: Map<string, NativeReplicaSession>;
    scopes: readonly MountedReplicaScope[];
  }
): {
  facade: MultiVaultReplicaSession;
  reader: ReturnType<typeof fakeReader>;
} {
  const reader = overrides.reader ?? fakeReader();
  const facade = new MultiVaultReplicaSession({
    reader,
    focusedVaultId: () => undefined,
    createId: () => "link-1",
    sendPlacement: () => Promise.reject(new Error("no placement transport")),
    isConnected: () => true,
    ...overrides,
  });
  return { facade, reader: reader as ReturnType<typeof fakeReader> };
}

describe("what a multi-vault pull actually obtained", () => {
  test("a pull the transfer rules refused is reported as blocked, not landed", async () => {
    // THE REGRESSION THIS PINS (#880 W2.2). The facade returned `Promise<void>`,
    // so the provider's `.then(() => true)` read a refusal as a landed pull:
    // reachability settled to `current`, the status bar said nothing, and the
    // screen asserted a freshness the phone never obtained.
    const home = fakeSession({ pulls: true });
    const pulled: string[] = [];
    const { facade } = build({
      sessions: new Map([["home", home.session]]),
      scopes: [scope("home")],
      isNetworkWorkAllowed: () => Promise.resolve(false),
      onScopePulled: (vaultId) => pulled.push(vaultId),
    });

    const outcome = await facade.pullScopes();

    expect(outcome).toStrictEqual({
      pulled: [],
      stalled: ["home"],
      policyBlocked: true,
    });
    // Nothing was asked of the gateway, and nothing may stamp freshness:
    // docs/mobile-offline.md — freshness advances only after a successful pull.
    expect(home.pullNow).not.toHaveBeenCalled();
    expect(pulled).toStrictEqual([]);
  });

  test("reports per scope which sources landed and which stalled", async () => {
    const home = fakeSession({ pulls: true });
    const family = fakeSession({ pulls: false });
    const pulled: string[] = [];
    const { facade } = build({
      sessions: new Map([
        ["home", home.session],
        ["family", family.session],
      ]),
      scopes: [scope("home"), scope("family")],
      onScopePulled: (vaultId) => pulled.push(vaultId),
    });

    const outcome = await facade.pullScopes();

    expect(outcome.pulled).toStrictEqual(["home"]);
    expect(outcome.stalled).toStrictEqual(["family"]);
    expect(outcome.policyBlocked).toBe(false);
    // A stalled source keeps its old stamp; only `home` may claim freshness.
    expect(pulled).toStrictEqual(["home"]);
  });

  test("keeps the boolean `pullNow` the shared session surface declares", async () => {
    const landed = build({
      sessions: new Map([["home", fakeSession({ pulls: true }).session]]),
      scopes: [scope("home")],
    });
    const blocked = build({
      sessions: new Map([["home", fakeSession({ pulls: true }).session]]),
      scopes: [scope("home")],
      isNetworkWorkAllowed: () => Promise.resolve(false),
    });

    await expect(landed.facade.pullNow()).resolves.toBe(true);
    await expect(blocked.facade.pullNow()).resolves.toBe(false);
  });
});

describe("what the mounted plane says about its own coverage", () => {
  test("one partial source keeps the whole plane partial", async () => {
    const { facade } = build({
      sessions: new Map([
        ["home", fakeSession({ coverage: "complete" }).session],
        ["family", fakeSession({ coverage: "partial" }).session],
      ]),
      scopes: [scope("home"), scope("family")],
    });

    await expect(facade.status()).resolves.toStrictEqual({
      coverage: "partial",
      scopes: [
        { vaultId: "home", coverage: "complete" },
        { vaultId: "family", coverage: "partial" },
      ],
    });
  });

  test("claims complete only when every source claims it", async () => {
    const { facade } = build({
      sessions: new Map([
        ["home", fakeSession({ coverage: "complete" }).session],
        ["family", fakeSession({ coverage: "complete" }).session],
      ]),
      scopes: [scope("home"), scope("family")],
    });

    await expect(facade.status()).resolves.toMatchObject({
      coverage: "complete",
    });
  });

  test("a source that never answered coverage is partial, not complete", async () => {
    const { facade } = build({
      sessions: new Map([["home", fakeSession({}).session]]),
      scopes: [scope("home")],
    });

    await expect(facade.status()).resolves.toMatchObject({
      coverage: "partial",
      scopes: [{ vaultId: "home", coverage: "partial" }],
    });
  });
});

describe("what a revoked scope leaves behind", () => {
  test("detaches, purges, and tells the member before the label is erased", async () => {
    const order: string[] = [];
    const family = fakeSession({ onPurge: () => order.push("purge") });
    const noticed: MountedReplicaScope[] = [];
    const { facade, reader } = build({
      sessions: new Map([
        ["home", fakeSession({}).session],
        ["family", family.session],
      ]),
      scopes: [scope("home"), scope("family")],
      onScopeRevoked: (revokedScope) => {
        order.push("notice");
        noticed.push(revokedScope);
      },
    });

    await facade.revokeScope("family");

    expect(reader.revoked).toStrictEqual(["family"]);
    expect(facade.scopes().map((entry) => entry.vaultId)).toStrictEqual([
      "home",
    ]);
    // The notice carries the label the purge is about to take with it.
    expect(noticed.map((entry) => entry.label)).toStrictEqual(["family vault"]);
    expect(order).toStrictEqual(["notice", "purge"]);
  });

  // #880 W3.5. The purge empties the tables in place and keeps the handle open,
  // so before this the file stayed at full size forever for a vault the phone
  // may never see again — invisible to every per-vault card, since the scope it
  // belonged to was gone.
  test("reclaims the revoked scope's replica file, and only that one", async () => {
    const order: string[] = [];
    const family = fakeSession({ onPurge: () => order.push("purge") });
    const reclaimed: string[] = [];
    const { facade } = build({
      sessions: new Map([
        ["home", fakeSession({}).session],
        ["family", family.session],
      ]),
      scopes: [
        scope("home", { databaseName: "/replica/home.sqlite3" }),
        scope("family", { databaseName: "/replica/family.sqlite3" }),
      ],
      reclaimRevokedReplica: (revokedScope) => {
        order.push("reclaim");
        reclaimed.push(revokedScope.databaseName);
      },
    });

    await facade.revokeScope("family");

    expect(reclaimed).toStrictEqual(["/replica/family.sqlite3"]);
    // Deleting before the purge would race a live writer holding the handle.
    expect(order).toStrictEqual(["purge", "reclaim"]);
  });

  test("a scope the four-vault cap merely unmounted keeps its file", async () => {
    // Closing the mounted set is not revocation. An evicted vault is still
    // enrolled and its replica is an asset — deleting it would cost the member
    // a full re-bootstrap the next time they switch back to that Space.
    const reclaimed: string[] = [];
    const { facade } = build({
      sessions: new Map([["home", fakeSession({}).session]]),
      scopes: [scope("home", { databaseName: "/replica/home.sqlite3" })],
      reclaimRevokedReplica: (revokedScope) => {
        reclaimed.push(revokedScope.databaseName);
      },
    });

    await facade.close();

    expect(reclaimed).toStrictEqual([]);
  });

  test("a revoked scope no longer pulls or counts toward coverage", async () => {
    const family = fakeSession({ pulls: true, coverage: "partial" });
    const { facade } = build({
      sessions: new Map([
        ["home", fakeSession({ pulls: true, coverage: "complete" }).session],
        ["family", family.session],
      ]),
      scopes: [scope("home"), scope("family")],
    });

    await facade.revokeScope("family");

    expect((await facade.pullScopes()).pulled).toStrictEqual(["home"]);
    expect(family.pullNow).not.toHaveBeenCalled();
    await expect(facade.status()).resolves.toMatchObject({
      coverage: "complete",
    });
  });
});

describe("how a cross-vault placement settles", () => {
  const intent = {
    kind: "add",
    itemType: "media.asset",
    itemId: "asset-1",
    sourceVaultId: "home",
    targetVaultId: "family",
  } as const;

  test("an accepted placement takes the gateway's own record", async () => {
    const { facade, reader } = build({
      sessions: new Map(),
      scopes: [scope("home"), scope("family")],
      sendPlacement: (input) =>
        Promise.resolve({
          ...input,
          status: "executed",
          createdAt: "2026-08-27T09:00:00.000Z",
          updatedAt: "2026-08-27T09:00:01.000Z",
        }),
    });

    const record = await facade.place(intent);

    expect(record.status).toBe("executed");
    expect(reader.records.get("link-1")?.status).toBe("executed");
  });

  test("classifies denial and terminal failure from the gateway, and parks the rest", async () => {
    const cases = [
      {
        thrown: Object.assign(new Error("no"), { placementStatus: "denied" }),
        expected: "denied",
      },
      {
        thrown: Object.assign(new Error("gone"), { placementStatus: "failed" }),
        expected: "failed",
      },
      // A transport fault is not a verdict: parked keeps it retryable and
      // visible instead of inventing a refusal nobody issued.
      { thrown: new Error("network unreachable"), expected: "parked" },
    ] as const;
    for (const entry of cases) {
      const { facade, reader } = build({
        sessions: new Map(),
        scopes: [scope("home"), scope("family")],
        sendPlacement: () => Promise.reject(entry.thrown),
      });
      // oxlint-disable-next-line no-await-in-loop
      await facade.place(intent);
      expect(reader.records.get("link-1")).toMatchObject({
        status: entry.expected,
        reason: entry.thrown.message,
      });
    }
  });

  test("the transfer rules stop a placement drain the same way they stop a pull", async () => {
    const sendPlacement = vi.fn<() => Promise<PlacementRecord>>(() =>
      Promise.reject(new Error("must not send"))
    );
    const { facade, reader } = build({
      sessions: new Map(),
      scopes: [scope("home"), scope("family")],
      isNetworkWorkAllowed: () => Promise.resolve(false),
      sendPlacement,
    });

    const record = await facade.place(intent);

    expect(sendPlacement).not.toHaveBeenCalled();
    // Durable and waiting, never lost: the queue is what offline placement is.
    expect(record.status).toBe("queued");
    expect(reader.records.get("link-1")?.status).toBe("queued");
  });

  test("an offline device queues without dialling anything", async () => {
    const sendPlacement = vi.fn<() => Promise<PlacementRecord>>(() =>
      Promise.reject(new Error("must not send"))
    );
    const { facade } = build({
      sessions: new Map(),
      scopes: [scope("home"), scope("family")],
      isConnected: () => false,
      sendPlacement,
    });

    await expect(facade.place(intent)).resolves.toMatchObject({
      status: "queued",
    });
    expect(sendPlacement).not.toHaveBeenCalled();
  });
});

describe("what a pending row carries to the surface (#880 W2.3)", () => {
  test("threads attempts, the queue stamp and both conflict versions", async () => {
    // THE REGRESSION THIS PINS. The facade rebuilt each row by hand and kept
    // four fields, so the sheet could not tell a slow write from a stuck one
    // and a conflict arrived without the two versions it was retained WITH
    // (docs/mobile-offline.md).
    const { facade } = build({
      sessions: new Map([
        [
          "home",
          fakeSession({
            pending: [
              {
                intentId: "intent-1",
                status: "conflict",
                appId: "tally",
                action: "add_expense",
                reason: "This row changed somewhere else.",
                attempts: 2,
                enqueuedAt: "2026-08-27T08:00:00.000Z",
                expectedVersion: 3,
                actualVersion: 5,
              },
            ],
          }).session,
        ],
      ]),
      scopes: [scope("home")],
    });

    await expect(facade.pendingChanges()).resolves.toStrictEqual([
      {
        id: "intent-1",
        vaultId: "home",
        vaultLabel: "home vault",
        status: "conflict",
        // The seats parse this; the presented act travels beside it.
        label: "tally: add_expense",
        appId: "tally",
        action: "add_expense",
        reason: "This row changed somewhere else.",
        attempts: 2,
        enqueuedAt: "2026-08-27T08:00:00.000Z",
        expectedVersion: 3,
        actualVersion: 5,
        kind: "replica",
      },
    ]);
  });

  test("an attention remnant keeps the fields it actually has", async () => {
    const { facade } = build({
      sessions: new Map([
        [
          "home",
          fakeSession({
            pending: [
              {
                intentId: "intent-2",
                status: "failed",
                appId: "docs",
                action: "rename",
                createdAt: "2026-08-27T08:00:00.000Z",
              },
            ],
          }).session,
        ],
      ]),
      scopes: [scope("home")],
    });

    const [row] = await facade.pendingChanges();

    // No invented attempt count: the sheet reads its absence as "the outbox no
    // longer holds this", which is exactly what an attention row is.
    expect(row).not.toHaveProperty("attempts");
    expect(row).not.toHaveProperty("enqueuedAt");
    expect(row).toMatchObject({ status: "failed", label: "docs: rename" });
  });
});

describe("out of room, across the mounted plane (#880 W2.10)", () => {
  test("one parked scope reports the phone out of room, and resume clears it", async () => {
    const home = fakeSession({ storageFull: true });
    const family = fakeSession({});
    const { facade } = build({
      sessions: new Map([
        ["home", home.session],
        ["family", family.session],
      ]),
      scopes: [scope("home"), scope("family")],
    });

    // The disk is the phone's, not the vault's: one parked scope is the whole
    // device out of room, and the screens draw that state once.
    expect(facade.storageFull).toBe(true);

    facade.resumeAfterStorageFull();

    // Every scope is unparked, not only the one that noticed first: the next
    // scope to write would otherwise park again on the same full disk.
    expect(home.session.storageFull).toBe(false);
    expect(family.session.storageFull).toBe(false);
    expect(facade.storageFull).toBe(false);
  });
});
