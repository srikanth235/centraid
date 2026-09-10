/*
 * Sweep wiring for the vault-side collectors (#659 L1/L3/L4/L5).
 *
 * `vault.db` is the sovereign asset and is meant to stay small, but two
 * families accreted in it with no collector at all: expired undo snapshots and
 * terminal operational rows. The vault package owns the policy; these tests own
 * the claim that the gateway's sweep actually RUNS it, and runs it bounded.
 */

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultPlane } from "./vault-plane.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];

/** Drive the same sweep entry point `start()` invokes. */
function sweep(plane: unknown): void {
  (plane as { runSweep: () => void }).runSweep();
}

describe("vault-plane maintenance sweep", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  function seedRevisions(
    plane: ReturnType<typeof openVaultPlane>,
    count: number,
    undoUntil: string
  ): void {
    const insert = plane.db.vault.prepare(
      `INSERT INTO core_entity_revision
         (revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at, undo_until)
       VALUES (?, 'note', ?, 'update', '{}', ?, ?)`
    );
    const recordedAt = new Date(Date.now() - 86_400_000).toISOString();
    for (let index = 0; index < count; index += 1) {
      insert.run(`rev-${index}`, `note-${index}`, recordedAt, undoUntil);
    }
  }

  function revisionCount(plane: ReturnType<typeof openVaultPlane>): number {
    return Number(
      (
        plane.db.vault
          .prepare(`SELECT COUNT(*) AS n FROM core_entity_revision`)
          .get() as { n: number }
      ).n
    );
  }

  test("prunes undo snapshots whose window has closed and keeps the ones still undoable", async () => {
    const dir = await tempDir();
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());

    // Ten expired snapshots (no reader will ever return these) and five that
    // are still inside their undo window.
    seedRevisions(plane, 10, new Date(Date.now() - 3_600_000).toISOString());
    const live = plane.db.vault.prepare(
      `INSERT INTO core_entity_revision
         (revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at, undo_until)
       VALUES (?, 'note', ?, 'update', '{}', ?, ?)`
    );
    const future = new Date(Date.now() + 86_400_000).toISOString();
    for (let index = 0; index < 5; index += 1) {
      live.run(
        `live-${index}`,
        `note-live-${index}`,
        new Date().toISOString(),
        future
      );
    }
    expect(revisionCount(plane)).toBe(15);

    sweep(plane);

    // Only the undoable ones survive.
    expect(revisionCount(plane)).toBe(5);
    const survivors = plane.db.vault
      .prepare(
        `SELECT revision_id FROM core_entity_revision ORDER BY revision_id`
      )
      .all() as { revision_id: string }[];
    expect(survivors.every((row) => row.revision_id.startsWith("live-"))).toBe(
      true
    );
  }, 30_000);

  test("bounds one pass and drains the backlog over later sweeps, not over days", async () => {
    const dir = await tempDir();
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());

    // More expired snapshots than one pass may delete (the vault's cap is
    // 5000), so the first sweep must NOT clear them all…
    seedRevisions(plane, 5_600, new Date(Date.now() - 3_600_000).toISOString());
    sweep(plane);
    const afterFirst = revisionCount(plane);
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(5_600);

    // …and the daily gate must have been re-opened, so the NEXT ordinary sweep
    // finishes the job instead of waiting twenty-four hours.
    sweep(plane);
    expect(revisionCount(plane)).toBe(0);
  }, 60_000);

  test("holds the daily gate once the backlog is gone", async () => {
    const dir = await tempDir();
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());

    seedRevisions(plane, 3, new Date(Date.now() - 3_600_000).toISOString());
    sweep(plane);
    expect(revisionCount(plane)).toBe(0);

    // A second sweep in the same minute is inside the daily gate: a row
    // inserted now must survive it, proving the pass did not re-run.
    seedRevisions(plane, 2, new Date(Date.now() - 3_600_000).toISOString());
    sweep(plane);
    expect(revisionCount(plane)).toBe(2);
  }, 30_000);
});

/*
 * THE OUTCOME LEDGER'S WINDOW, AND WHO KEEPS IT (#1014, X1; R-1014-12).
 *
 * Revoking a device used to DELETE its idempotency ledger while the phone kept
 * its outbox, so a lost-then-found phone re-paired and replayed intents the
 * gateway had already executed. The ledger survives now — which makes it the
 * sweep's job to bound it, and `pruneReplicaIntentOutcomes` had no production
 * caller at all until this.
 */
describe("what a revoked device leaves behind", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  function seedOutcome(
    plane: ReturnType<typeof openVaultPlane>,
    intentId: string,
    expiresAt: string | null
  ): void {
    plane.db.vault
      .prepare(
        `INSERT INTO replica_intent_outcome
           (intent_id, device_id, app_id, action, payload_hash, status,
            created_at, updated_at, expires_at)
         VALUES (?, 'ep-phone', 'notes', 'create', 'hash', 'executed',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
      )
      .run(intentId, expiresAt);
  }

  test("keeps the ledger through revocation and revokes only the parked act", async () => {
    const dir = await tempDir();
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    seedOutcome(plane, "intent-1", null);
    plane.db.vault
      .prepare(
        `INSERT INTO replica_parked_payload (invocation_id, intent_id,
           identity_json, request_sealed, command_id, command_name, reason,
           parked_at)
         VALUES ('inv-1', 'intent-1', '{}', 'sealed', 'notes.create',
                 'notes.create', 'confirm', '2026-01-01T00:00:00.000Z')`
      )
      .run();

    const retired = plane.retireReplicaDevice("ep-phone");
    // The owner can no longer approve what the revoked device asked for…
    expect(retired.parkedRevoked).toBe(1);
    // …and what the gateway already ran for it stays, so a re-paired phone's
    // replay of `intent-1` is deduped rather than executed a second time.
    expect(retired.outcomesKept).toBe(1);
  }, 30_000);

  test("sweeps the retained ledger by its own expiry", async () => {
    const dir = await tempDir();
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    seedOutcome(
      plane,
      "expired",
      new Date(Date.now() - 3_600_000).toISOString()
    );
    seedOutcome(plane, "live", new Date(Date.now() + 86_400_000).toISOString());
    plane.retireReplicaDevice("ep-phone");

    sweep(plane);

    const left = plane.db.vault
      .prepare(
        `SELECT intent_id FROM replica_intent_outcome ORDER BY intent_id`
      )
      .all() as { intent_id: string }[];
    expect(left.map((row) => row.intent_id)).toStrictEqual(["live"]);
  }, 30_000);
});
