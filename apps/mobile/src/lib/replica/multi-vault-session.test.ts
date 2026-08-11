// The mounted read is replica ⊕ outbox, per vault (issue #738 P4).
//
// Sabotage-verified: dropping `composeMountedOverlay` from
// `MultiVaultReplicaSession.read` back to a bare `reader.read` fails all four
// tests below — a queued write stays durable and invisible, which is exactly
// the defect this covers.

import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type {
  ReplicaCursor,
  ReplicaDigest,
  ReplicaFetcher,
  ReplicaIdFactory,
  ReplicaRow,
} from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "./multi-vault-reader";
import type { MountedReplicaScope } from "./multi-vault-reader";
import { MultiVaultReplicaSession } from "./multi-vault-session";
import { createNativeReplicaSession } from "./native-session";
import type { NativeChangeFeed, NativeReplicaSession } from "./native-session";
import { NodeSqliteDriver } from "./node-sqlite-driver";

const SHAPE_ENTITIES = [
  {
    entity: "schedule.task",
    primaryKey: "task_id",
    columns: ["task_id", "title", "status", "due_at"],
  },
];

/** Hermes has no `crypto.subtle`; the session takes the digest by injection. */
const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

function sequentialIds(prefix: string): ReplicaIdFactory {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

/** A change feed that does nothing: these runs never reach a gateway. */
function silentFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

const CURSOR: ReplicaCursor = { epoch: "replica-1", seq: 1 };

/**
 * A gateway that answers exactly one windowed bootstrap page for `vaultId`
 * (plus its mandatory convergence replay) and nothing else.
 */
function bootstrapOnce(
  vaultId: string,
  shapeId: string,
  rows: ReplicaRow[]
): ReplicaFetcher {
  return (_baseUrl, pathname) => {
    const body = pathname.includes("/replica/bootstrap")
      ? {
          protocolVersion: 1,
          vaultId,
          schemaEpoch: "schema-1",
          cursor: CURSOR,
          complete: true,
          shapes: [
            {
              shapeId,
              appId: "tasks",
              purpose: "dpv:ServiceProvision",
              entities: SHAPE_ENTITIES,
            },
          ],
          shapeIds: [shapeId],
          rows: rows.map((values) => ({
            shapeId,
            entity: "schedule.task",
            rowId: String(values.task_id),
            values,
          })),
        }
      : {
          protocolVersion: 1,
          schemaEpoch: "schema-1",
          from: CURSOR,
          to: CURSOR,
          changes: [],
        };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  };
}

/**
 * Like `bootstrapOnce`, plus a FIFO of `/replica/intents` outcomes — for
 * proving what the mounted facade's `pendingChanges()` reports about a
 * settled-but-unexecuted write (issue #738 gap 1/3).
 */
function bootstrapWithIntentOutcomes(
  vaultId: string,
  shapeId: string,
  rows: ReplicaRow[],
  outcomes: readonly Record<string, unknown>[]
): ReplicaFetcher {
  const base = bootstrapOnce(vaultId, shapeId, rows);
  let call = 0;
  return (baseUrl, pathname, init) => {
    if (!pathname.includes("/replica/intents"))
      return base(baseUrl, pathname, init);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      intentId: string;
    };
    const outcome = outcomes[call] ?? { status: "executed" };
    call += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({ outcome: { intentId: body.intentId, ...outcome } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  };
}

interface MountedVault {
  scope: MountedReplicaScope;
  file: string;
  shapeId: string;
}

async function openVault(
  vault: MountedVault,
  rows: ReplicaRow[],
  isConnected: () => boolean,
  fetcher: ReplicaFetcher = bootstrapOnce(
    vault.scope.vaultId,
    vault.shapeId,
    rows
  )
): Promise<NativeReplicaSession> {
  return createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:18789",
      gatewayId: "gateway-1",
      vaultId: vault.scope.vaultId,
    },
    fetcher,
    changeFeed: silentFeed(),
    driver: new NodeSqliteDriver(vault.file),
    digest: nodeDigest,
    idFactory: sequentialIds(vault.scope.vaultId),
    isConnected,
  });
}

