// @vitest-environment jsdom
// THE WEB BOOTSTRAP LOOP (#922 E3).
//
// On the browser seat two catch-up paths legitimately hold the SAME cursor at
// once: the windowed bootstrap's convergence replay (`windowed-bootstrap.ts`)
// and the change feed's own sync, which `bootstrapCommit` re-attaches before
// that replay finishes. The slower one therefore arrives with a `from` the
// faster one has already passed. The store called that a `cursor-gap`, wiped
// itself and demanded a re-bootstrap — which raced exactly the same way, so
// the seat never left "Loading …". The failed bootstrap also rejected
// `openReplicaShellSession`, whose worker was then never closed, so the next
// lease opened a SECOND worker on the same OPFS pool and fought its access
// handles forever.
//
// Both halves are pinned here: a gap is a batch that starts AHEAD of us, and a
// session that cannot start hands its handles back.
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { ReplicaProtocolError } from "./errors.js";
import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { ReplicaRebootstrapRequiredError } from "./replica-rebootstrap-error.js";
import type * as TypeImport_shell from "./shell-session.js";
import type { ReplicaIdentityInventory } from "./storage-manifest.js";
import { ReplicaSqliteStore } from "./store-core.js";
import { snapshot } from "./store-core.test-fixtures.js";
import type { ReplicaChange, ReplicaChangeBatch } from "./types.js";
import type { ReplicaWorkerLike } from "./worker-client.js";
import type { ReplicaWorkerRequest } from "./worker-protocol.js";

const EPOCH = "replica-1";

function event(rowId: string, title: string): ReplicaChange {
  return {
    op: "upsert",
    shapeId: "shape-agenda",
    entity: "core.event",
    rowId,
    values: {
      event_id: rowId,
      title,
      status: "open",
      starts_at: "2026-07-15T12:00:00.000Z",
    },
  };
}

function batch(
  from: number,
  to: number,
  changes: ReplicaChange[]
): ReplicaChangeBatch {
  return {
    protocolVersion: 1,
    schemaEpoch: "schema-1",
    from: { epoch: EPOCH, seq: from },
    to: { epoch: EPOCH, seq: to },
    changes,
  };
}

function titles(store: ReplicaSqliteStore): string[] {
  return store
    .read({ shapeId: "shape-agenda", entity: "core.event", limit: 50 })
    .rows.map((row) => String(row.values.title))
    .toSorted();
}

describe("two catch-up paths at one cursor", () => {
  function bootstrapped(): ReplicaSqliteStore {
    const store = new ReplicaSqliteStore(new NodeSqliteDriver(), "vault-a");
    store.bootstrap(snapshot());
    return store;
  }

  test("an overlapping batch converges instead of demanding a re-bootstrap", () => {
    const store = bootstrapped();
    try {
      // The feed wins the race and lands 2 → 3.
      expect(
        store.applyChanges(batch(2, 3, [event("event-3", "Feed")]))
      ).toMatchObject({ cursor: { epoch: EPOCH, seq: 3 } });
      // The convergence replay was cut from the SAME cursor 2 and reaches 5.
      const applied = store.applyChanges(
        batch(2, 5, [event("event-3", "Feed"), event("event-4", "Converge")])
      );
      expect(applied.cursor).toStrictEqual({ epoch: EPOCH, seq: 5 });
      expect(store.status().cursor).toStrictEqual({ epoch: EPOCH, seq: 5 });
      expect(titles(store)).toStrictEqual([
        "Converge",
        "Earlier",
        "Feed",
        "Later",
      ]);
    } finally {
      store.close();
    }
  });

  test("a batch already spent is a no-op that never moves the cursor back", () => {
    const store = bootstrapped();
    try {
      store.applyChanges(batch(2, 5, [event("event-3", "Ahead")]));
      const spent = store.applyChanges(
        batch(2, 4, [event("event-3", "Stale echo")])
      );
      expect(spent.cursor).toStrictEqual({ epoch: EPOCH, seq: 5 });
      expect(spent.invalidations).toStrictEqual([]);
      expect(store.status().cursor).toStrictEqual({ epoch: EPOCH, seq: 5 });
      // The stale copy of the row never overwrote the applied one.
      expect(titles(store)).toStrictEqual(["Ahead", "Earlier", "Later"]);
    } finally {
      store.close();
    }
  });

  test("a batch that starts ahead of the cursor is still a gap that wipes", () => {
    const store = bootstrapped();
    try {
      expect(() =>
        store.applyChanges(batch(9, 10, [event("event-9", "Missed")]))
      ).toThrow(ReplicaRebootstrapRequiredError);
      expect(store.status().cursor).toBeNull();
    } finally {
      store.close();
    }
  });
});

// The opener's half: the worker it created must not outlive a failed start.
const BASE_URL = "https://gateway.example";
let openReplicaShellSession: typeof TypeImport_shell.openReplicaShellSession;

interface FakeWorker extends ReplicaWorkerLike {
  ops: string[];
}

function fakeWorkerFactory(): () => FakeWorker {
  return () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const worker: FakeWorker = {
      ops: [],
      postMessage(message: ReplicaWorkerRequest) {
        worker.ops.push(message.op);
        const result =
          message.op === "open"
            ? {
                mode: "memory",
                cursor: null,
                schemaEpoch: null,
                coverage: "partial",
                durability: "memory",
              }
            : undefined;
        queueMicrotask(() => {
          for (const listener of listeners.get("message") ?? [])
            listener({ data: { id: message.id, ok: true, result } });
        });
      },
      addEventListener(type: string, listener: (event: unknown) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        listeners.get(type)?.delete(listener);
      },
      terminate() {
        worker.ops.push("terminate");
      },
    } as unknown as FakeWorker;
    return worker;
  };
}

const inventory: ReplicaIdentityInventory = {
  activate: async () => true,
  markTerminal: async () => undefined,
  deferTerminal: async () => undefined,
  remove: async () => undefined,
  list: async () => [],
};

describe("a session that cannot start hands its handles back", () => {
  let priorFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    Object.assign(window, {
      CentraidApi: {
        getGatewayAuth: () =>
          Promise.resolve({
            baseUrl: BASE_URL,
            token: "token",
            gatewayId: "profile-home",
            vaultId: "vault-a",
            rememberDevice: false,
          }),
        onGatewayChanged: () => () => undefined,
        onVaultChanged: () => () => undefined,
      },
    });
    ({ openReplicaShellSession } = await import("./shell-session.js"));
  });

  beforeEach(() => {
    priorFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(
        new ReplicaProtocolError("no gateway in this test")
      ) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = priorFetch;
  });

  test("a bootstrap that fails closes the replica worker it opened", async () => {
    const factory = fakeWorkerFactory();
    let opened: FakeWorker | undefined;
    await expect(
      openReplicaShellSession(
        {
          baseUrl: BASE_URL,
          token: "token",
          gatewayId: "profile-home",
          vaultId: "vault-a",
        },
        {
          workerFactory: () => {
            opened = factory();
            return opened;
          },
          inventory,
          isOnline: () => true,
          eventTarget: { addEventListener() {}, removeEventListener() {} },
          // The first bootstrap page never arrives, and a protocol failure is
          // not transient — `start` rejects and takes the open with it.
          fetcher: () => {
            throw new ReplicaProtocolError("bootstrap refused");
          },
        }
      )
    ).rejects.toThrow(ReplicaProtocolError);
    expect(opened?.ops).toContain("close");
  });
});
