import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import {
  YEAR3_CONTACT_NEEDLE,
  YEAR3_DISTRIBUTIONS,
  YEAR3_NOTE_NEEDLE,
} from "@centraid/test-kit/year3-vault";
import { openVaultDb } from "@centraid/vault";

import { goldenYear3Vault } from "../helpers/factories.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

/**
 * DAILY-USE QUERIES AT YEAR-3 VOLUME, on the GOLDEN artifact (#927 P4).
 *
 * This rig used to seed its own corpus: 10,000 photos and 5,000 contacts
 * through the shared generator, then a thousand notes and three calendar years
 * of events written inline, with its two search needles patched in by UPDATE
 * *after* the fixture was copied. Every one of those is a declared dimension
 * of the golden year-3 vault now, which every journey rig mounts by name — so
 * a before/after number from this rig and one from a web or desktop journey
 * are numbers about the same bytes. The needles are the fixture's own
 * (`YEAR3_CONTACT_NEEDLE` / `YEAR3_NOTE_NEEDLE`), so the rig no longer writes
 * to the artifact it measures.
 *
 * The assertions are unchanged: 200 recent photos, one contact hit, 365 events
 * in the 2025 window, one note hit, and both budgets. What `seedMs` MEANS has
 * changed — it is now the cost of materializing or reusing the golden fixture
 * rather than of writing rows inline — so it is reported under its own name.
 */
const OWNER = "tests/scale/large-vault.scale.test.ts";
const SEED_BUDGET_MS = 30_000;
const READ_BUDGET_MS = 2_000;

describe("large-vault.scale", () => {
  test("10k photos, 5k contacts, three years of events, and 1k notes stay bounded", async () => {
    const started = performance.now();
    const golden = await goldenYear3Vault();
    const db = openVaultDb({ dir: golden.dir, sealKey: golden.sealKey });
    onTestFinished(() => db.close());
    const seedMs = performance.now() - started;

    const readStarted = performance.now();
    const recentPhotos = db.vault
      .prepare(
        `SELECT asset_id FROM media_asset
          WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const contactHit = db.vault
      .prepare(
        `SELECT party_id FROM fts_core_party WHERE fts_core_party MATCH ?`
      )
      .all(YEAR3_CONTACT_NEEDLE);
    const events = db.vault
      .prepare(
        `SELECT event_id FROM core_event
          WHERE dtstart >= '2025-01-01' AND dtstart < '2026-01-01'
          ORDER BY dtstart`
      )
      .all();
    const noteHit = db.vault
      .prepare(
        `SELECT note_id FROM fts_knowledge_note
          WHERE fts_knowledge_note MATCH ?`
      )
      .all(YEAR3_NOTE_NEEDLE);
    const readMs = performance.now() - readStarted;
    // #659 R4 — sustained-drift gate over this rig's own 30-sample
    // nightly history. Null until the history is deep enough; a null is
    // "no opinion yet", never a pass.
    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed =
      recentPhotos.length === 200 &&
      contactHit.length === 1 &&
      events.length === 365 &&
      noteHit.length === 1 &&
      seedMs < SEED_BUDGET_MS &&
      readMs < READ_BUDGET_MS;
    const withinDrift = drift === null || seedMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Daily-use queries on the golden year-3 vault",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "golden fixture mount",
          value: seedMs,
          unit: "ms",
          budget: SEED_BUDGET_MS,
        },
        {
          name: "combined reads",
          value: readMs,
          unit: "ms",
          budget: READ_BUDGET_MS,
        },
        {
          name: "photos",
          value: YEAR3_DISTRIBUTIONS.dailyPathPhotos,
          unit: "rows",
        },
        { name: "contacts", value: golden.profile.parties, unit: "rows" },
        {
          name: "event days",
          value: YEAR3_DISTRIBUTIONS.eventDays,
          unit: "rows",
        },
        { name: "notes", value: YEAR3_DISTRIBUTIONS.notes, unit: "rows" },
        {
          name: "receipt days",
          value: YEAR3_DISTRIBUTIONS.receiptDays,
          unit: "rows",
        },
        { name: "golden vault on disk", value: golden.bytes, unit: "bytes" },
        {
          name: "golden fixture cache hit",
          value: golden.cacheHit ? 1 : 0,
          unit: "count",
        },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${seedMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(recentPhotos).toHaveLength(200);
    expect(contactHit).toHaveLength(1);
    expect(events).toHaveLength(365);
    expect(noteHit).toHaveLength(1);
    expect(seedMs).toBeLessThan(SEED_BUDGET_MS);
    expect(readMs).toBeLessThan(READ_BUDGET_MS);
  });
});
