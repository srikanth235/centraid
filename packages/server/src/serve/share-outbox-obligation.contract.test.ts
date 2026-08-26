/*
 * The sharing plane's ONE effect outbox, as a law (#750 abstraction 2):
 * obligations keyed by WHAT THEY ARE ABOUT (a replay lands on the same row),
 * one unreadable row never blocks its neighbours, failed attempts back off
 * instead of spinning, and (#825) a retired transport leaves the queue and
 * ends its edge honestly. Deterministic by injection: every call takes an
 * explicit `now`.
 */

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import type { ShareEffect } from "./share-coordinator.js";
import { retireDeadShareEffects } from "./share-effects-retire.js";
import {
  claimDueShareEffects,
  completeShareEffect,
  deferShareEffect,
  enqueueShareEffect,
} from "./share-effects.js";

const opened: GatewayDatabase[] = [];

/** Epoch ms with no wall-clock in it — every deadline is relative. */
const T0 = 1_760_000_000_000;

async function outbox(): Promise<GatewayDatabase> {
  const db = GatewayDatabase.open(await tempDir());
  opened.push(db);
  return db;
}

function give(edgeId: string): ShareEffect {
  return { kind: "deliver-give", edgeId };
}

function dueIds(db: GatewayDatabase, now: number): string[] {
  return claimDueShareEffects(db, { now }).map((pending) => pending.effectId);
}

/** A row an older generation wrote, straight into the table (the CHECK
 *  constraint only applies to tables this build CREATED). */
