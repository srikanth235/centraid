// The vault.db size ladder (#659), mirroring journal-limit's shape:
// no limit set behaves exactly like the pre-ladder daily gate, and an
// over-limit file narrows one rung per sweep down to a hard floor.

import { describe, expect, test } from "vitest";

import { bootstrapVault } from "./bootstrap.js";
import { openVaultDb } from "./db.js";
import {
  VAULT_RETENTION_DEFAULT_KEEP_DAYS,
  VAULT_RETENTION_FLOOR_KEEP_DAYS,
  decideVaultMaintenance,
  runVaultMaintenance,
  vaultFileBytes,
} from "./vault-limit.js";

const NOW = "2026-07-31T00:00:00.000Z";

describe("vault size ladder", () => {
  test("with no limit set, maintenance rides the daily gate at the widest window", () => {
    const gated = decideVaultMaintenance({
      vaultBytes: 5_000_000_000,
      limitBytes: null,
      rung: 3,
      dailyGateElapsed: false,
    });
    expect(gated).toStrictEqual({
      run: false,
      keepDays: VAULT_RETENTION_DEFAULT_KEEP_DAYS,
      nextRung: 0,
      overLimit: false,
      atFloor: false,
    });
    expect(
      decideVaultMaintenance({
        vaultBytes: 5_000_000_000,
        limitBytes: null,
        rung: 0,
        dailyGateElapsed: true,
      }).run
    ).toBe(true);
  });

  test("over the limit, the window narrows one rung per sweep and stops at the floor", () => {
    const windows: number[] = [];
    let rung = 0;
    for (let sweep = 0; sweep < 6; sweep += 1) {
      const decision = decideVaultMaintenance({
        vaultBytes: 2_000,
        limitBytes: 1_000,
        rung,
        dailyGateElapsed: false,
      });
      // The daily gate is bypassed while over the limit.
      expect(decision.run).toBe(true);
      expect(decision.overLimit).toBe(true);
      windows.push(decision.keepDays);
      rung = decision.nextRung;
    }
    expect(windows).toStrictEqual([90, 30, 14, 7, 7, 7]);
    expect(
      decideVaultMaintenance({
        vaultBytes: 2_000,
        limitBytes: 1_000,
        rung: 3,
        dailyGateElapsed: false,
      }).atFloor
    ).toBe(true);
    expect(VAULT_RETENTION_FLOOR_KEEP_DAYS).toBe(7);
  });

  test("dropping back under the limit resets the ladder to the widest rung", () => {
    const decision = decideVaultMaintenance({
      vaultBytes: 500,
      limitBytes: 1_000,
      rung: 3,
      dailyGateElapsed: true,
    });
    expect(decision.nextRung).toBe(0);
    expect(decision.keepDays).toBe(VAULT_RETENTION_DEFAULT_KEEP_DAYS);
  });

  test("an unmeasurable vault reads as zero bytes, never as over-limit", () => {
    expect(vaultFileBytes("/nonexistent-directory-for-tests")).toBe(0);
    expect(
      decideVaultMaintenance({
        vaultBytes: 0,
        limitBytes: 1,
        rung: 0,
        dailyGateElapsed: false,
      }).run
    ).toBe(false);
  });

  test("the hookpoint runs every bounded pass and reports when one was capped", () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    db.vault
      .prepare(
        `INSERT INTO core_entity_revision
           (revision_id, entity_type, entity_id, operation, snapshot_json,
            recorded_at, undo_until, undone_at, actor_party_id)
         VALUES ('rev-1', 'core.party', 'p', 'update', '{}',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z', NULL, NULL)`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO core_entity_revision
           (revision_id, entity_type, entity_id, operation, snapshot_json,
            recorded_at, undo_until, undone_at, actor_party_id)
         VALUES ('rev-2', 'core.party', 'p', 'update', '{}',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:11.000Z', NULL, NULL)`
      )
      .run();

    const capped = runVaultMaintenance(db.vault, { now: NOW, limit: 1 });
    expect(capped.revisions).toStrictEqual({ deleted: 1, capped: true });
    expect(capped.capped).toBe(true);

    const drained = runVaultMaintenance(db.vault, { now: NOW });
    expect(drained.revisions.deleted).toBe(1);
    expect(drained.capped).toBe(false);
    expect(drained.keepDays).toBe(VAULT_RETENTION_DEFAULT_KEEP_DAYS);
    db.close();
  });
});
