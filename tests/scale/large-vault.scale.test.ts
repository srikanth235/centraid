import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { createTestVault } from "../helpers/factories.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/large-vault.scale.test.ts";
const PHOTO_COUNT = 10_000;
const CONTACT_COUNT = 5_000;
const NOTE_COUNT = 1_000;
// Calendar years 2023–2025 inclusive (2024 is the leap year).
const EVENT_DAYS = 365 + 366 + 365;
const SEED_BUDGET_MS = 30_000;
const READ_BUDGET_MS = 2_000;

function id(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(5, "0")}`;
}

function sha(index: number): string {
  return index.toString(16).padStart(64, "0");
}

describe("large-vault.scale", () => {
  test("10k photos, 5k contacts, three years of events, and 1k notes stay bounded", async () => {
    const db = await createTestVault();
    const owner = db.vault
      .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
      .get() as { owner_party_id: string };
    const insertParty = db.vault.prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, created_at, updated_at,
          ontology_version)
       VALUES (?, 'person', ?, ?, ?, 'v0')`
    );
    const insertContent = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertAsset = db.vault.prepare(
      `INSERT INTO media_media_asset
         (asset_id, content_id, kind, captured_at, favorite)
       VALUES (?, ?, 'photo', ?, ?)`
    );
    const insertEvent = db.vault.prepare(
      `INSERT INTO core_event
         (event_id, summary, dtstart, start_tz, status, sequence, created_at,
          updated_at)
       VALUES (?, ?, ?, 'UTC', 'confirmed', 0, ?, ?)`
    );
    const insertNote = db.vault.prepare(
      `INSERT INTO knowledge_note
         (note_id, author_party_id, title, body_content_id, format, pinned,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'markdown', ?, ?, ?)`
    );
    const started = performance.now();
    const now = "2026-07-29T00:00:00.000Z";
    db.vault.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < CONTACT_COUNT; index += 1) {
      insertParty.run(
        id("scale-party", index),
        index === 4_321 ? "NeedleContact" : `Scale person ${index}`,
        now,
        now
      );
    }
    for (let index = 0; index < PHOTO_COUNT; index += 1) {
      const contentId = id("scale-photo-content", index);
      const at = new Date(Date.UTC(2026, 6, 29) - index * 60_000).toISOString();
      insertContent.run(
        contentId,
        "image/jpeg",
        `file:///scale/photo-${index}.jpg`,
        sha(index + 1),
        256_000 + (index % 100),
        `Scale photo ${index}`,
        at
      );
      insertAsset.run(
        id("scale-photo", index),
        contentId,
        at,
        index % 20 === 0 ? 1 : 0
      );
    }
    for (let index = 0; index < EVENT_DAYS; index += 1) {
      const at = new Date(
        Date.UTC(2023, 0, 1) + index * 86_400_000
      ).toISOString();
      insertEvent.run(
        id("scale-event", index),
        `Scale event ${index}`,
        at,
        at,
        at
      );
    }
    for (let index = 0; index < NOTE_COUNT; index += 1) {
      const contentId = id("scale-note-content", index);
      const body =
        index === 777
          ? "needlebrief appears in this bounded note"
          : `Scale note body ${index}`;
      insertContent.run(
        contentId,
        "text/markdown",
        `data:text/markdown,${encodeURIComponent(body)}`,
        sha(PHOTO_COUNT + index + 1),
        body.length,
        `Scale note body ${index}`,
        now
      );
      insertNote.run(
        id("scale-note", index),
        owner.owner_party_id,
        `Scale note ${index}`,
        contentId,
        index % 50 === 0 ? 1 : 0,
        now,
        now
      );
    }
    db.vault.exec("COMMIT");
    const seedMs = performance.now() - started;

    const readStarted = performance.now();
    const recentPhotos = db.vault
      .prepare(
        `SELECT asset_id FROM media_media_asset
          WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const contactHit = db.vault
      .prepare(
        `SELECT party_id FROM fts_core_party
          WHERE fts_core_party MATCH 'NeedleContact'`
      )
      .all();
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
          WHERE fts_knowledge_note MATCH 'needlebrief'`
      )
      .all();
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
      name: "Daily-use queries on the readiness large-vault fixture",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "fixture seed",
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
        { name: "photos", value: PHOTO_COUNT, unit: "rows" },
        { name: "contacts", value: CONTACT_COUNT, unit: "rows" },
        { name: "event days", value: EVENT_DAYS, unit: "rows" },
        { name: "notes", value: NOTE_COUNT, unit: "rows" },
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
