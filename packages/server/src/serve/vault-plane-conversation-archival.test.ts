import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultPlane } from "./vault-plane.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const DAY_MS = 24 * 60 * 60 * 1000;

const cleanups: Array<() => Promise<void> | void> = [];
describe("vault-plane-conversation-archival", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function seedAgedAutomation(journal: DatabaseSync, now: number): void {
    const daysAgo = (d: number): number => now - d * DAY_MS;
    journal
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
       VALUES ('app/digest','automation','u1','app','app/digest','Digest',?,?)`
      )
      .run(daysAgo(200), now);
    const seedTurn = (id: string, seq: number, startedAt: number): void => {
      journal
        .prepare(
          `INSERT INTO turns (id, conversation_id, seq, trigger, ok, started_at, ended_at,
           total_input_tokens, total_output_tokens, total_cost_usd, step_count, tool_count)
         VALUES (?, 'app/digest', ?, 'scheduled', 1, ?, ?, 10, 5, 0.01, 1, 0)`
        )
        .run(id, seq, startedAt, startedAt + 1000);
      journal
        .prepare(
          `INSERT INTO items (id, turn_id, ordinal, kind, model, input_tokens, output_tokens, ok, started_at)
         VALUES (?, ?, 0, 'step', 'm', 10, 5, 1, ?)`
        )
        .run(`${id}-s`, id, startedAt);
    };
    seedTurn("t0", 0, daysAgo(150));
    seedTurn("t1", 1, daysAgo(140));
    seedTurn("t2", 2, daysAgo(1)); // live head — stays
  }

  test("the daily sweep block archives + prunes conversations and rolls one generation", async () => {
    const dir = await tempDir();
    const plane = openVaultPlane({
      bootstrap: true,
      dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    expect(plane.walShipper).toBeDefined();

    const now = Date.now();
    seedAgedAutomation(plane.db.audit, now);

    let rolls = 0;
    const shipper = plane.walShipper!;
    const originalRoll = shipper.rollGeneration.bind(shipper);
    shipper.rollGeneration = ((...args: Parameters<typeof originalRoll>) => {
      rolls += 1;
      return originalRoll(...args);
    }) as typeof shipper.rollGeneration;

    (plane as unknown as { runSweep: () => void }).runSweep();

    const archiveRows = plane.db.audit
      .prepare(`SELECT seq_from, seq_to, pruned_at FROM conversation_archive`)
      .all() as {
      seq_from: number;
      seq_to: number;
      pruned_at: number | null;
    }[];
    expect(archiveRows).toHaveLength(1);
    expect(archiveRows[0]).toMatchObject({ seq_from: 0, seq_to: 1 });
    expect(archiveRows[0]!.pruned_at).not.toBeNull();

    const remaining = plane.db.audit
      .prepare(
        `SELECT id FROM turns WHERE conversation_id = 'app/digest' ORDER BY seq`
      )
      .all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toStrictEqual(["t2"]);

    const digest = plane.db.audit
      .prepare(
        `SELECT run_count FROM conversation_digest WHERE conversation_id = 'app/digest'`
      )
      .get() as { run_count: number } | undefined;
    expect(digest?.run_count).toBe(2);

    expect(rolls).toBe(1);
  });
});
