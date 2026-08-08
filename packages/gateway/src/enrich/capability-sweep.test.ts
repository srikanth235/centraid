// The capability sweep (issue #724 W3) driven through its first spec, the
// photo embedder — behaviour, not mechanism: what a pass claims, what it
// writes, what it stamps, what it drains, what it refuses, and that a killed
// gateway resumes because the queue is the database.
//
// Every case runs against the FAKE ENRICHMENT SERVICE over a real socket. The
// point of #724 is that model work is now a wire contract, so a suite that
// stubbed the client would be testing the wrong thing.

import { describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import {
  bootstrapVault,
  createGateway,
  decodeVector,
  nowIso,
  openVaultDb,
  registerEnrichCommands,
  registerMediaCommands,
  shaOfBlobUri,
  stampedModel,
  uuidv7,
} from "@centraid/vault";
import type { Credential, VaultDb } from "@centraid/vault";

import { runCapabilitySweep } from "./capability-sweep.js";
import { EMBEDDING_SWEEP_SPEC } from "./embedding-sweep.js";
import {
  fakeVectorFor,
  startFakeEnrichService,
} from "./fake-enrich-service.test-fixtures.js";
import type { FakeEnrichService } from "./fake-enrich-service.test-fixtures.js";

const MODEL = "fake-clip@1";

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

/**
 * The vector as the ledger stores it. `enrich_embedding.vector` is float32, so
 * a JS double round-trips to a nearby-but-unequal double — rounding the
 * EXPECTATION through the same width keeps the assertion exact.
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

function stampOf(db: VaultDb, assetId: string): string | null {
  return stampedModel(db.vault, {
    targetType: "media.media_asset",
    targetId: assetId,
    variant: "embedding",
  });
}

/** The bytes one call actually put on the wire, decoded. */
function sentBytes(service: FakeEnrichService, call = 0): Buffer[] {
  return (service.calls[call]?.items ?? []).map((item) =>
    Buffer.from(String(item["bytes"]), "base64")
  );
}

async function sweep(
  db: VaultDb,
  service: FakeEnrichService | null,
  options: {
    batchSize?: number;
    onFailure?: (id: string, reason: string) => void;
  } = {}
): ReturnType<typeof runCapabilitySweep> {
  return runCapabilitySweep(db, EMBEDDING_SWEEP_SPEC, {
    config: service?.config ?? null,
    call: { timeoutMs: 2_000 },
    ...options,
  });
}

describe("capability-sweep (photo embeddings)", () => {
  test("the backfill derives live assets from their derivative bytes and stamps what produced them", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    const thumb = Buffer.from([9, 8, 7, 6, 5, 4]);
    const assetId = f.addAsset(0, "thumb", thumb);

    const result = await sweep(f.db, service);

    expect(result.status).toBe("ok");
    expect(result.derived).toBe(1);
    expect(embeddingsFor(f.db, MODEL).get(assetId)).toStrictEqual(
      storedAs(fakeVectorFor(thumb))
    );
    const row = f.db.vault
      .prepare("SELECT model, dim FROM enrich_embedding WHERE target_id = ?")
      .get(assetId) as { model: string; dim: number };
    expect(row.model).toBe(MODEL);
    expect(row.dim).toBe(4);
    // The provenance stamp is what makes a later model bump a query (#724 W2).
    expect(stampOf(f.db, assetId)).toBe(MODEL);
    const stamp = f.db.vault
      .prepare(
        "SELECT capability, payload_json FROM enrich_derivation WHERE target_id = ?"
      )
      .get(assetId) as { capability: string; payload_json: string };
    expect(stamp.capability).toBe("embed-image");
    expect(JSON.parse(stamp.payload_json)).toStrictEqual({ dim: 4 });

    await service.close();
    f.db.close();
  });

  test("the original photograph never reaches the enrichment service", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    const preview = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const assetId = f.addAsset(0, "preview", preview);
    const original = f.originalBytesOf(assetId);
    expect(original.equals(preview)).toBe(false);

    await sweep(f.db, service);

    const sent = sentBytes(service);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.equals(preview)).toBe(true);
    expect(sent.some((bytes) => bytes.equals(original))).toBe(false);
    await service.close();
    f.db.close();
  });

  test("the preview rung is preferred over the thumb when both exist", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
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

    await sweep(f.db, service);
    expect(sentBytes(service)[0]!.equals(preview)).toBe(true);
    await service.close();
    f.db.close();
  });

  test("an asset with no derivative yet is skipped, not read from its original", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    f.addBareAsset(0);
    const result = await sweep(f.db, service);
    expect(result.skipped).toBe(1);
    expect(result.derived).toBe(0);
    // Nothing was worth a round trip, so none was made.
    expect(service.calls).toHaveLength(0);
    await service.close();
    f.db.close();
  });

  test("an open request is claimed and drained in the same pass as its row", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    const assetId = f.addAsset(0, "thumb", Buffer.from([4, 4, 4, 4]));
    const requestId = uuidv7();
    f.db.vault
      .prepare(
        `INSERT INTO enrich_request
           (request_id, target_type, target_id, reason, required_capability, requested_at)
         VALUES (?, 'media.media_asset', ?, 'search-miss', 'embedding', ?)`
      )
      .run(requestId, assetId, nowIso());

    const result = await sweep(f.db, service);
    expect(result.derived).toBe(1);
    expect(result.drained).toBe(1);
    expect(
      (
        f.db.vault
          .prepare("SELECT drained_at FROM enrich_request WHERE request_id = ?")
          .get(requestId) as { drained_at: string | null }
      ).drained_at
    ).not.toBeNull();
    await service.close();
    f.db.close();
  });

  test("a domain-wide request drains only once the backfill has nothing left", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
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

    // A pass that fills its whole batch cannot know it reached the end.
    const first = await sweep(f.db, service, { batchSize: 1 });
    expect(first.derived).toBe(1);
    expect(first.drained).toBe(0);
    const second = await sweep(f.db, service, { batchSize: 2 });
    expect(second.derived).toBe(1);
    expect(second.drained).toBe(1);
    await service.close();
    f.db.close();
  });

  test("nothing runs — and nothing is asked — while the domain is not at the gateway tier", async () => {
    await forEachSequentially(["off", "device"] as const, async (tier) => {
      const f = fixture(tier);
      const service = await startFakeEnrichService();
      f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
      const result = await sweep(f.db, service);
      expect(result.status).toBe("policy");
      expect(result.derived).toBe(0);
      // Consent is read BEFORE the network: `off` is not observable as traffic.
      expect(service.probes()).toBe(0);
      expect(service.calls).toHaveLength(0);
      expect(embeddingsFor(f.db, MODEL).size).toBe(0);
      await service.close();
      f.db.close();
    });
  });

  test("no enrichment service means an idle indexer, never a fake vector", async () => {
    const f = fixture();
    f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    const result = await sweep(f.db, null);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("CENTRAID_ENRICH_URL");
    expect(
      (
        f.db.vault
          .prepare("SELECT count(*) AS n FROM enrich_embedding")
          .get() as { n: number }
      ).n
    ).toBe(0);
    f.db.close();
  });

  test("a service that does not offer this capability is unavailable, not an error", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: { transcript: {} },
    });
    f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    const result = await sweep(f.db, service);
    expect(result.status).toBe("unavailable");
    expect(result.reason).toContain("embed-image");
    expect(service.calls).toHaveLength(0);
    await service.close();
    f.db.close();
  });

  test("a fresh pass resumes the remaining work after a crash mid-library", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    const assets = [
      f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1])),
      f.addAsset(1, "thumb", Buffer.from([2, 2, 2, 2])),
      f.addAsset(2, "thumb", Buffer.from([3, 3, 3, 3])),
    ];
    const first = await sweep(f.db, service, { batchSize: 1 });
    expect(first.derived).toBe(1);

    const second = await sweep(f.db, service);
    expect(second.derived).toBe(2);
    // The already-indexed asset is not re-sent: the LEFT JOIN found its row.
    expect(sentBytes(service, 1)).toHaveLength(2);
    expect([...embeddingsFor(f.db, MODEL).keys()].toSorted()).toStrictEqual(
      assets.toSorted()
    );

    const third = await sweep(f.db, service);
    expect(third.derived).toBe(0);
    expect(service.calls).toHaveLength(2);
    await service.close();
    f.db.close();
  });

  test("a model version bump re-derives the library and re-stamps the provenance", async () => {
    const f = fixture();
    const first = await startFakeEnrichService();
    const assetId = f.addAsset(0, "thumb", Buffer.from([7, 7, 7, 7]));
    await sweep(f.db, first);
    await first.close();

    const upgraded = await startFakeEnrichService({
      capabilities: { "embed-image": { model: "fake-clip@2" } },
    });
    const result = await sweep(f.db, upgraded);
    expect(result.derived).toBe(1);
    // Both generations coexist under the UNIQUE(target, model) key, so the old
    // index keeps answering searches while the new one fills in...
    expect(embeddingsFor(f.db, "fake-clip@1").has(assetId)).toBe(true);
    expect(embeddingsFor(f.db, "fake-clip@2").has(assetId)).toBe(true);
    // ...while the stamp names only what produced the current output.
    expect(stampOf(f.db, assetId)).toBe("fake-clip@2");
    await upgraded.close();
    f.db.close();
  });

  test("one photograph the service refuses does not sink the batch", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: {
        "embed-image": {
          result: (item, index) =>
            index === 0
              ? { error: "decode failed" }
              : {
                  vector: fakeVectorFor(
                    Buffer.from(String(item["bytes"]), "base64")
                  ),
                },
        },
      },
    });
    f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1]));
    f.addAsset(1, "thumb", Buffer.from([2, 2, 2, 2]));
    const failures: string[] = [];
    const result = await sweep(f.db, service, {
      onFailure: (_assetId, reason) => failures.push(reason),
    });
    expect(result.failed).toBe(1);
    expect(result.derived).toBe(1);
    expect(failures).toStrictEqual(["decode failed"]);
    // The refused photograph keeps no stamp, so the next pass finds it again.
    expect(
      (
        f.db.vault
          .prepare("SELECT count(*) AS n FROM enrich_derivation")
          .get() as { n: number }
      ).n
    ).toBe(1);
    await service.close();
    f.db.close();
  });

  test("a service that dies between the probe and the batch writes nothing", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: { "embed-image": { misbehave: "server-error" } },
    });
    f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1]));
    const result = await sweep(f.db, service);
    expect(result.status).toBe("unavailable");
    expect(result.derived).toBe(0);
    expect(embeddingsFor(f.db, MODEL).size).toBe(0);
    await service.close();
    f.db.close();
  });

  test("trashed assets are left out of the backfill entirely", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    const assetId = f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    f.db.vault
      .prepare("UPDATE media_media_asset SET deleted_at = ? WHERE asset_id = ?")
      .run(nowIso(), assetId);
    const result = await sweep(f.db, service);
    expect(result.scanned).toBe(0);
    expect(service.calls).toHaveLength(0);
    await service.close();
    f.db.close();
  });
});
