import { cp } from "node:fs/promises";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  seedYear3Vault,
  materializeYear3Fixture,
  year3VaultProfile,
} from "@centraid/test-kit/year3-vault";
import {
  bootstrapVault,
  openVaultDb,
  sealAad,
  sealValue,
  VAULT_MIGRATIONS,
} from "@centraid/vault";

import { ensureConversationLedger } from "../../packages/server/src/engine/stores/gateway-db.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/large-vault.scale.test.ts";
const PHOTO_COUNT = 10_000;
const CONTACT_COUNT = 5_000;
const NOTE_COUNT = 1_000;
// Calendar years 2023–2025 inclusive (2024 is the leap year).
const EVENT_DAYS = 365 + 366 + 365;
const SEED_BUDGET_MS = 30_000;
const READ_BUDGET_MS = 2_000;
const YEAR3 = year3VaultProfile();
const YEAR3_SEAL_KEY = Buffer.alloc(32, 0x67);

function id(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(5, "0")}`;
}

function sha(index: number): string {
  return index.toString(16).padStart(64, "0");
}

describe("large-vault.scale", () => {
  test("10k photos, 5k contacts, three years of events, and 1k notes stay bounded", async () => {
    const started = performance.now();
    const profile = {
      ...YEAR3,
      parties: CONTACT_COUNT,
      photos: PHOTO_COUNT,
      conversations: 10,
      turnsPerConversation: 5,
    };
    const cacheRoot =
      process.env.CENTRAID_YEAR3_CACHE_DIR ??
      (await tempDir("large-vault-year3-cache-"));
    const materialized = await materializeYear3Fixture(
      cacheRoot,
      async (target) => {
        const seeded = openVaultDb({ dir: target, sealKey: YEAR3_SEAL_KEY });
        try {
          bootstrapVault(seeded, { ownerName: "Scale owner" });
          ensureConversationLedger(seeded.journal);
          seedYear3Vault(
            {
              vault: seeded.vault,
              journal: seeded.journal,
              sealCell: (entity, column, rowId, plaintext) =>
                sealValue(
                  seeded.sealKey,
                  sealAad(entity.replace(".", "_"), column, rowId),
                  plaintext
                ),
            },
            profile
          );
        } finally {
          seeded.close();
        }
      },
      profile,
      VAULT_MIGRATIONS.length
    );
    const workingDir = await tempDir("large-vault-year3-working-");
    await cp(materialized.dir, workingDir, { recursive: true });
    const db = openVaultDb({ dir: workingDir, sealKey: YEAR3_SEAL_KEY });
    onTestFinished(() => db.close());
    const owner = db.vault
      .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
      .get() as { owner_party_id: string };
    const insertContent = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
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
    const now = "2026-07-29T00:00:00.000Z";
    db.vault
      .prepare(
        "UPDATE core_party SET display_name = 'NeedleContact' WHERE party_id = 'year3-party-004321'"
      )
      .run();
    db.vault.exec("BEGIN IMMEDIATE");
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
        `SELECT asset_id FROM media_asset
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
        { name: "year-3 photos", value: YEAR3.photos, unit: "rows" },
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
