// THE PHONE'S WRITE RAIL, OVER ITS REAL SEAT (#996, W5; R23–R25).
//
// The session's whole job is a member's write reaching the gateway, and every
// claim here is one that failed silently before it was pinned:
//
//   A WRITE MADE BEFORE THE COPY ARRIVES IS DURABLE. The outbox is a table in
//   the seat's FILE, and the file is opened before the session — so a write on
//   a train survives the relaunch. It used to go to a store that waited for the
//   bootstrap, which meant memory, which meant gone.
//
//   AN OFFLINE WRITE ANSWERS, AND SAYS WHY. An awaited `write()` that never
//   settles is an app that has stopped, not an error anyone sees.
//
//   THE HEAD IS HELD (R23). A transport failure holds its place, so the change
//   behind it is not sent past it — and its writer is settled on the durable
//   admission it already has rather than left awaiting.
//
//   AND A REPLACED COPY QUIESCES, IT DOES NOT REFUSE. A write during a
//   re-bootstrap is ADMITTED and NOT SENT (`admissionDuringRebootstrap`).

import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openNodeNativeSeat } from "./native-seat.test-fixtures";
import { createNativeReplicaSession } from "./native-session";
import type { NativeChangeFeed, NativeReplicaSession } from "./native-session";

const VAULT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedule_task (
    task_id TEXT PRIMARY KEY, title TEXT, row_version INTEGER NOT NULL DEFAULT 1
  ) STRICT;
