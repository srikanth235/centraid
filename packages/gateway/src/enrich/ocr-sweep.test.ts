// The capability sweep driven through the photo OCR spec (issue #724 W4):
// behaviour, not mechanism — what a pass writes, what it stamps, that the
// written text is actually searchable, and that an empty photograph is an
// honest empty rather than a fabricated one.
//
// Every case runs against the FAKE ENRICHMENT SERVICE over a real socket —
// same reasoning as `capability-sweep.test.ts`.

import { describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import {
  bootstrapVault,
  createGateway,
  nowIso,
  openVaultDb,
  registerEnrichCommands,
  registerMediaCommands,
  stampedModel,
  uuidv7,
} from "@centraid/vault";
import type { Credential, VaultDb } from "@centraid/vault";

import { runCapabilitySweep } from "./capability-sweep.js";
import { startFakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import type { FakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import { createOcrSweepSpec } from "./ocr-sweep.js";

const MODEL = "fake-ocr@1";

/** Distinct pixel data URIs so each mints its OWN asset (sha256 differs). */
const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
];

interface Fixture {
  db: VaultDb;
  owner: Credential;
  gw: ReturnType<typeof createGateway>;
  contentIdOf: (assetId: string) => string;
  /** Add a photo asset and give it a `variant` derivative holding `bytes`. */
  addAsset: (
    index: number,
    variant: "thumb" | "preview",
    bytes: Buffer
  ) => string;
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

  const addAsset = (
    index: number,
    variant: "thumb" | "preview",
    bytes: Buffer
  ): string => {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PIXELS[index] },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    const assetId = (
      outcome as { status: "executed"; output: { asset_id: string } }
    ).output.asset_id;
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
  };

  return { db, owner, gw, contentIdOf, addAsset };
}

async function sweep(
  f: Fixture,
  service: FakeEnrichService | null,
  options: { batchSize?: number } = {}
): ReturnType<typeof runCapabilitySweep> {
  return runCapabilitySweep(f.db, createOcrSweepSpec(f.gw, f.owner), {
    config: service?.config ?? null,
    call: { timeoutMs: 2_000 },
    ...options,
  });
}

function extractedTextOf(db: VaultDb, contentId: string): string | null {
  const row = db.vault
    .prepare(
      `SELECT text_content FROM core_content_derivative WHERE content_id = ? AND variant = 'text'`
    )
    .get(contentId) as { text_content: string } | undefined;
  return row?.text_content ?? null;
}

function stampOf(db: VaultDb, contentId: string): string | null {
  return stampedModel(db.vault, {
    targetType: "content_item",
    targetId: contentId,
    variant: "text",
  });
}

describe("capability-sweep (photo OCR)", () => {
  test("regions land as the content item's text derivative, in reading order, and stamp what produced them", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: {
        ocr: {
          result: () => ({
            regions: [
              { text: "world", confidence: 0.9, box: [0, 10, 4, 4] },
              { text: "hello", confidence: 0.9, box: [0, 0, 4, 4] },
            ],
          }),
        },
      },
    });
    const assetId = f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
    const contentId = f.contentIdOf(assetId);

    const result = await sweep(f, service);

    expect(result.status).toBe("ok");
    expect(result.derived).toBe(1);
    // Top-to-bottom reading order: the y=0 region first, y=10 second.
    expect(extractedTextOf(f.db, contentId)).toBe("hello\nworld");
    expect(stampOf(f.db, contentId)).toBe(MODEL);
    const stamp = f.db.vault
      .prepare(
        "SELECT capability, payload_json FROM enrich_derivation WHERE target_id = ?"
      )
      .get(contentId) as { capability: string; payload_json: string };
    expect(stamp.capability).toBe("ocr");
    expect(JSON.parse(stamp.payload_json).regions).toHaveLength(2);

    await service.close();
    f.db.close();
  });

  test("the extracted text is searchable through the content item's own FTS index", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: {
        ocr: {
          result: () => ({
            regions: [
              {
                text: "menu of the day: borscht",
                confidence: 0.9,
                box: [0, 0, 4, 4],
              },
            ],
          }),
        },
      },
    });
    const assetId = f.addAsset(0, "thumb", Buffer.from([9, 9, 9, 9]));
    const contentId = f.contentIdOf(assetId);
    await sweep(f, service);

    const found = f.gw.search(f.owner, {
      entity: "core.content_item",
      query: "borscht",
      purpose: "dpv:ServiceProvision",
    });
    expect(found.rows.map((row) => row["content_id"])).toContain(contentId);

    await service.close();
    f.db.close();
  });

  test("an empty OCR result stamps so the backfill does not loop, but writes no text derivative", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: { ocr: { result: () => ({ regions: [] }) } },
    });
    const assetId = f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1]));
    const contentId = f.contentIdOf(assetId);

    const first = await sweep(f, service);
    expect(first.derived).toBe(1);
    expect(extractedTextOf(f.db, contentId)).toBeNull();
    expect(stampOf(f.db, contentId)).toBe(MODEL);

    // The stamp under the CURRENT model means the backfill leaves it alone.
    const second = await sweep(f, service);
    expect(second.derived).toBe(0);
    expect(second.scanned).toBe(0);

    await service.close();
    f.db.close();
  });

  test("nothing runs — and nothing is asked — while photos enrichment is not at the gateway tier", async () => {
    await forEachSequentially(["off", "device"] as const, async (tier) => {
      const f = fixture(tier);
      const service = await startFakeEnrichService();
      f.addAsset(0, "thumb", Buffer.from([1, 2, 3, 4]));
      const result = await sweep(f, service);
      expect(result.status).toBe("policy");
      expect(result.derived).toBe(0);
      expect(service.probes()).toBe(0);
      expect(service.calls).toHaveLength(0);
      await service.close();
      f.db.close();
    });
  });

  test("a model version bump re-derives the library and re-stamps the provenance", async () => {
    const f = fixture();
    const first = await startFakeEnrichService({
      capabilities: {
        ocr: {
          result: () => ({
            regions: [{ text: "v1", confidence: 0.5, box: [0, 0, 1, 1] }],
          }),
        },
      },
    });
    const assetId = f.addAsset(0, "thumb", Buffer.from([7, 7, 7, 7]));
    const contentId = f.contentIdOf(assetId);
    await sweep(f, first);
    await first.close();
    expect(stampOf(f.db, contentId)).toBe("fake-ocr@1");

    const upgraded = await startFakeEnrichService({
      capabilities: {
        ocr: {
          model: "fake-ocr@2",
          result: () => ({
            regions: [{ text: "v2", confidence: 0.5, box: [0, 0, 1, 1] }],
          }),
        },
      },
    });
    const result = await sweep(f, upgraded);
    expect(result.derived).toBe(1);
    expect(stampOf(f.db, contentId)).toBe("fake-ocr@2");
    expect(extractedTextOf(f.db, contentId)).toBe("v2");
    await upgraded.close();
    f.db.close();
  });

  test("one photograph the service refuses does not sink the batch", async () => {
    const f = fixture();
    let calls = 0;
    const service = await startFakeEnrichService({
      capabilities: {
        ocr: {
          result: (_item, index) => {
            calls += 1;
            return index === 0
              ? { error: "unreadable image" }
              : {
                  regions: [{ text: "ok", confidence: 0.9, box: [0, 0, 1, 1] }],
                };
          },
        },
      },
    });
    void calls;
    const bad = f.addAsset(0, "thumb", Buffer.from([1, 1, 1, 1]));
    const good = f.addAsset(1, "thumb", Buffer.from([2, 2, 2, 2]));
    const failures: string[] = [];
    const result = await runCapabilitySweep(
      f.db,
      createOcrSweepSpec(f.gw, f.owner),
      {
        config: service.config,
        call: { timeoutMs: 2_000 },
        onFailure: (id) => failures.push(id),
      }
    );
    expect(result.failed).toBe(1);
    expect(result.derived).toBe(1);
    expect(failures).toStrictEqual([f.contentIdOf(bad)]);
    expect(extractedTextOf(f.db, f.contentIdOf(good))).toBe("ok");
    await service.close();
    f.db.close();
  });
});
