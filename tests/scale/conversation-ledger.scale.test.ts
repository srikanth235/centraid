import { rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { runConversationArchival } from "../../packages/server/src/engine/conversation/archive/index.js";
import {
  countTurns,
  daysAgo,
  MemoryBlobSink,
  now,
  openTempJournal,
  seedConversation,
  seedTurn,
} from "../../packages/server/src/engine/conversation/archive/test-fixtures.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/conversation-ledger.scale.test.ts";

describe("conversation-ledger.scale", () => {
  test("digest, archive and custody-gated prune hold over years of history", async () => {
    const { journal, dbPath } = openTempJournal();
    onTestFinished(async () => {
      journal.close();
      await rm(path.dirname(dbPath), { recursive: true, force: true });
    });
    const conversations = 365;
    const turnsPerConversation = 20;
    journal.exec("BEGIN IMMEDIATE");
    for (
      let conversation = 0;
      conversation < conversations;
      conversation += 1
    ) {
      const id = `history-${conversation}`;
      seedConversation(journal, {
        id,
        kind: "chat",
        appId: "history",
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
          model: "scale-model",
        });
      }
    }
    journal.exec("COMMIT");
    const started = performance.now();
    const result = runConversationArchival(
      { journal, blobSink: new MemoryBlobSink(), custodyProven: () => true },
      {
        nowMs: now,
        maxConversations: conversations,
        maxPruneSegments: conversations,
      }
    );
    const durationMs = performance.now() - started;
    const remaining = Array.from({ length: conversations }, (_, index) =>
      countTurns(journal, `history-${index}`)
    ).reduce((sum, count) => sum + count, 0);
    const DURATION_BUDGET_MS = 60_000;
    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed =
      remaining === 0 &&
      result.turnsPruned === conversations * turnsPerConversation &&
      durationMs < DURATION_BUDGET_MS;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Conversation archival over 7.3k turns",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          budget: DURATION_BUDGET_MS,
        },
        { name: "turns pruned", value: result.turnsPruned, unit: "turns" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(result.turnsPruned).toBe(conversations * turnsPerConversation);
    expect(remaining).toBe(0);
    expect(durationMs).toBeLessThan(DURATION_BUDGET_MS);
  });
});
