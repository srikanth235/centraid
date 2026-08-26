/**
 * Complements digest-parity (Insights union): `archiveRange` +
 * `readArchivedConversationSegment` round-trip, and `conversation_digest`
 * accretion.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { archiveRange, readArchivedConversationSegment } from "./segment.js";
import type { EligibleRange } from "./selector.js";
import {
  MemoryBlobSink,
  daysAgo,
  now,
  openTempJournal,
  seedConversation,
  seedTurn,
} from "./test-fixtures.js";

describe("archiveRange + readArchivedConversationSegment", () => {
  it("gzips turns/items into the CAS, indexes conversation_archive, and folds digest", () => {
    const { journal } = openTempJournal();
    const blobSink = new MemoryBlobSink();
    seedConversation(journal, {
      id: "app/digest",
      kind: "automation",
      automationId: "app/digest",
      appId: "app",
      title: "Morning digest",
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: "t0",
      conversationId: "app/digest",
      seq: 0,
      startedAt: daysAgo(120),
      inputTokens: 100,
      outputTokens: 50,
      hydrationTokens: 24,
      costUsd: 0.02,
      stepCount: 2,
      toolCount: 1,
      model: "gpt-test",
      effort: "high",
      ok: true,
    });
    seedTurn(journal, {
      turnId: "t1",
      conversationId: "app/digest",
      seq: 1,
      startedAt: daysAgo(119),
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      stepCount: 1,
      toolCount: 0,
      model: "gpt-test",
      effort: "high",
      ok: false,
    });

    const turns = journal
      .prepare(
        `SELECT * FROM turns WHERE conversation_id = ? AND id IN ('t0','t1') ORDER BY seq`
      )
      .all("app/digest") as EligibleRange["turns"];
    const conv = journal
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get("app/digest") as Record<string, unknown>;
    const range: EligibleRange = {
      conversationId: "app/digest",
      kind: "automation",
      seqFrom: 0,
      seqTo: 1,
      turns,
    };

    const result = archiveRange(journal, blobSink, conv, range, now);
    expect(result.turnCount).toBe(2);
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.segmentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(blobSink.has(result.segmentSha256)).toBe(true);

    const bytes = blobSink.get(result.segmentSha256)!;
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      result.segmentSha256
    );
    const segment = readArchivedConversationSegment(bytes);
    expect(segment.conversationId).toBe("app/digest");
    expect(segment.seqFrom).toBe(0);
    expect(segment.seqTo).toBe(1);
    expect(segment.turns).toHaveLength(2);
    expect(segment.items).toHaveLength(result.itemCount);

    const archive = journal
      .prepare(
        `SELECT turn_count, item_count, segment_sha256, pruned_at FROM conversation_archive WHERE conversation_id = ?`
      )
      .get("app/digest") as {
      turn_count: number;
      item_count: number;
      segment_sha256: string;
      pruned_at: number | null;
    };
    expect(archive.turn_count).toBe(2);
    expect(archive.item_count).toBe(result.itemCount);
    expect(archive.segment_sha256).toBe(result.segmentSha256);
    expect(archive.pruned_at).toBeNull();

    // Digest fold: ok + err counts, token/cost sums — Insights reads these after prune.
    const digest = journal
      .prepare(
        `SELECT run_count, ok_count, err_count, total_input_tokens, total_output_tokens,
                total_hydration_tokens, total_cost_usd, step_count, tool_count, app_id, automation_ref, models_json,
                efforts_json
           FROM conversation_digest WHERE conversation_id = ?`
      )
      .get("app/digest") as {
      run_count: number;
      ok_count: number;
      err_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_hydration_tokens: number;
      total_cost_usd: number;
      step_count: number;
      tool_count: number;
      app_id: string;
      automation_ref: string;
      models_json: string;
      efforts_json: string;
    };
    expect(digest.run_count).toBe(2);
    expect(digest.ok_count).toBe(1);
    expect(digest.err_count).toBe(1);
    expect(digest.total_input_tokens).toBe(110);
    expect(digest.total_output_tokens).toBe(55);
    expect(digest.total_hydration_tokens).toBe(24);
    expect(digest.total_cost_usd).toBeCloseTo(0.03, 8);
    expect(digest.step_count).toBe(3);
    expect(digest.tool_count).toBe(1);
    expect(digest.app_id).toBe("app");
    expect(digest.automation_ref).toBe("app/digest");
    const models = JSON.parse(digest.models_json) as {
      model: string;
      runs: number;
    }[];
    expect(models.some((m) => m.model === "gpt-test" && m.runs === 2)).toBe(
      true
    );
    const efforts = JSON.parse(digest.efforts_json) as {
      effort: string;
      runs: number;
      tokens: number;
      cost: number;
    }[];
    expect(efforts).toHaveLength(1);
    expect(efforts[0]).toMatchObject({ effort: "high", runs: 2, tokens: 165 });
    expect(efforts[0]!.cost).toBeCloseTo(0.03, 8);

    journal.close();
  });

  it("throws when the blob sink claims ingest but has() is false", () => {
    const { journal } = openTempJournal();
    seedConversation(journal, {
      id: "chat1",
      kind: "chat",
      appId: "app",
      updatedAt: now,
    });
    seedTurn(journal, {
      turnId: "t0",
      conversationId: "chat1",
      seq: 0,
      startedAt: daysAgo(100),
      model: "m",
    });
    const turns = journal
      .prepare(`SELECT * FROM turns WHERE conversation_id = ?`)
      .all("chat1") as EligibleRange["turns"];
    const conv = journal
      .prepare(`SELECT * FROM conversations WHERE id = ?`)
      .get("chat1") as Record<string, unknown>;

    const brokenSink = {
      ingestSync: (bytes: Buffer) => ({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
      }),
      has: () => false,
    };

    expect(() =>
      archiveRange(
        journal,
        brokenSink,
        conv,
        { conversationId: "chat1", kind: "chat", seqFrom: 0, seqTo: 0, turns },
        now
      )
    ).toThrow(/did not land in the blob CAS/u);
    journal.close();
  });
});
