// The photo embedding indexer (issue #721 E2) — behaviour, not mechanism: what
// a pass claims, what it writes, what it drains, what it refuses, and that a
// killed gateway resumes because the queue is the database.

import { describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  bootstrapVault,
  createGateway,
  decodeVector,
  nowIso,
  openVaultDb,
  registerEnrichCommands,
  registerMediaCommands,
  shaOfBlobUri,
  uuidv7,
} from "@centraid/vault";
import type { Credential, VaultDb } from "@centraid/vault";

import type { Embedder } from "./embedder.js";
import { resolveEmbedder } from "./embedder.js";
import { stubVectorFor, writeStubEmbedder } from "./embedder.test-fixtures.js";
import { runPhotoEmbeddingSweep } from "./photo-embeddings.js";

const MODEL = "test-clip@1";

/** Distinct pixel data URIs so each mints its OWN asset (sha256 differs). */
const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
];

interface Fixture {
  db: VaultDb;
  owner: Credential;
  /** Add an asset and give it a `variant` derivative holding `bytes`. */
  addAsset: (
    index: number,
    variant: "thumb" | "preview",
    bytes: Buffer
  ) => string;
  /** Add an asset with NO derivative at all. */
  addBareAsset: (index: number) => string;
  originalBytesOf: (assetId: string) => Buffer;
}

function fixture(tier: "off" | "device" | "gateway" = "gateway"): Fixture {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Priya" });
  const gw = createGateway(db);
  registerMediaCommands(gw);
  registerEnrichCommands(gw);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  db.vault
    .prepare("UPDATE enrich_policy SET tier = ? WHERE domain = 'photos'")
    .run(tier);

  const contentIdOf = (assetId: string): string =>
    (
      db.vault
        .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
        .get(assetId) as { content_id: string }
    ).content_id;

  const addBareAsset = (index: number): string => {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PIXELS[index] },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { status: "executed"; output: { asset_id: string } })
      .output.asset_id;
  };

  return {
    db,
    owner,
    addBareAsset,
    addAsset: (index, variant, bytes) => {
      const assetId = addBareAsset(index);
      const sha = db.blobs.ingestSync(bytes).sha256;
      db.vault
        .prepare(
          `INSERT INTO core_content_derivative
             (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
           VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?)`
        )
        .run(
          uuidv7(),
          contentIdOf(assetId),
          variant,
          sha,
          bytes.length,
          nowIso()
        );
      return assetId;
    },
    originalBytesOf: (assetId) => {
      const row = db.vault
        .prepare(
          `SELECT i.content_uri AS uri FROM core_content_item i
             JOIN media_media_asset a ON a.content_id = i.content_id
            WHERE a.asset_id = ?`
        )
        .get(assetId) as { uri: string };
      return db.blobs.getSync(shaOfBlobUri(row.uri) as string) as Buffer;
    },
  };
}

/** An in-process embedder that records what it was handed. */
function recordingEmbedder(model = MODEL): Embedder & { seen: Buffer[] } {
  const seen: Buffer[] = [];
  return {
    model,
    seen,
    embedImage: (bytes) => {
      seen.push(Buffer.from(bytes));
      return Promise.resolve(stubVectorFor(bytes));
    },
    embedText: (text) => Promise.resolve(stubVectorFor(text)),
  };
}

/**
 * The vector as the ledger stores it. `enrich_embedding.vector` is float32, so
 * a JS double round-trips to a nearby-but-unequal double — rounding the
 * EXPECTATION through the same width keeps the assertion exact instead of
 * approximate.
 */
function storedAs(values: readonly number[]): number[] {
  return Array.from(Float32Array.from(values));
}

function embeddingsFor(db: VaultDb, model: string): Map<string, number[]> {
  const rows = db.vault
    .prepare(
      "SELECT target_id, vector FROM enrich_embedding WHERE target_type = 'media.media_asset' AND model = ?"
    )
    .all(model) as unknown as { target_id: string; vector: Uint8Array }[];
  return new Map(
    rows.map((row) => [
      row.target_id,
      [...decodeVector(Buffer.from(row.vector))],
    ])
  );
}

