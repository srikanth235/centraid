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

import { ensureConversationLedger } from "../../packages/server/src/engine/stores/gateway-db.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

// Photos-specific companion to large-vault.scale.test.ts (issue #721 C1):
// that rig proves the whole-vault "daily use" mix stays bounded at 10k
// photos alongside contacts/events/notes. This rig isolates the Photos
// surface at 5x that volume — the media asset queries a native replica
// bootstrap and timeline cold-load actually issue — and adds a SECOND,
// DEGENERATE corpus (10k captures on one calendar day) because "spread
// evenly over 3 years" and "all shot at a wedding in one afternoon" stress
// the same captured_at index in opposite ways: the first is wide and
// shallow, the second is one bucket, deep. The near-duplicate phash sweep
// itself is already owned, at real volume, by phash-clustering.scale.test.ts
// (90k assets through the live gateway sweep) — this rig does not repeat it.
// `sectionPhotoAssets` itself (apps/mobile) is proven at the same
// 10k-one-day volume by
// apps/mobile/src/apps/photos/timeline-10k-one-day.test.ts; this rig only
// owns the VAULT-side cost, since tests/scale cannot import a different
// workspace's app code.
const OWNER = "tests/scale/photos-timeline.scale.test.ts";
const PHOTO_COUNT = 50_000;
const ONE_DAY_PHOTO_COUNT = 10_000;
const SEED_BUDGET_MS = 30_000;
const PAGE_READ_BUDGET_MS = 2_000;
const ONE_DAY_READ_BUDGET_MS = 1_000;
const DAY_BUCKET_BUDGET_MS = 2_000;
const YEAR3 = year3VaultProfile();
const YEAR3_SEAL_KEY = Buffer.alloc(32, 0x50);
// Outside year3's own 2023-01-01..~2025-12-31 multiYearStart window, so the
// degenerate one-day corpus cannot collide with a seeded row's own day.
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
      // Small everywhere else so seed time is dominated by the Photos
      // surface this rig exists to measure, not by contacts/events/notes
      // large-vault.scale.test.ts already owns.
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
          ensureConversationLedger(seeded.journal);
          seedYear3Vault(
            {
              journal: seeded.journal,
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

    // The degenerate one-day corpus. Seeded and timed separately from the
    // year-3 photos above: this is a distinct distribution, not more of the
    // same one, and its own seed cost is worth recording on its own line.
    const oneDayStarted = performance.now();
    db.vault.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < ONE_DAY_PHOTO_COUNT; index += 1) {
      const contentId = id("one-day-content", index);
      // 6s apart: 10,000 * 6s ≈ 16.7h, safely inside one calendar day.
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

    // Query 1: the ordered page a replica bootstrap / timeline cold-load
    // actually issues (large-vault.scale.test.ts's own recentPhotos query),
    // over 5x its photo volume.
    const pageStarted = performance.now();
    const page = db.vault
      .prepare(
        `SELECT asset_id FROM media_asset
          WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const pageReadMs = performance.now() - pageStarted;

    // Query 2: the SAME ordered page, restricted to the one-day corpus alone
    // — every row shares the date's first 10 characters, so a captured_at
    // index that only pays off on high-cardinality prefixes would show up
    // here as a scan, not a seek.
    const oneDayReadStarted = performance.now();
    const oneDayPage = db.vault
      .prepare(
        `SELECT asset_id FROM media_asset
          WHERE deleted_at IS NULL AND captured_at LIKE '2020-06-15%'
          ORDER BY captured_at DESC LIMIT 200`
      )
      .all();
    const oneDayReadMs = performance.now() - oneDayReadStarted;

    // Query 3: the vault-side equivalent of the mobile timeline's own
    // day-grouping (apps/mobile's sectionPhotoAssets buckets by day in JS;
    // this is the same bucketing pushed into SQL) over the FULL corpus —
    // 60k rows spanning both the wide year-3 spread and the one-day spike.
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
