import { cp } from "node:fs/promises";

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  materializeYear3Fixture,
  seedYear3Vault,
  year3VaultProfile,
} from "@centraid/test-kit/year3-vault";
import {
  bootstrapVault,
  openVaultDb,
  sealAad,
  sealValue,
  VAULT_MIGRATIONS,
} from "@centraid/vault";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/photos-timeline.scale.test.ts";
const PHOTO_COUNT = 50_000;
const ONE_DAY_PHOTO_COUNT = 10_000;
const SEED_BUDGET_MS = 30_000;
const PAGE_READ_BUDGET_MS = 2_000;
const ONE_DAY_READ_BUDGET_MS = 1_000;
const DAY_BUCKET_BUDGET_MS = 2_000;
const YEAR3 = year3VaultProfile();
const YEAR3_SEAL_KEY = Buffer.alloc(32, 0x50);
const ONE_DAY = "2020-06-15T00:00:00.000Z";

function id(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(6, "0")}`;
}

function sha(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(58, "0")}`.slice(0, 64);
}

describe("photos-timeline.scale", () => {
  test("50k media assets plus a 10k-one-day degenerate corpus stay bounded", async () => {
    const started = performance.now();
    const profile = {
      ...YEAR3,
      conversations: 5,
      parties: 200,
      photos: PHOTO_COUNT,
      turnsPerConversation: 3,
    };
    const cacheRoot =
      process.env.CENTRAID_YEAR3_CACHE_DIR ??
      (await tempDir("photos-timeline-year3-cache-"));
    const materialized = await materializeYear3Fixture(
      cacheRoot,
      async (target) => {
        const seeded = openVaultDb({ dir: target, sealKey: YEAR3_SEAL_KEY });
        try {
          bootstrapVault(seeded, { ownerName: "Photos scale owner" });
          seedYear3Vault(
            {
              sealCell: (entity, column, rowId, plaintext) =>
                sealValue(
                  seeded.sealKey,
                  sealAad(entity.replace(".", "_"), column, rowId),
                  plaintext
                ),
              vault: seeded.vault,
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
    const workingDir = await tempDir("photos-timeline-year3-working-");
    await cp(materialized.dir, workingDir, { recursive: true });
    const db = openVaultDb({ dir: workingDir, sealKey: YEAR3_SEAL_KEY });
    onTestFinished(() => db.close());

    const insertContent = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 4096, ?, ?)`
    );
    const insertAsset = db.vault.prepare(
      `INSERT INTO media_asset (asset_id, content_id, kind, captured_at, favorite)
       VALUES (?, ?, 'photo', ?, 0)`
    );

    const oneDayStarted = performance.now();
    db.vault.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < ONE_DAY_PHOTO_COUNT; index += 1) {
      const contentId = id("one-day-content", index);
      const at = new Date(Date.parse(ONE_DAY) + index * 6_000).toISOString();
      insertContent.run(
        contentId,
        `file:///one-day/photo-${index}.jpg`,
        sha("1", index),
        `One-day photo ${index}`,
        at
      );
      insertAsset.run(id("one-day-photo", index), contentId, at);
    }
    db.vault.exec("COMMIT");
    const oneDaySeedMs = performance.now() - oneDayStarted;
    const seedMs = performance.now() - started;

    const pageStarted = performance.now();
    const page = db.vault
      .prepare(
        `SELECT asset_id FROM media_asset
          WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const pageReadMs = performance.now() - pageStarted;

    const oneDayReadStarted = performance.now();
    const oneDayPage = db.vault
      .prepare(
        `SELECT asset_id FROM media_asset
          WHERE deleted_at IS NULL AND captured_at LIKE '2020-06-15%'
          ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const oneDayReadMs = performance.now() - oneDayReadStarted;

    const bucketStarted = performance.now();
    const dayBuckets = db.vault
      .prepare(
        `SELECT substr(captured_at, 1, 10) AS day, COUNT(*) AS n
           FROM media_asset
          WHERE deleted_at IS NULL AND captured_at IS NOT NULL
          GROUP BY day`
      )
      .all() as { day: string; n: number }[];
    const dayBucketMs = performance.now() - bucketStarted;
    const oneDayBucket = dayBuckets.find(
      (bucket) => bucket.day === "2020-06-15"
    );

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const withinDrift = drift === null || seedMs <= drift;
    const passed =
      page.length === 200 &&
      oneDayPage.length === 200 &&
      oneDayBucket?.n === ONE_DAY_PHOTO_COUNT &&
      seedMs < SEED_BUDGET_MS &&
      pageReadMs < PAGE_READ_BUDGET_MS &&
      oneDayReadMs < ONE_DAY_READ_BUDGET_MS &&
      dayBucketMs < DAY_BUCKET_BUDGET_MS;

    await recordQualityResult({
      lane: "scale",
      measurements: [
        {
          budget: SEED_BUDGET_MS,
          name: "fixture seed",
          unit: "ms",
          value: seedMs,
        },
        {
          budget: PAGE_READ_BUDGET_MS,
          name: "50k-corpus ordered page read",
          unit: "ms",
          value: pageReadMs,
        },
        {
          budget: ONE_DAY_READ_BUDGET_MS,
          name: "10k-one-day ordered page read",
          unit: "ms",
          value: oneDayReadMs,
        },
        {
          budget: DAY_BUCKET_BUDGET_MS,
          name: "day-bucket GROUP BY over the full 60k corpus",
          unit: "ms",
          value: dayBucketMs,
        },
        {
          name: "one-day degenerate corpus seed",
          unit: "ms",
          value: oneDaySeedMs,
        },
        { name: "photos", unit: "rows", value: PHOTO_COUNT },
        {
          name: "one-day photos",
          unit: "rows",
          value: ONE_DAY_PHOTO_COUNT,
        },
        {
          name: "distinct day buckets",
          unit: "rows",
          value: dayBuckets.length,
        },
      ],
      name: "50k-photo library plus a 10k-one-day degenerate corpus, at their own reads",
      owner: OWNER,
      status: passed && withinDrift ? "passed" : "failed",
    });

    expect(
      withinDrift,
      `sustained drift: ${seedMs}ms vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(page).toHaveLength(200);
    expect(oneDayPage).toHaveLength(200);
    expect(oneDayBucket?.n).toBe(ONE_DAY_PHOTO_COUNT);
    expect(seedMs).toBeLessThan(SEED_BUDGET_MS);
    expect(pageReadMs).toBeLessThan(PAGE_READ_BUDGET_MS);
    expect(oneDayReadMs).toBeLessThan(ONE_DAY_READ_BUDGET_MS);
    expect(dayBucketMs).toBeLessThan(DAY_BUCKET_BUDGET_MS);
  });
});
