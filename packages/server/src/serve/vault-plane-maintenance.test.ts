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

    seedRevisions(plane, 5_600, new Date(Date.now() - 3_600_000).toISOString());
    sweep(plane);
    const afterFirst = revisionCount(plane);
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(5_600);

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

    seedRevisions(plane, 2, new Date(Date.now() - 3_600_000).toISOString());
    sweep(plane);
    expect(revisionCount(plane)).toBe(2);
  }, 30_000);
});
