import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { rebuildMemories } from "../../packages/vault/src/enrich/memories.js";
import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/photos-memories.scale.test.ts";
const ASSET_COUNT = 50_000;
const DAY_MS = 86_400_000;
const TOTAL_DAYS = 1_090;
const ASSETS_PER_DAY = Math.ceil(ASSET_COUNT / TOTAL_DAYS);
const START = Date.parse("2024-01-01T00:00:00.000Z");
const TRIP_BLOCK_EVERY_DAYS = 40;
const TRIP_BLOCK_LENGTH_DAYS = 5;
const AWAY_PLACE_COUNT = 4;

function placeForDay(dayIndex: number): string {
  const blockPos = dayIndex % TRIP_BLOCK_EVERY_DAYS;
  if (blockPos >= TRIP_BLOCK_LENGTH_DAYS) return "home";
  return `away-${Math.floor(dayIndex / TRIP_BLOCK_EVERY_DAYS) % AWAY_PLACE_COUNT}`;
}

describe("photos-memories.scale", () => {
  test("rebuildMemories stays bounded at 50k assets over a 3-year span", async () => {
    const db = openVaultDb();
    await db.blobTransfers.close();
    onTestFinished(() => db.close());
    bootstrapVault(db, { ownerName: "Priya" });

    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, created_at) VALUES ('home', 'Home', 'home', ?)`
      )
      .run(new Date(START).toISOString());
    for (let p = 0; p < AWAY_PLACE_COUNT; p += 1) {
      db.vault
        .prepare(
          `INSERT INTO core_place (place_id, name, kind, created_at) VALUES (?, ?, NULL, ?)`
        )
        .run(`away-${p}`, `Away Place ${p}`, new Date(START).toISOString());
    }

    const insertContent = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 4096, ?)`
    );
    const insertAsset = db.vault.prepare(
      `INSERT INTO media_asset
         (asset_id, content_id, kind, captured_at, place_id, capture_group_id, favorite)
       VALUES (?, ?, 'photo', ?, ?, ?, 0)`
    );
    const insertPhash = db.vault.prepare(
      `INSERT INTO media_asset_phash (asset_id, phash, cluster_id, computed_at)
       VALUES (?, ?, ?, ?)`
    );

    const seedStarted = performance.now();
    db.vault.exec("BEGIN");
    try {
      let index = 0;
      for (let day = 0; day < TOTAL_DAYS && index < ASSET_COUNT; day += 1) {
        const place = placeForDay(day);
        const dayStart = START + day * DAY_MS;
        for (
          let inDay = 0;
          inDay < ASSETS_PER_DAY && index < ASSET_COUNT;
          inDay += 1, index += 1
        ) {
          const key = String(index).padStart(6, "0");
          const at = new Date(
            dayStart + Math.floor((inDay * DAY_MS) / ASSETS_PER_DAY)
          ).toISOString();
          const assetId = `memscale-asset-${key}`;
          const contentId = `memscale-content-${key}`;
          const captureGroupId = index % 50 === 0 ? `live-${key}` : null;
          insertContent.run(
            contentId,
            `blob:sha256-${key.padStart(64, "0")}`,
            key.padStart(64, "0"),
            at
          );
          insertAsset.run(assetId, contentId, at, place, captureGroupId);
          if (index % 200 === 0) {
            insertPhash.run(assetId, "a".repeat(16), `cluster-${key}`, at);
          } else if (index % 200 === 1) {
            const clusterKey = String(index - 1).padStart(6, "0");
            insertPhash.run(
              assetId,
              "a".repeat(16),
              `cluster-${clusterKey}`,
              at
            );
          }
        }
      }
      db.vault.exec("COMMIT");
    } catch (error) {
      db.vault.exec("ROLLBACK");
      throw error;
    }
    db.vault.exec("BEGIN");
    const updateCaptureGroup = db.vault.prepare(
      `UPDATE media_asset SET capture_group_id = ? WHERE asset_id = ?`
    );
    for (let index = 1; index < ASSET_COUNT; index += 50) {
      const companionKey = String(index).padStart(6, "0");
      const leaderKey = String(index - 1).padStart(6, "0");
      updateCaptureGroup.run(
        `live-${leaderKey}`,
        `memscale-asset-${companionKey}`
      );
    }
    db.vault.exec("COMMIT");
    const seedMs = performance.now() - seedStarted;

    const coldStarted = performance.now();
    const result = rebuildMemories(db.vault, {
      now: "2026-12-31T00:00:00.000Z",
    });
    const coldMs = performance.now() - coldStarted;

    const totalMemories = result.onThisDay + result.trips + result.similar;

    const BUDGET_MS = rigBudgetMs(OWNER);
    const drift = await rigDriftBudgetMs("scale", OWNER);
    const withinDrift = drift === null || coldMs <= drift;
    const passed =
      coldMs < BUDGET_MS &&
      result.trips > 0 &&
      result.similar > 0 &&
      result.onThisDay > 0 &&
      result.members > 0;

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Memories v0 rebuild at 50k assets over a 3-year span",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        { name: "rebuild", value: coldMs, unit: "ms", budget: BUDGET_MS },
        { name: "fixture seeding", value: seedMs, unit: "ms" },
        { name: "assets", value: ASSET_COUNT, unit: "assets" },
        {
          name: "on-this-day memories",
          value: result.onThisDay,
          unit: "memories",
        },
        { name: "trip memories", value: result.trips, unit: "memories" },
        { name: "similar memories", value: result.similar, unit: "memories" },
        { name: "total memories", value: totalMemories, unit: "memories" },
        { name: "member rows written", value: result.members, unit: "rows" },
      ],
    });

    expect(
      withinDrift,
      `sustained drift: ${coldMs}ms vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(coldMs).toBeLessThan(BUDGET_MS);
    expect(result.onThisDay).toBeGreaterThan(0);
    expect(result.trips).toBeGreaterThan(0);
    expect(result.similar).toBeGreaterThan(0);
    expect(result.members).toBeGreaterThan(0);
  });
});