function mount(
  root: string,
  sessions: Map<string, NativeReplicaSession>,
  mounted: readonly MountedVault[]
): MultiVaultReplicaSession {
  return new MultiVaultReplicaSession({
    reader: new MultiVaultReplicaReader(
      new NodeSqliteDriver(path.join(root, `mounted-${sessions.size}.db`)),
      mounted.map((vault) => vault.scope)
    ),
    sessions,
    scopes: mounted.map((vault) => vault.scope),
    focusedVaultId: () => mounted[0]!.scope.vaultId,
    createId: sequentialIds("placement"),
    sendPlacement: () => Promise.reject(new Error("no placement transport")),
    isConnected: () => false,
  });
}

function vaults(root: string): MountedVault[] {
  return [
    {
      scope: {
        vaultId: "personal",
        label: "Personal",
        canWrite: true,
        databaseName: path.join(root, "personal.db"),
      },
      file: path.join(root, "personal.db"),
      shapeId: "tasks-personal",
    },
    {
      scope: {
        vaultId: "family",
        label: "Family",
        canWrite: true,
        databaseName: path.join(root, "family.db"),
      },
      file: path.join(root, "family.db"),
      shapeId: "tasks-family",
    },
  ];
}

/** The projection form a screen uses: rows minted from the session's intent id. */
const addTask = (title: string) => ({
  action: "add",
  input: { title },
  optimistic: (intentId: string) => [
    {
      op: "upsert" as const,
      entity: "schedule.task",
      rowId: `pending-${intentId}`,
      values: {
        task_id: `pending-${intentId}`,
        title,
        status: "needs-action",
        due_at: null,
      },
    },
  ],
});

function titles(rows: readonly { values: ReplicaRow }[]): string[] {
  return rows.map((row) => String(row.values.title));
}