function seedLegacyRow(
  db: GatewayDatabase,
  row: { effectId: string; edgeId: string; kind: string; payload: string }
): void {
  db.db.exec("DROP TABLE share_effects");
  db.db.exec(`CREATE TABLE IF NOT EXISTS share_effects (
      effect_id TEXT PRIMARY KEY,
      edge_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'done')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`);
  db.run(
    `INSERT INTO share_effects
       (effect_id, edge_id, kind, payload_json, status, attempts,
        next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    row.effectId,
    row.edgeId,
    row.kind,
    row.payload,
    T0,
    new Date(T0).toISOString(),
    new Date(T0).toISOString()
  );
}

function seedEdge(db: GatewayDatabase, edgeId: string, status: string): void {
  const now = new Date(T0).toISOString();
  db.run(
    "INSERT OR IGNORE INTO owners (owner_id, label, created_at) VALUES ('own-1', 'Owner', ?)",
    T0
  );
  db.run(
    `INSERT OR IGNORE INTO devices
       (enrollment_id, endpoint_id, owner_id, label, remember_device, added_at)
     VALUES ('enr-1', 'dev-1', 'own-1', 'Laptop', 1, ?)`,
    new Date(T0).toISOString()
  );
  db.run(
    `INSERT INTO share_edges
       (edge_id, created_by_device, owner_id, kind, mode, item_type,
        scope_json, origin_vault_id, audience_vault_id, verbs,
        target_state, source_state, status, created_at, updated_at)
     VALUES (?, 'dev-1', 'own-1', 'add', 'snapshot', 'media.asset',
             '["item-1"]', 'vlt-a', 'vlt-b', 'read',
             'queued', 'not-needed', ?, ?, ?)`,
    edgeId,
    status,
    now,
    now
  );
}

function edgeRow(
  db: GatewayDatabase,
  edgeId: string
): { status: string; reason: string | null } {
  return db.db
    .prepare("SELECT status, reason FROM share_edges WHERE edge_id = ?")
    .get(edgeId) as { status: string; reason: string | null };
}

describe("[law:share-outbox-obligation] every share obligation is durable, single, and eventually drained", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
  });

  test("[law:share-outbox-obligation] a replayed enqueue lands on the same obligation and never rewinds its retry clock", async () => {
    const db = await outbox();
    const first = enqueueShareEffect(db, give("edge-1"), { now: T0 });
    const again = enqueueShareEffect(db, give("edge-1"), { now: T0 + 60_000 });

    expect(again).toBe(first);
    expect(dueIds(db, T0)).toStrictEqual(["give:edge-1"]);

    // A crash-replayed enqueue must not shove a backoff obligation to the front.
    deferShareEffect(db, first, { attempts: 0, now: T0 });
    enqueueShareEffect(db, give("edge-1"), { now: T0 });
    expect(dueIds(db, T0)).toStrictEqual([]);

    // Discharged is forward-only: no later tick picks the row up again.
    completeShareEffect(db, first);
    expect(dueIds(db, T0 + 86_400_000)).toStrictEqual([]);
  });

  test("[law:share-outbox-obligation] one unreadable row never blocks the obligations beside it", async () => {
    const db = await outbox();
    enqueueShareEffect(db, give("edge-early"), { now: T0 });
    // A drifted payload must not reach a transport as if well-formed.
    db.run(
      `INSERT INTO share_effects
         (effect_id, edge_id, kind, payload_json, status, attempts,
          next_attempt_at, created_at, updated_at)
       VALUES ('give:edge-drifted', 'edge-drifted', 'deliver-give',
               'not json at all', 'queued', 0, ?, ?, ?)`,
      T0 + 1,
      new Date(T0 + 1).toISOString(),
      new Date(T0 + 1).toISOString()
    );
    enqueueShareEffect(db, give("edge-late"), { now: T0 + 2 });

    expect(dueIds(db, T0 + 10)).toStrictEqual([
      "give:edge-early",
      "give:edge-late",
    ]);
  });

  test("[law:share-outbox-obligation] a failed attempt backs off rather than spinning", async () => {
    const db = await outbox();
    const effectId = enqueueShareEffect(db, give("edge-retry"), { now: T0 });

    deferShareEffect(db, effectId, { attempts: 0, now: T0 });
    // Five seconds to the millisecond — a tick 1ms early finds nothing.
    expect(dueIds(db, T0 + 4_999)).toStrictEqual([]);
    expect(dueIds(db, T0 + 5_000)).toStrictEqual(["give:edge-retry"]);

    // The second failure doubles the delay rather than repeating it.
    const attempts = claimDueShareEffects(db, { now: T0 + 5_000 })[0]!.attempts;
    expect(attempts).toBe(1);
    deferShareEffect(db, effectId, { attempts, now: T0 + 5_000 });
    expect(dueIds(db, T0 + 5_000 + 9_999)).toStrictEqual([]);
    expect(dueIds(db, T0 + 5_000 + 10_000)).toStrictEqual(["give:edge-retry"]);
  });

  test("[law:share-outbox-obligation] an obligation whose transport retired leaves the queue and ends its edge honestly", async () => {
    const db = await outbox();
    seedEdge(db, "edge-cross", "parked");
    seedLegacyRow(db, {
      effectId: "give:edge-cross",
      edgeId: "edge-cross",
      kind: "deliver-give",
      payload: '{"delivery":"peer","crossOwner":true}',
    });

    const drained = retireDeadShareEffects(db);
    expect(drained).toStrictEqual({ effects: 1, edges: 1 });
    // Not skipped, not marked discharged — gone from the queue.
    expect(dueIds(db, T0 + 365 * 86_400_000)).toStrictEqual([]);
    const after = edgeRow(db, "edge-cross");
    expect(after.status).toBe("failed");
    expect(after.reason).toBe(
      "giving a copy to another person's vault was retired; share it as a grant instead"
    );
    // Idempotent: a second open finds nothing left to drain.
    expect(retireDeadShareEffects(db)).toStrictEqual({ effects: 0, edges: 0 });
  });

  test("[law:share-outbox-obligation] the drain never rewrites an edge that already reached an answer", async () => {
    const db = await outbox();
    seedEdge(db, "edge-landed", "completed");
    seedLegacyRow(db, {
      effectId: "pull:edge-landed:abc",
      edgeId: "edge-landed",
      kind: "pull-blob",
      payload: '{"linkId":"l","localVaultId":"v","sha256":"abc","size":1}',
    });

    expect(retireDeadShareEffects(db)).toStrictEqual({ effects: 1, edges: 0 });
    const after = edgeRow(db, "edge-landed");
    expect(after.status).toBe("completed");
    expect(after.reason).toBeNull();
  });
});
