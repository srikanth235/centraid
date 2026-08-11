// Semantic search (issue #721 E3) — the property that matters most is PARITY:
// a vault whose handle loaded sqlite-vec and one whose handle did not must
// answer the same query with the same photographs in the same order. If they
// ever diverge, the extension has stopped being an optimization and become a
// feature the fifth platform does not have.
//
// The query vector comes from the embed-text automation; this pure ranker suite
// injects that awaited automation result.

import { describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import {
  bootstrapVault,
  createGateway,
  encodeVector,
  nowIso,
  openVaultDb,
  registerMediaCommands,
  uuidv7,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { searchPhotosByText } from "./semantic-search.js";
import { hasSqliteVec, loadSqliteVec } from "./sqlite-vec.js";

/** The fake advertises this for `embed-image`; it is the index's key. */
const MODEL = "fake-clip@1";

const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
];

/**
 * Hand-planted vectors, chosen so the ranking is obvious by inspection: the
 * query below is `[1, 0]`, so the closer a vector leans on its first axis the
 * higher it ranks — beach, then park, then night.
 */
const PLANTED: readonly (readonly [string, number[]])[] = [
  ["beach", [1, 0]],
  ["park", [0.7, 0.7]],
  ["night", [0, 1]],
];

const QUERY_VECTOR = [1, 0];

/** Awaited embed-text automation result for one planted query vector. */
const embedQuery =
  (vector: readonly number[] = QUERY_VECTOR) =>
  async () => ({
    status: "ok" as const,
    model: MODEL,
    vector: [...vector],
  });

interface Planted {
  db: VaultDb;
  /** Asset ids in planted order (beach, park, night). */
  assetIds: string[];
}

/** A vault carrying the three planted photographs, with or without sqlite-vec. */
function plantedVault(options: { withVec: boolean }): Planted {
  const db = options.withVec
    ? openVaultDb({ loadExtensions: (handle) => void loadSqliteVec(handle) })
    : openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Priya" });
  const gw = createGateway(db);
  registerMediaCommands(gw);
  const owner = {
    kind: "device" as const,
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  const assetIds = PLANTED.map(([, vector], index) => {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PIXELS[index] },
      purpose: "dpv:ServiceProvision",
    });
    const assetId = (
      outcome as { status: "executed"; output: { asset_id: string } }
    ).output.asset_id;
    db.vault
      .prepare(
        `INSERT INTO enrich_embedding
           (embedding_id, target_type, target_id, model, dim, vector, created_at)
         VALUES (?, 'media.media_asset', ?, ?, ?, ?, ?)`
      )
      .run(
        uuidv7(),
        assetId,
        MODEL,
        vector.length,
        encodeVector(vector),
        nowIso()
      );
    return assetId;
  });
  return { db, assetIds };
}