describe("photo-embeddings", () => {
  test("the backfill embeds live assets from their derivative bytes and versions the row by model", async () => {
    const f = fixture();
    const thumb = Buffer.from([9, 8, 7, 6, 5, 4]);
    const assetId = f.addAsset(0, "thumb", thumb);

    const embedder = recordingEmbedder();
    const result = await runPhotoEmbeddingSweep(f.db, { embedder });

    expect(result.status).toBe("ok");
    expect(result.embedded).toBe(1);
    expect(embeddingsFor(f.db, MODEL).get(assetId)).toStrictEqual(
      storedAs(stubVectorFor(thumb))
    );
    // The row is keyed by the versioned model id, which is what makes an
    // upgrade a backfill (issue #721 E1).
    const row = f.db.vault
      .prepare("SELECT model, dim FROM enrich_embedding WHERE target_id = ?")
      .get(assetId) as { model: string; dim: number };
    expect(row.model).toBe("test-clip@1");
    expect(row.dim).toBe(4);
    f.db.close();
  });

  test("the original photograph is never handed to the embedder", async () => {
    const f = fixture();
    const preview = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const assetId = f.addAsset(0, "preview", preview);
    const original = f.originalBytesOf(assetId);
    expect(original.equals(preview)).toBe(false);

    const embedder = recordingEmbedder();
    await runPhotoEmbeddingSweep(f.db, { embedder });

    expect(embedder.seen).toHaveLength(1);
    expect(embedder.seen[0]!.equals(preview)).toBe(true);
    expect(embedder.seen.some((seen) => seen.equals(original))).toBe(false);
    f.db.close();
  });

  test("the preview rung is preferred over the thumb when both exist", async () => {
    const f = fixture();
    const preview = Buffer.from([200, 100, 50, 25]);
    const assetId = f.addAsset(0, "preview", preview);
    const thumbSha = f.db.blobs.ingestSync(Buffer.from([1, 1, 1, 1])).sha256;
    const contentId = (
      f.db.vault
        .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
        .get(assetId) as { content_id: string }
    ).content_id;
    f.db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'thumb', ?, 'image/jpeg', 4, ?)`
      )
      .run(uuidv7(), contentId, thumbSha, nowIso());

    const embedder = recordingEmbedder();
    await runPhotoEmbeddingSweep(f.db, { embedder });
    expect(embedder.seen[0]!.equals(preview)).toBe(true);
    f.db.close();
  });

  test("an asset with no derivative yet is skipped, not read from its original", async () => {
    const f = fixture();
    f.addBareAsset(0);
    const embedder = recordingEmbedder();
    const result = await runPhotoEmbeddingSweep(f.db, { embedder });
    expect(result.skippedNoDerivative).toBe(1);
    expect(result.embedded).toBe(0);
    expect(embedder.seen).toHaveLength(0);
    f.db.close();
  });

  test("an open embedding request is claimed and drained in the same pass", async () => {
    const f = fixture();
    const assetId = f.addAsset(0, "thumb", Buffer.from([4, 4, 4, 4]));
    const requestId = uuidv7();
    f.db.vault
      .prepare(
        `INSERT INTO enrich_request
           (request_id, target_type, target_id, reason, required_capability, requested_at)
         VALUES (?, 'media.media_asset', ?, 'search-miss', 'embedding', ?)`
      )
      .run(requestId, assetId, nowIso());

    const result = await runPhotoEmbeddingSweep(f.db, {
      embedder: recordingEmbedder(),
    });
    expect(result.embedded).toBe(1);
    expect(result.drained).toBe(1);
    const drainedAt = (
      f.db.vault
        .prepare("SELECT drained_at FROM enrich_request WHERE request_id = ?")
        .get(requestId) as { drained_at: string | null }
    ).drained_at;
    expect(drainedAt).not.toBeNull();
    f.db.close();
  });

  test("a domain-wide request drains only once the backfill has nothing left", async () => {
    const f = fixture();
    f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    f.addAsset(1, "thumb", Buffer.from([5, 6, 7, 8]));
    const requestId = uuidv7();
    f.db.vault
      .prepare(
        `INSERT INTO enrich_request
           (request_id, target_type, target_id, reason, required_capability, capability, requested_at)
         VALUES (?, 'media.media_asset', NULL, 'manual', 'embedding', 'embedding', ?)`
      )
      .run(requestId, nowIso());

    const embedder = recordingEmbedder();
    // A pass that fills its whole batch cannot know it reached the end.
    const first = await runPhotoEmbeddingSweep(f.db, { embedder, limit: 1 });
    expect(first.embedded).toBe(1);
    expect(first.drained).toBe(0);
    // The next pass sees one asset left against a batch of two, so the library
    // is fully indexed and the standing ask is answered.
    const second = await runPhotoEmbeddingSweep(f.db, { embedder, limit: 2 });
    expect(second.embedded).toBe(1);
    expect(second.drained).toBe(1);
    f.db.close();
  });

  test("nothing runs while the photos domain is not at the gateway tier", async () => {
    await forEachSequentially(["off", "device"] as const, async (tier) => {
      const f = fixture(tier);
      f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
      const embedder = recordingEmbedder();
      const result = await runPhotoEmbeddingSweep(f.db, { embedder });
      expect(result.status).toBe("policy");
      expect(result.embedded).toBe(0);
      expect(embedder.seen).toHaveLength(0);
      expect(embeddingsFor(f.db, MODEL).size).toBe(0);
      f.db.close();
    });
  });

  test("no configured embedder means an idle indexer, never a fake vector", async () => {
    const f = fixture();
    f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    const result = await runPhotoEmbeddingSweep(f.db, { embedder: null });
    expect(result.status).toBe("no-embedder");
    const stored = f.db.vault
      .prepare("SELECT count(*) AS n FROM enrich_embedding")
      .get() as { n: number };
    expect(stored.n).toBe(0);
    f.db.close();
  });

  test("a fresh worker resumes the remaining work after a crash mid-library", async () => {
    const f = fixture();
    const assets = [
      f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1])),
      f.addAsset(1, "thumb", Buffer.from([2, 2, 2, 2])),
      f.addAsset(2, "thumb", Buffer.from([3, 3, 3, 3])),
    ];
    // One asset indexed, then the "process dies" — nothing is handed to the
    // next pass but the vault itself.
    const first = await runPhotoEmbeddingSweep(f.db, {
      embedder: recordingEmbedder(),
      limit: 1,
    });
    expect(first.embedded).toBe(1);

    const resumed = recordingEmbedder();
    const second = await runPhotoEmbeddingSweep(f.db, { embedder: resumed });
    expect(second.embedded).toBe(2);
    // The already-indexed asset is not re-embedded: the LEFT JOIN found its row.
    expect(resumed.seen).toHaveLength(2);
    expect([...embeddingsFor(f.db, MODEL).keys()].toSorted()).toStrictEqual(
      assets.toSorted()
    );

    // And a third pass over a fully indexed library does nothing at all.
    const idle = recordingEmbedder();
    const third = await runPhotoEmbeddingSweep(f.db, { embedder: idle });
    expect(third.embedded).toBe(0);
    expect(idle.seen).toHaveLength(0);
    f.db.close();
  });

  test("a model version bump re-derives the library without invalidating the old rows", async () => {
    const f = fixture();
    const assetId = f.addAsset(0, "thumb", Buffer.from([7, 7, 7, 7]));
    await runPhotoEmbeddingSweep(f.db, { embedder: recordingEmbedder() });

    const upgraded = recordingEmbedder("test-clip@2");
    const result = await runPhotoEmbeddingSweep(f.db, { embedder: upgraded });
    expect(result.embedded).toBe(1);
    expect(upgraded.seen).toHaveLength(1);
    // Both generations coexist under the UNIQUE(target, model) key, so the old
    // index keeps answering searches while the new one fills in.
    expect(embeddingsFor(f.db, "test-clip@1").has(assetId)).toBe(true);
    expect(embeddingsFor(f.db, "test-clip@2").has(assetId)).toBe(true);
    f.db.close();
  });

  test("one photograph the embedder refuses does not sink the batch", async () => {
    const f = fixture();
    f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1]));
    f.addAsset(1, "thumb", Buffer.from([2, 2, 2, 2]));
    const failures: string[] = [];
    let calls = 0;
    const flaky: Embedder = {
      model: MODEL,
      embedImage: (bytes) => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("decode failed"))
          : Promise.resolve(stubVectorFor(bytes));
      },
      embedText: (text) => Promise.resolve(stubVectorFor(text)),
    };
    const result = await runPhotoEmbeddingSweep(f.db, {
      embedder: flaky,
      onFailure: (_assetId, reason) => failures.push(reason),
    });
    expect(result.failed).toBe(1);
    expect(result.embedded).toBe(1);
    expect(failures).toStrictEqual(["decode failed"]);
    f.db.close();
  });

  test("trashed assets are left out of the backfill entirely", async () => {
    const f = fixture();
    const assetId = f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    f.db.vault
      .prepare("UPDATE media_media_asset SET deleted_at = ? WHERE asset_id = ?")
      .run(nowIso(), assetId);
    const embedder = recordingEmbedder();
    const result = await runPhotoEmbeddingSweep(f.db, { embedder });
    expect(result.scanned).toBe(0);
    expect(embedder.seen).toHaveLength(0);
    f.db.close();
  });

  test("end to end against a real embedder COMMAND, spawned per photograph", async () => {
    const f = fixture();
    const dir = await tempDir("photo-embeddings-");
    const embedder = resolveEmbedder({
      CENTRAID_EMBEDDER_PATH: await writeStubEmbedder(dir),
      CENTRAID_EMBEDDER_MODEL: "stub-clip@1",
    });
    const bytes = Buffer.from([11, 22, 33, 44]);
    const assetId = f.addAsset(0, "thumb", bytes);

    const result = await runPhotoEmbeddingSweep(f.db, { embedder });
    expect(result.status).toBe("ok");
    expect(result.embedded).toBe(1);
    expect(embeddingsFor(f.db, "stub-clip@1").get(assetId)).toStrictEqual(
      storedAs(stubVectorFor(bytes))
    );
    f.db.close();
  });
});
