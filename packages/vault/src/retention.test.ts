import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "./bootstrap.js";
import { openVaultDb } from "./db.js";
import type { VaultDb } from "./db.js";
import { sweepBoundedRetention } from "./retention.js";

const NOW = "2026-07-31T00:00:00.000Z";
const OLD = "2025-01-01T00:00:00.000Z";
const RECENT = "2026-07-30T00:00:00.000Z";

let db: VaultDb;

function countOf(table: string): number {
  return (
    db.vault.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

function seedConnection(): string {
  db.vault
    .prepare(
      `INSERT INTO sync_connection
         (connection_id, kind, label, status, trust, created_at)
       VALUES ('conn-1', 'calendar', 'Calendar', 'active', 'staged', :now)`
    )
    .run({ now: OLD });
  return "conn-1";
}

function seedRun(id: string, status: string, finishedAt: string | null): void {
  db.vault
    .prepare(
      `INSERT INTO sync_connection_run
         (run_id, connection_id, started_at, finished_at, status)
       VALUES (:id, 'conn-1', :started, :finished, :status)`
    )
    .run({
      id,
      started: finishedAt ?? OLD,
      finished: finishedAt,
      status,
    });
}

function seedEnrichRequest(id: string, drainedAt: string | null): void {
  db.vault
    .prepare(
      `INSERT INTO enrich_request
         (request_id, target_type, reason, requested_at, drained_at)
       VALUES (:id, 'media.asset', 'on-view', :requested, :drained)`
    )
    .run({ id, requested: OLD, drained: drainedAt });
}

function seedOutboxItem(id: string, status: string, decidedAt: string): void {
  db.vault
    .prepare(
      `INSERT INTO outbox_item
         (item_id, connection_id, actor_id, actor_kind, verb, target,
          artifact_json, request_json, status, staged_at, decided_at)
       VALUES (:id, 'conn-1', 'owner', 'owner', 'send', 'mailto:a@example.com',
               '{}', '{}', :status, :staged, :decided)`
    )
    .run({ id, status, staged: OLD, decided: decidedAt });
}

describe("bounded retention", () => {
  beforeEach(() => {
    db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    seedConnection();
  });

  test("only terminal rows past the window are shed", () => {
    seedRun("run-old-ok", "ok", OLD);
    seedRun("run-old-failed", "failed", OLD);
    seedRun("run-in-flight", "running", null);
    seedRun("run-recent", "ok", RECENT);
    seedEnrichRequest("req-drained-old", OLD);
    seedEnrichRequest("req-open", null);
    seedOutboxItem("item-sent-old", "sent", OLD);
    seedOutboxItem("item-discarded-old", "discarded", OLD);
    seedOutboxItem("item-failed-old", "failed", OLD);
    seedOutboxItem("item-pending", "pending", OLD);

    const result = sweepBoundedRetention(db.vault, { now: NOW });

    expect(result.sync_connection_run.deleted).toBe(2);
    const runs = db.vault
      .prepare("SELECT run_id FROM sync_connection_run ORDER BY run_id")
      .all() as { run_id: string }[];
    expect(runs.map((r) => r.run_id)).toStrictEqual([
      "run-in-flight",
      "run-recent",
    ]);

    expect(result.enrich_request.deleted).toBe(1);
    expect(countOf("enrich_request")).toBe(1);

    expect(result.outbox_item.deleted).toBe(2);
    const items = db.vault
      .prepare("SELECT item_id FROM outbox_item ORDER BY item_id")
      .all() as { item_id: string }[];
    expect(items.map((r) => r.item_id)).toStrictEqual([
      "item-failed-old",
      "item-pending",
    ]);
  });

  test("the newest run of a connection survives however old it is", () => {
    seedRun("run-only", "ok", OLD);
    const result = sweepBoundedRetention(db.vault, { now: NOW });
    expect(result.sync_connection_run.deleted).toBe(0);
    expect(countOf("sync_connection_run")).toBe(1);
  });

  test("a pass never deletes more than its cap and reports there is more", () => {
    for (let i = 0; i < 12; i += 1) seedEnrichRequest(`req-${i}`, OLD);
    const first = sweepBoundedRetention(db.vault, { now: NOW, limit: 5 });
    expect(first.enrich_request).toStrictEqual({ deleted: 5, capped: true });
    expect(countOf("enrich_request")).toBe(7);

    sweepBoundedRetention(db.vault, { now: NOW, limit: 5 });
    const third = sweepBoundedRetention(db.vault, { now: NOW, limit: 5 });
    expect(third.enrich_request).toStrictEqual({ deleted: 2, capped: false });
    expect(countOf("enrich_request")).toBe(0);
  });

  test("a sweep with nothing eligible writes nothing", () => {
    seedRun("run-recent", "ok", RECENT);
    seedEnrichRequest("req-open", null);
    const before = (
      db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;
    const result = sweepBoundedRetention(db.vault, { now: NOW });
    expect(
      (db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }).n
    ).toBe(before);
    expect(result.sync_connection_run.deleted).toBe(0);
    expect(result.enrich_request.deleted).toBe(0);
    expect(result.outbox_item.deleted).toBe(0);
  });
});
