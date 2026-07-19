import { tempDirSync } from '@centraid/test-kit/temp-dir';
// Digest parity (issue #438 decision 5): the numbers Insights reports must be
// identical before archive (all live run_summary rows) and after archive+prune
// (live rows + conversation_digest rollups), driven through the REAL
// InsightsStore over the same journal handle. `recent` is live-only by design,
// so this compares the aggregate surfaces the issue names: kpis, byAutomation,
// byModel.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { makeJournalDbProvider, openJournalDb } from '../../stores/gateway-db.js';
import { InsightsStore } from '../../insights/insights-store.js';
import { runConversationArchival } from './index.js';
import type { BlobSink } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysAgo = (d: number): number => now - d * DAY_MS;

class MemoryBlobSink implements BlobSink {
  private readonly store = new Set<string>();
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.store.add(sha256);
    return { sha256, byteSize: bytes.length };
  }
  has(sha: string): boolean {
    return this.store.has(sha);
  }
}

function seedFinishedTurn(
  journal: DatabaseSync,
  a: {
    turnId: string;
    conversationId: string;
    seq: number;
    startedAt: number;
    ok?: boolean;
    retryOf?: string | null;
    input: number;
    output: number;
    cost: number;
    steps: number;
    tools: number;
    model: string;
  },
): void {
  journal
    .prepare(
      `INSERT INTO turns (id, conversation_id, seq, trigger, retry_of, ok, started_at, ended_at,
         total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens,
         total_cost_usd, step_count, tool_count)
       VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    )
    .run(
      a.turnId,
      a.conversationId,
      a.seq,
      a.retryOf ?? null,
      a.ok === false ? 0 : 1,
      a.startedAt,
      a.startedAt + 1000,
      a.input,
      a.output,
      a.cost,
      a.steps,
      a.tools,
    );
  // Two step items so the dominant-model pick is exercised: the model under
  // test carries the bulk of the tokens; a decoy model carries fewer.
  journal
    .prepare(
      `INSERT INTO items (id, turn_id, ordinal, kind, model, input_tokens, output_tokens, ok, started_at)
       VALUES (?, ?, 0, 'step', ?, ?, ?, 1, ?)`,
    )
    .run(`${a.turnId}-s0`, a.turnId, a.model, a.input, a.output, a.startedAt);
  journal
    .prepare(
      `INSERT INTO items (id, turn_id, ordinal, kind, model, input_tokens, output_tokens, ok, started_at)
       VALUES (?, ?, 1, 'step', 'decoy', 1, 0, 1, ?)`,
    )
    .run(`${a.turnId}-s1`, a.turnId, a.startedAt);
}

describe('digest parity with pre-archive rollups', () => {
  it('kpis / byAutomation / byModel are identical before archive and after prune', () => {
    const dir = tempDirSync('centraid-digest-parity-');
    const dbPath = path.join(dir, 'journal.db');
    const journal = openJournalDb(dbPath);
    const blobSink = new MemoryBlobSink();

    // Two automation threads + one chat thread, all with aged runs. Automation
    // threads keep their newest turn live (stays in run_summary); chat archives
    // whole. Cross-model, cross-status, with a retry.
    journal
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
         VALUES ('app/digest','automation','u1','app','app/digest','Morning digest',?,?)`,
      )
      .run(daysAgo(200), now);
    journal
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
         VALUES ('app/sync','automation','u1','app','app/sync','Nightly sync',?,?)`,
      )
      .run(daysAgo(200), now);
    journal
      .prepare(
        `INSERT INTO conversations (id, kind, user_id, app_id, automation_id, title, created_at, updated_at)
         VALUES ('chat1','chat','u1','app',NULL,'A chat',?,?)`,
      )
      .run(daysAgo(200), daysAgo(120));

    seedFinishedTurn(journal, {
      turnId: 'd0',
      conversationId: 'app/digest',
      seq: 0,
      startedAt: daysAgo(150),
      input: 100,
      output: 50,
      cost: 0.02,
      steps: 2,
      tools: 1,
      model: 'sonnet',
    });
    seedFinishedTurn(journal, {
      turnId: 'd1',
      conversationId: 'app/digest',
      seq: 1,
      startedAt: daysAgo(140),
      input: 200,
      output: 40,
      cost: 0.03,
      steps: 3,
      tools: 0,
      model: 'opus',
      ok: false,
    });
    seedFinishedTurn(journal, {
      turnId: 'd2',
      conversationId: 'app/digest',
      seq: 2,
      startedAt: daysAgo(130),
      input: 80,
      output: 20,
      cost: 0.01,
      steps: 1,
      tools: 2,
      model: 'sonnet',
      retryOf: 'd1',
    });
    seedFinishedTurn(journal, {
      turnId: 'd3',
      conversationId: 'app/digest',
      seq: 3,
      startedAt: daysAgo(2),
      input: 10,
      output: 5,
      cost: 0.001,
      steps: 1,
      tools: 0,
      model: 'sonnet',
    }); // live head

    seedFinishedTurn(journal, {
      turnId: 's0',
      conversationId: 'app/sync',
      seq: 0,
      startedAt: daysAgo(160),
      input: 300,
      output: 100,
      cost: 0.05,
      steps: 4,
      tools: 3,
      model: 'opus',
    });
    seedFinishedTurn(journal, {
      turnId: 's1',
      conversationId: 'app/sync',
      seq: 1,
      startedAt: daysAgo(1),
      input: 20,
      output: 8,
      cost: 0.002,
      steps: 1,
      tools: 0,
      model: 'opus',
    }); // live head

    seedFinishedTurn(journal, {
      turnId: 'c0',
      conversationId: 'chat1',
      seq: 0,
      startedAt: daysAgo(150),
      input: 60,
      output: 30,
      cost: 0.015,
      steps: 2,
      tools: 1,
      model: 'sonnet',
    });
    seedFinishedTurn(journal, {
      turnId: 'c1',
      conversationId: 'chat1',
      seq: 1,
      startedAt: daysAgo(140),
      input: 40,
      output: 10,
      cost: 0.005,
      steps: 1,
      tools: 0,
      model: 'haiku',
    });

    const insights = new InsightsStore(makeJournalDbProvider(dbPath));
    // A window wide enough to include every aged run in BOTH the live and the
    // digest arms (their span reaches back ~160d).
    const opts = { windowDays: 400 };
    const before = insights.summary(opts);

    const r = runConversationArchival(
      { journal, blobSink, custodyProven: () => true },
      { nowMs: now },
    );
    expect(r.segmentsWritten).toBeGreaterThan(0);
    expect(r.turnsPruned).toBeGreaterThan(0);
    // Confirm raw archived rows are actually gone (Insights now leans on digests).
    expect((journal.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n).toBe(2); // the two live heads

    const after = insights.summary(opts);

    expect(after.kpis.totalTokens).toBe(before.kpis.totalTokens);
    expect(after.kpis.totalCostUsd).toBe(before.kpis.totalCostUsd);
    expect(after.kpis.generations).toBe(before.kpis.generations);
    expect(after.kpis.retries).toBe(before.kpis.retries);
    expect(after.kpis.appsTouched).toBe(before.kpis.appsTouched);

    const norm = <T extends { key?: string; model?: string }>(rows: T[]): T[] =>
      [...rows].sort((a, b) => `${a.key ?? a.model}`.localeCompare(`${b.key ?? b.model}`));
    expect(norm(after.byAutomation)).toEqual(norm(before.byAutomation));
    expect(norm(after.byModel)).toEqual(norm(before.byModel));
    journal.close();
  });
});
