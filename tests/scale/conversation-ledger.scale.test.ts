import { rm } from 'node:fs/promises';
import path from 'node:path';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { runConversationArchival } from '../../packages/app-engine/src/conversation/archive/index.js';
import {
  countTurns,
  daysAgo,
  MemoryBlobSink,
  now,
  openTempJournal,
  seedConversation,
  seedTurn,
} from '../../packages/app-engine/src/conversation/archive/test-fixtures.js';
import { expect, onTestFinished, test } from 'vitest';

const OWNER = 'tests/scale/conversation-ledger.scale.test.ts';

test('digest, archive and custody-gated prune hold over years of history', async () => {
  const { journal, dbPath } = openTempJournal();
  onTestFinished(async () => {
    journal.close();
    await rm(path.dirname(dbPath), { recursive: true, force: true });
  });
  const conversations = 365;
  const turnsPerConversation = 20;
  journal.exec('BEGIN IMMEDIATE');
  for (let conversation = 0; conversation < conversations; conversation += 1) {
    const id = `history-${conversation}`;
    seedConversation(journal, {
      id,
      kind: 'chat',
      appId: 'history',
      updatedAt: daysAgo(365 + conversation * 4),
    });
    for (let turn = 0; turn < turnsPerConversation; turn += 1) {
      seedTurn(journal, {
        turnId: `${id}-turn-${turn}`,
        conversationId: id,
        seq: turn,
        startedAt: daysAgo(365 + conversation * 4),
        inputTokens: 20,
        outputTokens: 40,
        model: 'scale-model',
      });
    }
  }
  journal.exec('COMMIT');
  const started = performance.now();
  const result = runConversationArchival(
    { journal, blobSink: new MemoryBlobSink(), custodyProven: () => true },
    { nowMs: now, maxConversations: conversations, maxPruneSegments: conversations },
  );
  const durationMs = performance.now() - started;
  const remaining = Array.from({ length: conversations }, (_, index) =>
    countTurns(journal, `history-${index}`),
  ).reduce((sum, count) => sum + count, 0);
  // Baseline (2026-07-19, darwin arm64): ~1.8 s to digest/archive/prune 7.3k
  // turns. The stated 60 s budget is a generous CI-safe ceiling; the point is
  // that it is now ASSERTED (it was recorded but never checked, so it could
  // never fail) and thus falsifiable against a real archival-throughput regression.
  const DURATION_BUDGET_MS = 60_000;
  const passed =
    remaining === 0 &&
    result.turnsPruned === conversations * turnsPerConversation &&
    durationMs < DURATION_BUDGET_MS;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: 'Conversation archival over 7.3k turns',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: DURATION_BUDGET_MS },
      { name: 'turns pruned', value: result.turnsPruned, unit: 'turns' },
    ],
  });
  expect(result.turnsPruned).toBe(conversations * turnsPerConversation);
  expect(remaining).toBe(0);
  expect(durationMs).toBeLessThan(DURATION_BUDGET_MS);
});
