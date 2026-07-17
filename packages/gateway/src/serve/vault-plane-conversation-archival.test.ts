// Sweep wiring for the conversation-ledger archival engine (issue #438
// decision 7): the daily archival block in `runSweep` must invoke conversation
// archival alongside journal archival and roll ONE shared journal generation
// when either engine wrote or pruned rows.

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ensureConversationLedger } from '@centraid/app-engine';
import { openVaultPlane } from './vault-plane.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const DAY_MS = 24 * 60 * 60 * 1000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-plane-conv-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function seedAgedAutomation(journal: DatabaseSync, now: number): void {
  const daysAgo = (d: number): number => now - d * DAY_MS;
  journal
    .prepare(
      `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
       VALUES ('app/digest','automation','u1','app','app/digest','Digest',?,?)`,
    )
    .run(daysAgo(200), now);
  const seedTurn = (id: string, seq: number, startedAt: number): void => {
    journal
      .prepare(
        `INSERT INTO turns (id, conversation_id, seq, trigger, ok, started_at, ended_at,
           total_input_tokens, total_output_tokens, total_cost_usd, step_count, tool_count)
         VALUES (?, 'app/digest', ?, 'scheduled', 1, ?, ?, 10, 5, 0.01, 1, 0)`,
      )
      .run(id, seq, startedAt, startedAt + 1000);
    journal
      .prepare(
        `INSERT INTO items (id, turn_id, ordinal, kind, model, input_tokens, output_tokens, ok, started_at)
         VALUES (?, ?, 0, 'step', 'm', 10, 5, 1, ?)`,
      )
      .run(`${id}-s`, id, startedAt);
  };
  seedTurn('t0', 0, daysAgo(150));
  seedTurn('t1', 1, daysAgo(140));
  seedTurn('t2', 2, daysAgo(1)); // live head — stays
}

test('the daily sweep block archives + prunes conversations and rolls one generation', async () => {
  const dir = await tempDir();
  const plane = openVaultPlane({ dir, logger: silentLogger, ownerName: 'Priya' });
  cleanups.push(() => plane.stop());
  expect(plane.walShipper).toBeDefined();

  const now = Date.now();
  ensureConversationLedger(plane.db.journal);
  seedAgedAutomation(plane.db.journal, now);

  // Count generation rolls without disturbing the shipper's state.
  let rolls = 0;
  const shipper = plane.walShipper!;
  const originalRoll = shipper.rollGeneration.bind(shipper);
  shipper.rollGeneration = ((...args: Parameters<typeof originalRoll>) => {
    rolls += 1;
    return originalRoll(...args);
  }) as typeof shipper.rollGeneration;

  // Drive one sweep (the same entry `start()` invokes; lastJournalArchivalAt
  // starts at 0 so the daily gate is open on the first pass).
  (plane as unknown as { runSweep: () => void }).runSweep();

  // Phase A wrote an archive index row (the aged contiguous range t0..t1); the
  // live head t2 stayed. On a local-only vault custody is proven immediately, so
  // phase B pruned the raw rows in the same pass.
  const archiveRows = plane.db.journal
    .prepare(`SELECT seq_from, seq_to, pruned_at FROM conversation_archive`)
    .all() as { seq_from: number; seq_to: number; pruned_at: number | null }[];
  expect(archiveRows).toHaveLength(1);
  expect(archiveRows[0]).toMatchObject({ seq_from: 0, seq_to: 1 });
  expect(archiveRows[0]!.pruned_at).not.toBeNull();

  const remaining = plane.db.journal
    .prepare(`SELECT id FROM turns WHERE conversation_id = 'app/digest' ORDER BY seq`)
    .all() as { id: string }[];
  expect(remaining.map((r) => r.id)).toEqual(['t2']);

  // A digest row now backs Insights for the pruned range.
  const digest = plane.db.journal
    .prepare(`SELECT run_count FROM conversation_digest WHERE conversation_id = 'app/digest'`)
    .get() as { run_count: number } | undefined;
  expect(digest?.run_count).toBe(2);

  // Exactly one shared journal generation roll for the whole archival block.
  expect(rolls).toBe(1);
});