describe("semantic-search", () => {
  test("an unavailable embed-text automation is honest absence", async () => {
    const { db } = plantedVault({ withVec: false });
    const outcome = await searchPhotosByText(db, {
      embedQuery: async () => ({
        status: "unavailable",
        reason: "embed-text automation unavailable",
      }),
      query: "a dog on a beach",
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome).toStrictEqual(
      expect.objectContaining({
        reason: expect.stringContaining("embed-text automation"),
      })
    );
    db.close();
  });

  test("an empty index is unavailable, not an empty result", async () => {
    const db = openVaultDb();
    bootstrapVault(db, { ownerName: "Priya" });
    const outcome = await searchPhotosByText(db, {
      embedQuery: embedQuery(),
      query: "anything",
    });
    expect(outcome.status).toBe("unavailable");
    db.close();
  });

  test("an embed-text automation that cannot run is unavailable", async () => {
    const { db } = plantedVault({ withVec: false });
    const outcome = await searchPhotosByText(db, {
      embedQuery: async () => ({
        status: "unavailable",
        reason: "embed-text automation is disabled",
      }),
      query: "a wide sunny shore",
    });
    expect(outcome).toStrictEqual(
      expect.objectContaining({
        reason: expect.stringContaining("embed-text"),
      })
    );
    db.close();
  });

  test("a failed embed-text run is a failure, not an absence", async () => {
    const { db } = plantedVault({ withVec: false });
    await expect(
      searchPhotosByText(db, {
        embedQuery: async () => {
          throw new Error("the model crashed");
        },
        query: "a wide sunny shore",
      })
    ).rejects.toThrow(/the model crashed/u);
    db.close();
  });

  test("hits come back ordered by score, best first", async () => {
    const { db, assetIds } = plantedVault({ withVec: false });
    const outcome = await searchPhotosByText(db, {
      embedQuery: embedQuery(),
      query: "a wide sunny shore",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.model).toBe(MODEL);
    expect(outcome.hits.map((hit) => hit.assetId)).toStrictEqual(assetIds);
    expect(outcome.hits[0]!.score).toBeCloseTo(1, 5);
    expect(outcome.hits[2]!.score).toBeCloseTo(0, 5);
    // Every hit carries the content id the photo surface needs for bytes.
    for (const hit of outcome.hits) expect(hit.contentId).toMatch(/\S/u);
    db.close();
  });

  test("the vec ranker and the exact scan agree on the same fixture", async () => {
    const withVec = plantedVault({ withVec: true });
    const withoutVec = plantedVault({ withVec: false });
    // The whole test rests on the two handles genuinely differing; if the
    // platform has no extension there is nothing to compare and saying so is
    // better than a green run that proved nothing.
    expect(hasSqliteVec(withVec.db.vault)).toBe(true);
    expect(hasSqliteVec(withoutVec.db.vault)).toBe(false);

    await forEachSequentially(
      [
        [1, 0],
        [0, 1],
        [0.6, 0.8],
        [-1, 0],
      ],
      async (query) => {
        const vec = await searchPhotosByText(withVec.db, {
          embedQuery: embedQuery(query),
          query: "same phrase either way",
        });
        const scan = await searchPhotosByText(withoutVec.db, {
          embedQuery: embedQuery(query),
          query: "same phrase either way",
        });
        if (vec.status !== "ok" || scan.status !== "ok")
          throw new Error("both rankers must answer");
        // Ids are per-vault, so compare by PLANTED order (the two vaults plant
        // the same three photographs in the same sequence).
        const label = (hits: typeof vec.hits, ids: string[]): string[] =>
          hits.map((hit) => PLANTED[ids.indexOf(hit.assetId)]![0]);
        expect(label(vec.hits, withVec.assetIds)).toStrictEqual(
          label(scan.hits, withoutVec.assetIds)
        );
        vec.hits.forEach((hit, index) => {
          expect(hit.score).toBeCloseTo(scan.hits[index]!.score, 5);
        });
      }
    );
    withVec.db.close();
    withoutVec.db.close();
  });

  test("both rankers leave trashed photographs out", async () => {
    await forEachSequentially([true, false], async (withVec) => {
      const planted = plantedVault({ withVec });
      planted.db.vault
        .prepare(
          "UPDATE media_media_asset SET deleted_at = ? WHERE asset_id = ?"
        )
        .run(nowIso(), planted.assetIds[0]!);
      const outcome = await searchPhotosByText(planted.db, {
        embedQuery: embedQuery(),
        query: "a wide sunny shore",
      });
      if (outcome.status !== "ok") throw new Error("unreachable");
      expect(outcome.hits.map((hit) => hit.assetId)).toStrictEqual(
        planted.assetIds.slice(1)
      );
      planted.db.close();
    });
  });

  test("a row whose model has a different width cannot turn a search into an error", async () => {
    const planted = plantedVault({ withVec: true });
    // A leftover row from a wider model, same model key — the shape that makes
    // `vec_distance_cosine` raise if the width guard is missing.
    planted.db.vault
      .prepare(
        `INSERT INTO enrich_embedding
           (embedding_id, target_type, target_id, model, dim, vector, created_at)
         VALUES (?, 'media.media_asset', ?, ?, 3, ?, ?)`
      )
      .run(
        uuidv7(),
        "orphan-wide-asset",
        MODEL,
        encodeVector([0.1, 0.2, 0.3]),
        nowIso()
      );
    const outcome = await searchPhotosByText(planted.db, {
      embedQuery: embedQuery(),
      query: "a wide sunny shore",
    });
    expect(outcome.status).toBe("ok");
    planted.db.close();
  });

  test("limit is honoured and clamped", async () => {
    const { db, assetIds } = plantedVault({ withVec: false });
    const one = await searchPhotosByText(db, {
      embedQuery: embedQuery(),
      query: "a wide sunny shore",
      limit: 1,
    });
    if (one.status !== "ok") throw new Error("unreachable");
    expect(one.hits.map((hit) => hit.assetId)).toStrictEqual([assetIds[0]]);

    const zero = await searchPhotosByText(db, {
      embedQuery: embedQuery(),
      query: "a wide sunny shore",
      limit: 0,
    });
    if (zero.status !== "ok") throw new Error("unreachable");
    expect(zero.hits).toHaveLength(1);
    db.close();
  });
});
