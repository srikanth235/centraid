// Semantic photo search at a year-3 embedding index (issue #883 C2, ruling Q12).
//
// Volume table (kept with the rig, per docs/coding-standards.md):
//
//   | Axis                 | Value  | Why                                     |
//   | -------------------- | ------ | --------------------------------------- |
//   | media assets         | 90,000 | ~10 years of a heavy phone camera roll  |
//   | embeddings           | 90,000 | one `embed-image` row per asset         |
//   | vector width         |    512 | CLIP ViT-B/32 class — 184 MB of float32 |
//   | planted near matches |      8 | so a top-K answer is checkable, not luck|
//
// WHY THIS RIG EXISTS. docs/decisions.md ruled (Q12, "the vector engine for
// photo similarity"): the unbounded JS scan dies either way, SQL-side ranking
// through the already-loaded `sqlite-vec` extension is the FLOOR, and a `vec0`
// ANN index is adopted ONLY if the rig shows the SQL scan at 90k embeddings
// missing the interactive budget. "A structure that costs an index to maintain
// is earned by a measurement, not by a preference." This rig is that
// measurement, and it is what any future proposal to adopt `vec0` has to beat.
//
// TWO ENGINES, ONE ANSWER (the correctness half). `sqlite-vec`'s
// `vec_distance_cosine` and the `vault_cosine` SQL fallback must rank the same
// library the same way — the extension is an optimization, never a feature — so
// the rig asserts both find the SAME planted asset first, not merely that each
// finds something quickly.
//
// WHAT IT PUBLISHES, all against `photoSemanticSearchAtYear3` in
// tests/journeys.json, and all PER ENGINE because one rig
// duration would hide which engine regressed:
//   - `… ranked search` — the wall clock the owner waits. `ceilingMs` fences
//     the engine the gateway SHIPS; `ceilingFallbackMs` fences the degraded
//     path a host without the extension takes.
//   - `… RSS delta` — bytes the process grows across one search. Coarse by
//     construction (the budget entry's `rssCaveat` says why); what it catches
//     is a ranker that materialises the library, which is what this wave
//     deleted.
//   - `… event-loop block` — the longest interval the gateway's loop was
//     unavailable. A vault search is synchronous SQLite, so this is the honest
//     owner-facing cost: every other request on the gateway waits it out.

import { setInterval } from "node:timers";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";
import { seededRandom } from "@centraid/test-kit/random";
// Through the PACKAGE, not `packages/vault/src`: the `db` opened here is handed
// to `searchPhotosByText`, which types its parameter as `@centraid/vault`'s
// `VaultDb`. Reaching past the barrel gives the same class two declaration
// sites, and `KeyStore#protector` is private — private members are compared
// nominally, so the two `VaultDb`s are unassignable no matter how fresh `dist`
// is. One import path is the fix; rebuilding is not.
import { bootstrapVault, encodeVector, openVaultDb } from "@centraid/vault";

import { searchPhotosByText } from "../../packages/server/src/enrich/semantic-search.js";
import { loadSqliteVec } from "../../packages/server/src/enrich/sqlite-vec.js";
import { unrefTimer } from "../../packages/server/src/lib/unref-timer.js";
import { journeyCeiling } from "../helpers/journeys.js";
import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/photo-similarity.scale.test.ts";
const EMBEDDINGS = 90_000;
const DIM = 512;
const PLANTED = 8;
const MODEL = "clip-vit-b32@1";
/**
 * The interactive ceiling Q12's ruling turns on — it fences the engine the
 * gateway SHIPS, `sqlite-vec`, which every host that can load the bundled
 * extension uses. The `vault_cosine` fallback is the degraded path for a host
 * where the extension will not load, so it carries its own, openly looser
 * ceiling rather than being held to a number it cannot meet or being let off
 * a number entirely.
 */
const SEARCH_KEY = "gateway/search/year3-photos/ci-linux-x64-4c";
const CEILING_MS = journeyCeiling(
  SEARCH_KEY,
  "photoSemanticSearchAtYear3",
  "ceilingMs"
);
const CEILING_FALLBACK_MS = journeyCeiling(
  SEARCH_KEY,
  "photoSemanticSearchAtYear3",
  "ceilingFallbackMs"
);
const CEILING_RSS_BYTES = journeyCeiling(
  SEARCH_KEY,
  "photoSemanticSearchAtYear3",
  "ceilingRssDeltaBytes"
);
const CEILING_BLOCK_MS = journeyCeiling(
  SEARCH_KEY,
  "photoSemanticSearchAtYear3",
  "ceilingEventLoopBlockMs"
);
const CEILING_FALLBACK_BLOCK_MS = journeyCeiling(
  SEARCH_KEY,
  "photoSemanticSearchAtYear3",
  "ceilingFallbackEventLoopBlockMs"
);