describe(MultiVaultReplicaSession, () => {
  test("shows a queued write's row in the mounted read, in its own vault", async () => {
    const root = tempDirSync("centraid-mounted-overlay-");
    const mounted = vaults(root);
    let connected = true;
    const sessions = new Map<string, NativeReplicaSession>([
      [
        "personal",
        await openVault(
          mounted[0]!,
          [
            {
              task_id: "task-p",
              title: "Canonical personal",
              status: "needs-action",
              due_at: null,
            },
          ],
          () => connected
        ),
      ],
      [
        "family",
        await openVault(
          mounted[1]!,
          [
            {
              task_id: "task-f",
              title: "Canonical family",
              status: "needs-action",
              due_at: null,
            },
          ],
          () => connected
        ),
      ],
    ]);
    const session = mount(root, sessions, mounted);
    try {
      connected = false;
      const outcome = await session.writeTo(
        "family",
        "tasks",
        addTask("Bring the tent")
      );
      expect(outcome.status).toBe("queued");

      const read = await session.read("tasks", { entity: "schedule.task" });
      const pending = read.rows.find(
        (row) => row.values.title === "Bring the tent"
      );
      expect(titles(read.rows)).toContain("Bring the tent");
      expect(pending?.values.__centraidScopeId).toBe("family");
      expect(pending?.values.__centraidScopeLabel).toBe("Family");
      expect(pending?.rowId.startsWith("family:pending-")).toBe(true);
      // One row, in one vault: the other mounted vault gained nothing.
      expect(
        read.rows.filter((row) => row.values.title === "Bring the tent")
      ).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  test("keeps one vault's unsettled writes off another vault's rows", async () => {
    const root = tempDirSync("centraid-mounted-scoping-");
    const mounted = vaults(root);
    let connected = true;
    // The same row id in both vaults: a scoping bug rewrites both.
    const seed = [
      {
        task_id: "task-1",
        title: "Untouched",
        status: "needs-action",
        due_at: null,
      },
    ];
    const sessions = new Map<string, NativeReplicaSession>([
      ["personal", await openVault(mounted[0]!, seed, () => connected)],
      ["family", await openVault(mounted[1]!, seed, () => connected)],
    ]);
    const session = mount(root, sessions, mounted);
    try {
      connected = false;
      await session.writeTo("personal", "tasks", {
        action: "edit",
        input: { task_id: "task-1", title: "Renamed here" },
        optimistic: [
          {
            op: "upsert",
            entity: "schedule.task",
            rowId: "task-1",
            values: { task_id: "task-1", title: "Renamed here" },
          },
        ],
      });

      const read = await session.read("tasks", { entity: "schedule.task" });
      const byVault = new Map(
        read.rows.map((row) => [
          String(row.values.__centraidScopeId),
          String(row.values.title),
        ])
      );
      expect(byVault.get("personal")).toBe("Renamed here");
      expect(byVault.get("family")).toBe("Untouched");
    } finally {
      await session.close();
    }
  });

  test("answers the request's filter over composed rows", async () => {
    const root = tempDirSync("centraid-mounted-filter-");
    const mounted = vaults(root);
    let connected = true;
    const sessions = new Map<string, NativeReplicaSession>([
      ["personal", await openVault(mounted[0]!, [], () => connected)],
      ["family", await openVault(mounted[1]!, [], () => connected)],
    ]);
    const session = mount(root, sessions, mounted);
    try {
      connected = false;
      await session.writeTo("personal", "tasks", addTask("Open one"));
      await session.writeTo("personal", "tasks", {
        action: "add",
        input: { title: "Finished one" },
        optimistic: [
          {
            op: "upsert",
            entity: "schedule.task",
            rowId: "pending-done",
            values: {
              task_id: "pending-done",
              title: "Finished one",
              status: "completed",
              due_at: null,
            },
          },
        ],
      });

      const open = await session.read("tasks", {
        entity: "schedule.task",
        where: [{ column: "status", op: "eq", value: "needs-action" }],
      });
      expect(titles(open.rows)).toStrictEqual(["Open one"]);
    } finally {
      await session.close();
    }
  });

  test("still composes the queued row after a restart over the same store", async () => {
    const root = tempDirSync("centraid-mounted-restart-");
    const mounted = vaults(root);
    let connected = true;
    const first = new Map<string, NativeReplicaSession>([
      ["personal", await openVault(mounted[0]!, [], () => connected)],
      ["family", await openVault(mounted[1]!, [], () => connected)],
    ]);
    const before = mount(root, first, mounted);
    connected = false;
    await before.writeTo("personal", "tasks", addTask("Survives a restart"));
    await before.close();

    // A cold start: new sessions, new mounted reader, same files — and still
    // offline, so nothing could have been re-fetched from a gateway.
    const second = new Map<string, NativeReplicaSession>([
      ["personal", await openVault(mounted[0]!, [], () => connected)],
      ["family", await openVault(mounted[1]!, [], () => connected)],
    ]);
    const after = mount(root, second, mounted);
    try {
      const read = await after.read("tasks", { entity: "schedule.task" });
      expect(titles(read.rows)).toStrictEqual(["Survives a restart"]);
      const pending = await after.pendingChanges();
      expect(pending[0]).toMatchObject({
        appId: "tasks",
        vaultId: "personal",
        status: "queued",
      });
      expect(pending[0]?.rowIds?.[0]?.startsWith("pending-")).toBe(true);
    } finally {
      await after.close();
    }
  });

  // Issue #738 gap 1/3: the sheet's `pendingChanges()` has to carry the
  // action, the journaled payload, and — for a conflict — the expected/
  // actual versions, or ReplicaStatusBar has nothing to retry from and
  // nothing but a generic string to show for a conflict.
  test("surfaces a denied write's action, vault, and payload for a retry", async () => {
    const root = tempDirSync("centraid-mounted-attention-");
    const mounted = vaults(root);
    const connected = true;
    const sessions = new Map<string, NativeReplicaSession>([
      [
        "personal",
        await openVault(
          mounted[0]!,
          [],
          () => connected,
          bootstrapWithIntentOutcomes(
            mounted[0]!.scope.vaultId,
            mounted[0]!.shapeId,
            [],
            [{ status: "denied", reason: "the owner said no" }]
          )
        ),
      ],
      ["family", await openVault(mounted[1]!, [], () => connected)],
    ]);
    const session = mount(root, sessions, mounted);
    try {
      const outcome = await session.writeTo(
        "personal",
        "tasks",
        addTask("Bring the tent")
      );
      expect(outcome.status).toBe("denied");

      const pending = await session.pendingChanges();
      const attention = pending.find((item) => item.status === "denied");
      expect(attention).toMatchObject({
        vaultId: "personal",
        appId: "tasks",
        action: "add",
        reason: "the owner said no",
        input: { title: "Bring the tent" },
      });
      // The row a member is answering is unambiguous: only the vault it was
      // queued against reports it.
      expect(pending.filter((item) => item.status === "denied")).toHaveLength(
        1
      );
    } finally {
      await session.close();
    }
  });
});
