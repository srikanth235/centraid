// Near-duplicate clustering at a year-3 photo library (issue #659 G1/G2).
//
// Volume table (kept with the rig, per docs/coding-standards.md):
//
//   | Axis                | Value  | Why                                     |
//   | ------------------- | ------ | --------------------------------------- |
//   | media assets        | 90,000 | ~10 years of a heavy phone camera roll  |
//   | distinct phashes    | 90,000 | one per asset, 64-bit dHash (16 hex)    |
//   | near-duplicate sets | 3,000  | burst shots / re-saves — 3 members each |
//
// Before #659 the standing sweep brute-forced every pair of phashes on every
// hourly tick: ~4·10^9 hamming comparisons at this volume, synchronously, and
// then rewrote the whole `cluster_id` column whether or not anything had
// changed. This rig is what makes that unrepeatable: it drives the REAL
// gateway sweep at the volume, then drives it again with nothing changed and
// asserts the steady-state tick writes zero rows.

import { describe, expect, onTestFinished, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { seededRandom } from "@centraid/test-kit/random";

import { bootstrapVault } from "../../packages/vault/src/bootstrap.js";
import { openVaultDb } from "../../packages/vault/src/db.js";
import { recomputeDuplicateClusters } from "../../packages/vault/src/enrich/clusters.js";
import { createGateway } from "../../packages/vault/src/gateway/gateway.js";
import { rigBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/phash-clustering.scale.test.ts";
const ASSET_COUNT = 90_000;
const DUPLICATE_FAMILIES = 3_000;
const FAMILY_SIZE = 3;
const HEX = "0123456789abcdef";

describe("phash-clustering.scale", () => {
  test("the hourly cluster sweep stays bounded at 90k assets and idles for free", async () => {
    const db = openVaultDb();
    await db.blobTransfers.close();
    onTestFinished(() => db.close());
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    const gw = createGateway(db);
    const owner = {
      kind: "device" as const,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    const random = seededRandom(659_090);
    const randomHash = (): string => {
      let out = "";
      for (let i = 0; i < 16; i += 1) out += HEX[random.int(0, 15)]!;
      return out;
    };
    // A family is one seed hash plus members one nibble away (hamming ≤ 4),
    // which is what a burst of near-identical shots looks like to a dHash.
    const phashes: string[] = [];
    for (let family = 0; family < DUPLICATE_FAMILIES; family += 1) {
      const seed = randomHash();
      phashes.push(seed);
      for (let member = 1; member < FAMILY_SIZE; member += 1) {
        const chars = [...seed];
        chars[random.int(0, 15)] = HEX[random.int(0, 15)]!;
        phashes.push(chars.join(""));
      }
    }
    while (phashes.length < ASSET_COUNT) phashes.push(randomHash());

    const now = "2026-07-31T00:00:00.000Z";
    const content = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 1024, ?)`
    );
    const asset = db.vault.prepare(
      `INSERT INTO media_asset (asset_id, content_id, kind, captured_at)
       VALUES (?, ?, 'photo', ?)`
    );
    const phash = db.vault.prepare(
      `INSERT INTO media_asset_phash (asset_id, phash, computed_at) VALUES (?, ?, ?)`
    );
    const seedStarted = performance.now();
    db.vault.exec("BEGIN");
    try {
      for (const [index, value] of phashes.entries()) {
        const key = index.toString().padStart(6, "0");
        content.run(
          `scale-content-${key}`,
          `blob:sha256-${key.padStart(64, "0")}`,
          key.padStart(64, "0"),
          now
        );
        asset.run(`scale-asset-${key}`, `scale-content-${key}`, now);
        phash.run(`scale-asset-${key}`, value, now);
      }
      db.vault.exec("COMMIT");
    } catch (error) {
      db.vault.exec("ROLLBACK");
      throw error;
    }
    const seedMs = performance.now() - seedStarted;

    const totalChanges = (): number =>
      (db.vault.prepare("SELECT total_changes() AS n").get() as { n: number })
        .n;

    // Pass 1 — the cold sweep, through the real standing duty.
    const coldStarted = performance.now();
    gw.sweep(owner);
    const coldMs = performance.now() - coldStarted;

    const clustered = (
      db.vault
        .prepare(
          "SELECT count(*) AS n FROM media_asset_phash WHERE cluster_id IS NOT NULL"
        )
        .get() as { n: number }
    ).n;

    // Pass 2 — nothing changed. This is the tick that runs 23 more times a
    // day: it must neither recluster nor dirty a single WAL page.
    const changesBeforeIdle = totalChanges();
    const idleStarted = performance.now();
    gw.sweep(owner);
    const idleMs = performance.now() - idleStarted;
    const idleWrites = totalChanges() - changesBeforeIdle;

    const BUDGET_MS = rigBudgetMs(OWNER);
    const passed =
      coldMs < BUDGET_MS &&
      idleWrites === 0 &&
      clustered >= DUPLICATE_FAMILIES * FAMILY_SIZE;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: "Near-duplicate cluster sweep at 90k assets",
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "cold sweep",
          value: coldMs,
          unit: "ms",
          budget: BUDGET_MS,
        },
        { name: "idle sweep", value: idleMs, unit: "ms" },
        { name: "idle rows written", value: idleWrites, unit: "rows" },
        { name: "assets", value: ASSET_COUNT, unit: "assets" },
        { name: "clustered assets", value: clustered, unit: "assets" },
        { name: "fixture seeding", value: seedMs, unit: "ms" },
      ],
    });

    // Every seeded family clusters (its members are within the threshold), so
    // the projection is doing real work at this volume, not trivially empty.
    expect(clustered).toBeGreaterThanOrEqual(DUPLICATE_FAMILIES * FAMILY_SIZE);
    expect(coldMs).toBeLessThan(BUDGET_MS);
    // THE regression guard for G2: a no-change tick writes nothing.
    expect(idleWrites).toBe(0);

    // And one changed photo re-clusters without rewriting the column: the
    // newcomer joins a family, and only its own row moves.
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('zz-late-content', 'image/jpeg', 'blob:sha256-${"f".repeat(64)}', ?, 1024, ?)`
      )
      .run("f".repeat(64), now);
    db.vault
      .prepare(
        `INSERT INTO media_asset (asset_id, content_id, kind, captured_at)
         VALUES ('zz-late-asset', 'zz-late-content', 'photo', ?)`
      )
      .run(now);
    db.vault
      .prepare(
        `INSERT INTO media_asset_phash (asset_id, phash, computed_at) VALUES ('zz-late-asset', ?, ?)`
      )
      .run(phashes[0]!, now);

    const incremental = recomputeDuplicateClusters(db.vault);
    expect(incremental.reused).toBe(false);
    // Only the newcomer's row moved — its id sorts after every seeded id, so
    // the family keeps the cluster key it was already displaying.
    expect(incremental.updated).toBe(1);
  });
});