/** A unit-length pseudo-random vector, so cosine is a real angle. */
function unitVector(random: ReturnType<typeof seededRandom>): number[] {
  const values: number[] = [];
  let norm = 0;
  for (let index = 0; index < DIM; index += 1) {
    const value = random.int(-1_000, 1_000) / 1_000;
    values.push(value);
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm || 1);
  return values.map((value) => value * scale);
}

/** `query` nudged toward itself: close enough to win, far enough to rank. */
function nearby(
  query: readonly number[],
  random: ReturnType<typeof seededRandom>,
  strength: number
): number[] {
  const values = query.map(
    (value) => value * strength + (random.int(-1_000, 1_000) / 1_000) * 0.02
  );
  const norm = Math.sqrt(
    values.reduce((total, value) => total + value * value, 0)
  );
  return values.map((value) => value / (norm || 1));
}

/** Longest interval the event loop was unavailable while `work` ran. */
async function whileWatchingTheLoop<T>(
  work: () => Promise<T> | T
): Promise<{ value: T; blockedMs: number; elapsedMs: number }> {
  let last = performance.now();
  let blockedMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    const now = performance.now();
    blockedMs = Math.max(blockedMs, now - last - 1);
    last = now;
  }, 1);
  unrefTimer(timer);
  const started = performance.now();
  try {
    const value = await work();
    const elapsedMs = performance.now() - started;
    // Wait for the sampler's next tick: the block is the gap between the last
    // callback before the synchronous work and the first after it.
    const ticksAfterWork = ticks;
    await vi.waitFor(() => {
      expect(ticks).toBeGreaterThan(ticksAfterWork);
    });
    return { value, blockedMs, elapsedMs };
  } finally {
    clearInterval(timer);
  }
}