`;

const gatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-a",
};

/** A feed that carries nothing: these suites drive the session directly. */
function silentFeed(): NativeChangeFeed {
  return {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
}

const nodeDigest = (canonical: string): Promise<string> =>
  Promise.resolve(`digest:${canonical.length}`);

function sequentialIds(): () => string {
  let n = 0;
  return () => `intent-${(n += 1)}`;
}

interface Rig {
  session: NativeReplicaSession;
  posted: string[];
  /** What the next POST answers with; `undefined` means a transport failure. */
  answer: (reply: { status: number; body?: unknown } | undefined) => void;
}

const open: NativeReplicaSession[] = [];

async function rig(
  file: string,
  options: { connected?: boolean; holdSync?: Promise<void> } = {}
): Promise<Rig> {
  const posted: string[] = [];
  let reply: { status: number; body?: unknown } | undefined = {
    status: 200,
    body: { outcome: { intentId: "", status: "executed" } },
  };
  const seat = await openNodeNativeSeat({
    path: file,
    schema: VAULT_SCHEMA,
    ...(options.holdSync ? { holdSync: options.holdSync } : {}),
  });
  const session = await createNativeReplicaSession({
    gatewayAuth: { ...gatewayAuth },
    seat,
    changeFeed: silentFeed(),
    isConnected: () => options.connected !== false,
    digest: nodeDigest,
    idFactory: sequentialIds(),
    retryDelayMs: 50,
    fetcher: (_base, pathname, init) => {
      posted.push(pathname);
      if (!reply) return Promise.reject(new Error("offline"));
      const body = JSON.parse(String(init.body ?? "{}")) as {
        intentId?: string;
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            outcome: {
              intentId: body.intentId ?? "",
              status: "executed",
              ...(typeof reply.body === "object" ? reply.body : {}),
            },
          }),
          {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }
        )
      );
    },
  });
  open.push(session);
  return { session, posted, answer: (next) => (reply = next) };
}

function task(intentId: string, title: string) {
  return {
    op: "upsert" as const,
    entity: "schedule.task",
    rowId: `task-${intentId}`,
    values: { task_id: `task-${intentId}`, title },
  };
}

describe("the phone's session, over its own seat", () => {
  afterEach(async () => {
    // Sequential by necessity: these share the seat's file, and closing two
    // handles on it at once is the race the ownership rule exists to prevent.
    await forEachSequentially(open.splice(0), (session) =>
      session.close().catch(() => undefined)
    );
  });

  it("settles an admitted write on the gateway's outcome", async () => {
    const root = tempDirSync("native-session-");
    const { session, posted } = await rig(path.join(root, "seat.db"));
    const result = await session.write("tasks", {
      action: "tasks.add_task",
      input: { title: "Ferry" },
      optimistic: [task("intent-1", "Ferry")],
    });
    expect(result.status).toBe("executed");
    expect(posted.some((p) => p.includes("intent"))).toBe(true);
  });

  it("a write with no radio is queued, durable, and says why", async () => {
    const root = tempDirSync("native-session-");
    const file = path.join(root, "seat.db");
    const { session } = await rig(file, { connected: false });
    const result = await session.write("tasks", {
      action: "tasks.add_task",
      input: { title: "Ferry" },
      optimistic: [task("intent-1", "Ferry")],
    });
    expect(result.status).toBe("queued");
    expect(result.reason).toBe("waiting for a connection");
    // DURABLE, which is the whole reason the outbox is a table in the file: a
    // second session over the SAME path finds the write the first one took.
    await session.close();
    const second = await rig(file, { connected: false });
    expect(
      (await second.session.pendingChanges()).map((row) => row.action)
    ).toStrictEqual(["tasks.add_task"]);
  });

  it("holds the head when the transport fails, and settles the writer", async () => {
    const root = tempDirSync("native-session-");
    const rigged = await rig(path.join(root, "seat.db"));
    rigged.answer(undefined);
    const result = await rigged.session.write("tasks", {
      action: "tasks.add_task",
      input: { title: "Ferry" },
      optimistic: [task("intent-1", "Ferry")],
    });
    // NEVER an unresolved promise: the durable admission is the answer.
    expect(result.status).toBe("queued");
    expect(result.reason).toContain("retrying");
    const pending = await rigged.session.pendingChanges();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.attempts).toBeGreaterThan(0);
  });

  it("admits a write while the copy is being replaced, and does not send it", async () => {
    const root = tempDirSync("native-session-");
    // The catch-up is HELD open, because that is the window the rule is about:
    // a write made while the file is being replaced is admitted and not sent,
    // and a rig whose sync answered instantly would never be in it.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { session, posted } = await rig(path.join(root, "seat.db"), {
      holdSync: held,
    });
    const before = posted.length;
    session.requireBootstrap({ reason: "epoch" });
    const result = await session.write("tasks", {
      action: "tasks.add_task",
      input: { title: "Ferry" },
      optimistic: [task("intent-1", "Ferry")],
    });
    expect(result.status).toBe("queued");
    expect(posted).toHaveLength(before);
    release();
  });

  it("captures the base version a write is against, from the file", async () => {
    const root = tempDirSync("native-session-");
    const file = path.join(root, "seat.db");
    const seat = await openNodeNativeSeat({ path: file, schema: VAULT_SCHEMA });
    seat
      .driver()
      .run(
        `INSERT INTO schedule_task (task_id, title, row_version) VALUES (?, ?, ?)`,
        ["task-1", "Ferry", 7]
      );
    await expect(
      seat.baseVersions([
        {
          op: "upsert",
          entity: "schedule.task",
          rowId: "task-1",
          values: {},
        },
      ])
    ).resolves.toStrictEqual([
      { entity: "schedule.task", rowId: "task-1", version: 7 },
    ]);
    await seat.close();
  });

  it("an online-only write never reaches the outbox", async () => {
    const root = tempDirSync("native-session-");
    const { session } = await rig(path.join(root, "seat.db"));
    const result = await session.write("locker", {
      action: "locker.reveal",
      input: { item_id: "i1" },
      onlineOnly: true,
    });
    expect(result.status).toBe("executed");
    // A sealed input must leave NO durable trace on this phone.
    await expect(session.pendingChanges()).resolves.toStrictEqual([]);
  });
});