describe("photo-similarity.scale", () => {
  test("semantic photo search stays interactive at 90k embeddings", async () => {
    const db = openVaultDb({
      loadExtensions: (handle) => void loadSqliteVec(handle),
    });
    await db.blobTransfers.close();
    onTestFinished(() => db.close());
    bootstrapVault(db, { ownerName: "Priya" });

    const random = seededRandom(883_512);
    const query = unitVector(random);
    const now = "2026-08-28T00:00:00.000Z";

    const content = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/jpeg', ?, ?, 1024, ?)`
    );
    const asset = db.vault.prepare(
      `INSERT INTO media_asset (asset_id, content_id, kind, captured_at)
       VALUES (?, ?, 'photo', ?)`
    );
    const embedding = db.vault.prepare(
      `INSERT INTO enrich_embedding
         (embedding_id, target_type, target_id, model, dim, vector, created_at)
       VALUES (?, 'media.asset', ?, ?, ?, ?, ?)`
    );

    // The planted matches sit in the MIDDLE of the insert order, so a ranker
    // that quietly reads a prefix of the table cannot pass by accident.
    const plantedAt = new Set<number>();
    for (let index = 0; index < PLANTED; index += 1)
      plantedAt.add(Math.floor(EMBEDDINGS / 2) + index * 37);
    const bestIndex = Math.floor(EMBEDDINGS / 2);

    const seedStarted = performance.now();
    db.vault.exec("BEGIN");
    try {
      for (let index = 0; index < EMBEDDINGS; index += 1) {
        const key = index.toString().padStart(6, "0");
        content.run(
          `sim-content-${key}`,
          `blob:sha256-${key.padStart(64, "0")}`,
          key.padStart(64, "0"),
          now
        );
        asset.run(`sim-asset-${key}`, `sim-content-${key}`, now);
        const vector = plantedAt.has(index)
          ? nearby(query, random, index === bestIndex ? 1 : 0.6)
          : unitVector(random);
        embedding.run(
          `sim-embedding-${key}`,
          `sim-asset-${key}`,
          MODEL,
          DIM,
          encodeVector(vector),
          now
        );
      }
      db.vault.exec("COMMIT");
    } catch (error) {
      db.vault.exec("ROLLBACK");
      throw error;
    }
    const seedMs = performance.now() - seedStarted;

    const embedQuery = async (): Promise<{
      status: "ok";
      model: string;
      vector: number[];
    }> => ({ status: "ok", model: MODEL, vector: query });

    const search = (engine: "vec" | "scan") =>
      whileWatchingTheLoop(async () => {
        const before = process.memoryUsage().rss;
        const outcome = await searchPhotosByText(db, {
          embedQuery,
          query: "a dog on a beach",
          limit: 20,
          engine,
        });
        return { outcome, rssDelta: process.memoryUsage().rss - before };
      });

    // One discarded pass per engine so neither measurement pays for the
    // other's cold page cache; the vault file is 200+ MB at this volume.
    await search("vec");
    await search("scan");

    const vec = await search("vec");
    const scan = await search("scan");

    const expectedTop = `sim-asset-${bestIndex.toString().padStart(6, "0")}`;
    const topOf = (result: typeof vec): string | undefined =>
      result.value.outcome.status === "ok"
        ? result.value.outcome.hits[0]?.assetId
        : undefined;

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const worstMs = Math.max(vec.elapsedMs, scan.elapsedMs);
    const withinDrift = drift === null || worstMs <= drift;
    const agree = topOf(vec) === expectedTop && topOf(scan) === expectedTop;
    const passed =
      agree &&
      withinDrift &&
      vec.elapsedMs < CEILING_MS &&
      scan.elapsedMs < CEILING_FALLBACK_MS &&
      vec.value.rssDelta < CEILING_RSS_BYTES &&
      scan.value.rssDelta < CEILING_RSS_BYTES &&
      vec.blockedMs < CEILING_BLOCK_MS &&
      scan.blockedMs < CEILING_FALLBACK_BLOCK_MS;

    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Semantic photo search over ${EMBEDDINGS.toLocaleString("en-US")} embeddings`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "sqlite-vec ranked search",
          value: vec.elapsedMs,
          unit: "ms",
          budget: CEILING_MS,
        },
        {
          name: "SQL cosine ranked search",
          value: scan.elapsedMs,
          unit: "ms",
          budget: CEILING_FALLBACK_MS,
        },
        {
          name: "sqlite-vec RSS delta",
          value: vec.value.rssDelta,
          unit: "bytes",
          budget: CEILING_RSS_BYTES,
        },
        {
          name: "SQL cosine RSS delta",
          value: scan.value.rssDelta,
          unit: "bytes",
          budget: CEILING_RSS_BYTES,
        },
        {
          name: "sqlite-vec event-loop block",
          value: vec.blockedMs,
          unit: "ms",
          budget: CEILING_BLOCK_MS,
        },
        {
          name: "SQL cosine event-loop block",
          value: scan.blockedMs,
          unit: "ms",
          budget: CEILING_FALLBACK_BLOCK_MS,
        },
        { name: "embeddings", value: EMBEDDINGS, unit: "rows" },
        { name: "vector width", value: DIM, unit: "floats" },
        { name: "fixture seeding", value: seedMs, unit: "ms" },
      ],
    });

    expect(
      withinDrift,
      `sustained drift: ${worstMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    // Anti-vacuity AND the two-engines-one-answer contract in one assertion:
    // an engine that returned nothing, or ranked the library differently from
    // its twin, fails here before any budget is consulted.
    expect(topOf(vec), "sqlite-vec ranked the planted match first").toBe(
      expectedTop
    );
    expect(topOf(scan), "the SQL cosine fallback agrees with sqlite-vec").toBe(
      expectedTop
    );
    // Q12's condition, asserted: the SQL sqlite-vec floor MEETS the
    // interactive ceiling at 90k embeddings, so a `vec0` ANN index stays
    // unearned. Red here is the day it is earned.
    expect(vec.elapsedMs).toBeLessThan(CEILING_MS);
    expect(scan.elapsedMs).toBeLessThan(CEILING_FALLBACK_MS);
    expect(vec.value.rssDelta).toBeLessThan(CEILING_RSS_BYTES);
    expect(scan.value.rssDelta).toBeLessThan(CEILING_RSS_BYTES);
    expect(vec.blockedMs).toBeLessThan(CEILING_BLOCK_MS);
    expect(scan.blockedMs).toBeLessThan(CEILING_FALLBACK_BLOCK_MS);
  });
});
