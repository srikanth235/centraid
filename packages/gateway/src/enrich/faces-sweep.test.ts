// The faces spec (issue #724 W5) on the shared capability sweep — behaviour,
// not mechanism. The claims under test are the ones an owner would recognise:
// nothing is looked at without being asked for, boxes land where the face is,
// a repeated pass changes nothing, a newer model replaces its own proposals,
// and an answer the owner gave is never taken back.
//
// Every case runs against the FAKE ENRICHMENT SERVICE over a real socket, for
// the same reason `capability-sweep.test.ts` does: the enrichment service is a
// wire contract, and a stubbed client would test the wrong thing.

import { describe, expect, test } from "vitest";

import {
  bootstrapVault,
  createGateway,
  decodeVector,
  nowIso,
  openVaultDb,
  registerEnrichCommands,
  registerMediaCommands,
  registerPartyCommands,
  stampedModel,
  uuidv7,
} from "@centraid/vault";
import type { Credential, VaultDb } from "@centraid/vault";

import { runCapabilitySweep } from "./capability-sweep.js";
import { FACES_SWEEP_SPEC } from "./faces-sweep.js";
import { startFakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import type {
  FakeCapabilityBehaviour,
  FakeEnrichService,
} from "./fake-enrich-service.test-fixtures.js";

/** Distinct pixel data URIs so each mints its OWN asset (sha256 differs). */
const PIXELS = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
];

/** The declared original size of every seeded photograph — round, so a box's
 *  fraction is readable by inspection (200/1000 = 0.2). */
const ASSET_WIDTH = 1000;
const ASSET_HEIGHT = 500;

/** One face, dead centre-ish, in ORIGINAL pixels. */
const FACE_BOX: [number, number, number, number] = [200, 100, 300, 250];
const SECOND_BOX: [number, number, number, number] = [600, 50, 100, 100];

interface Fixture {
  db: VaultDb;
  owner: Credential;
  gw: ReturnType<typeof createGateway>;
  ownerPartyId: string;
  /** An asset with a `preview` derivative and declared original dimensions. */
  addAsset: (index: number, size?: { width: number; height: number }) => string;
  /** An asset with a derivative but NO declared dimensions. */
  addSizelessAsset: (index: number) => string;
}

function fixture(tier: "off" | "device" | "gateway" = "gateway"): Fixture {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Priya" });
  const gw = createGateway(db);
  registerMediaCommands(gw);
  registerEnrichCommands(gw);
  registerPartyCommands(gw);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  db.vault
    .prepare("UPDATE enrich_policy SET tier = ? WHERE domain = 'photos'")
    .run(tier);

  const add = (
    index: number,
    size: { width: number; height: number } | undefined
  ): string => {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PIXELS[index], ...size },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    const assetId = (
      outcome as { status: "executed"; output: { asset_id: string } }
    ).output.asset_id;
    const contentId = (
      db.vault
        .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
        .get(assetId) as { content_id: string }
    ).content_id;
    const bytes = Buffer.from(`preview-${index}`, "utf8");
    const sha = db.blobs.ingestSync(bytes).sha256;
    db.vault
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
         VALUES (?, ?, 'preview', ?, 'image/jpeg', ?, ?)`
      )
      .run(uuidv7(), contentId, sha, bytes.length, nowIso());
    return assetId;
  };

  return {
    db,
    gw,
    owner,
    ownerPartyId: boot.ownerPartyId,
    addAsset: (index, size) =>
      add(index, size ?? { width: ASSET_WIDTH, height: ASSET_HEIGHT }),
    addSizelessAsset: (index) => add(index, undefined),
  };
}

/** A fake service that returns `boxes` for every item it is handed. */
function facesService(
  boxes: readonly [number, number, number, number][],
  model = "fake-faces@1"
): Promise<FakeEnrichService> {
  const behaviour: FakeCapabilityBehaviour = {
    model,
    result: () => ({
      faces: boxes.map((box, index) => ({
        box,
        confidence: 0.9,
        // A distinct direction per box so the vectors are distinguishable.
        embedding: [index === 0 ? 1 : 0, index === 0 ? 0 : 1, 0, 0],
      })),
    }),
  };
  return startFakeEnrichService({ capabilities: { faces: behaviour } });
}

function queueVaultWideAsk(fx: Fixture): void {
  const outcome = fx.gw.invoke(fx.owner, {
    command: "enrich.request_enrichment",
    input: {
      entity_type: "media.media_asset",
      reason: "manual",
      capability: "faces",
    },
    purpose: "dpv:ServiceProvision",
  });
  expect(outcome.status).toBe("executed");
}

function queueAssetAsk(fx: Fixture, assetId: string): void {
  const outcome = fx.gw.invoke(fx.owner, {
    command: "enrich.request_enrichment",
    input: {
      entity_type: "media.media_asset",
      entity_id: assetId,
      reason: "manual",
      capability: "faces",
    },
    purpose: "dpv:ServiceProvision",
  });
  expect(outcome.status).toBe("executed");
}

function regionsOf(
  db: VaultDb,
  assetId: string
): {
  region_id: string;
  bbox_json: string;
  review_state: string;
  party_id: string | null;
}[] {
  return db.vault
    .prepare(
      `SELECT region_id, bbox_json, review_state, party_id
         FROM media_face_region WHERE asset_id = ? ORDER BY region_id`
    )
    .all(assetId) as never;
}

function faceVectors(db: VaultDb): { target_id: string; values: number[] }[] {
  return (
    db.vault
      .prepare(
        `SELECT target_id, vector FROM enrich_embedding
          WHERE target_type = 'media.face_region' ORDER BY target_id`
      )
      .all() as unknown as { target_id: string; vector: Uint8Array }[]
  ).map((row) => ({
    target_id: row.target_id,
    values: [...decodeVector(Buffer.from(row.vector))],
  }));
}

describe("the faces sweep", () => {
  test("a library nobody asked about is never looked at — no request, no read, no row", async () => {
    const fx = fixture();
    fx.addAsset(0);
    fx.addAsset(1);
    const service = await facesService([FACE_BOX]);
    try {
      const result = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      expect(result.status).toBe("ok");
      expect(result.scanned).toBe(0);
      expect(result.derived).toBe(0);
      // The photographs were never put on the wire at all.
      expect(service.calls).toStrictEqual([]);
      expect(regionsOf(fx.db, "any")).toStrictEqual([]);
    } finally {
      await service.close();
      fx.db.close();
    }
  });

  test("the owner's vault-wide ask is what licenses the library scan, and drains when the library ends", async () => {
    const fx = fixture();
    const first = fx.addAsset(0);
    const second = fx.addAsset(1);
    queueVaultWideAsk(fx);
    const service = await facesService([FACE_BOX]);
    try {
      const result = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      expect(result.derived).toBe(2);
      expect(result.drained).toBe(1);
      expect(regionsOf(fx.db, first)).toHaveLength(1);
      expect(regionsOf(fx.db, second)).toHaveLength(1);

      // The consent row is spent. A THIRD photograph arriving afterwards is
      // not swept — the ask was answered, and a new one is a new decision.
      const third = fx.addAsset(2);
      const after = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      expect(after.scanned).toBe(0);
      expect(regionsOf(fx.db, third)).toStrictEqual([]);
    } finally {
      await service.close();
      fx.db.close();
    }
  });

  test("a per-photograph ask reaches that photograph and no other", async () => {
    const fx = fixture();
    const asked = fx.addAsset(0);
    const untouched = fx.addAsset(1);
    queueAssetAsk(fx, asked);
    const service = await facesService([FACE_BOX]);
    try {
      const result = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      expect(result.derived).toBe(1);
      expect(regionsOf(fx.db, asked)).toHaveLength(1);
      expect(regionsOf(fx.db, untouched)).toStrictEqual([]);
    } finally {
      await service.close();
      fx.db.close();
    }
  });

  test("boxes land as a fraction of the whole photograph, with the vector beside them", async () => {
    const fx = fixture();
    const assetId = fx.addAsset(0);
    queueAssetAsk(fx, assetId);
    const service = await facesService([FACE_BOX, SECOND_BOX]);
    try {
      await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      const regions = regionsOf(fx.db, assetId);
      expect(regions).toHaveLength(2);
      const boxes = regions
        .map((row) => JSON.parse(row.bbox_json) as Record<string, number>)
        .sort((a, b) => a.x! - b.x!);
      expect(boxes).toStrictEqual([
        { x: 0.2, y: 0.2, w: 0.3, h: 0.5 },
        { x: 0.6, y: 0.1, w: 0.1, h: 0.2 },
      ]);
      // A detection is a proposal and nothing more: no party, no confirmation.
      expect(
        regions.map((row) => [row.review_state, row.party_id])
      ).toStrictEqual([
        ["proposed", null],
        ["proposed", null],
      ]);
      expect(faceVectors(fx.db)).toHaveLength(2);
      // The item declared its ORIGINAL dimensions, which is what makes the
      // service's pixel boxes convertible at all.
      expect(service.calls[0]?.items[0]).toMatchObject({
        originalWidth: ASSET_WIDTH,
        originalHeight: ASSET_HEIGHT,
      });
    } finally {
      await service.close();
      fx.db.close();
    }
  });

  test("a photograph of unknown size is skipped rather than given a box in the wrong units", async () => {
    const fx = fixture();
    const sizeless = fx.addSizelessAsset(0);
    queueAssetAsk(fx, sizeless);
    const service = await facesService([FACE_BOX]);
    try {
      const result = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      expect(result.skipped).toBe(1);
      expect(result.derived).toBe(0);
      expect(service.calls).toStrictEqual([]);
      expect(regionsOf(fx.db, sizeless)).toStrictEqual([]);
    } finally {
      await service.close();
      fx.db.close();
    }
  });

  test("running the same model twice over the same photograph changes nothing at all", async () => {
    const fx = fixture();
    const assetId = fx.addAsset(0);
    queueAssetAsk(fx, assetId);
    const service = await facesService([FACE_BOX, SECOND_BOX]);
    try {
      await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      const before = regionsOf(fx.db, assetId);
      const vectorsBefore = faceVectors(fx.db);

      queueAssetAsk(fx, assetId);
      await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });

      // Same rows, same ids: region ids are derived from (asset, model, box),
      // so a repeated derivation is a no-op rather than a duplicate face.
      expect(regionsOf(fx.db, assetId)).toStrictEqual(before);
      expect(faceVectors(fx.db)).toStrictEqual(vectorsBefore);
    } finally {
      await service.close();
      fx.db.close();
    }
  });

  test("a newer model replaces its predecessor's proposals — and NEVER an answer the owner gave", async () => {
    const fx = fixture();
    const assetId = fx.addAsset(0);
    queueAssetAsk(fx, assetId);
    const old = await facesService([FACE_BOX, SECOND_BOX], "fake-faces@1");
    try {
      await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, { config: old.config });
    } finally {
      await old.close();
    }

    // The owner answers both: one confirmed as Ana, one rejected outright.
    const ana = (
      fx.gw.invoke(fx.owner, {
        command: "core.add_party",
        input: { kind: "person", display_name: "Ana" },
        purpose: "dpv:ServiceProvision",
      }) as { output: { party_id: string } }
    ).output.party_id;
    const [confirmedRegion, rejectedRegion] = regionsOf(fx.db, assetId);
    for (const [region, answer, partyId] of [
      [confirmedRegion!.region_id, "confirm", ana],
      [rejectedRegion!.region_id, "reject", undefined],
    ] as const) {
      const outcome = fx.gw.invoke(fx.owner, {
        command: "media.answer_face_proposal",
        input: {
          region_id: region,
          answer,
          ...(partyId ? { party_id: partyId } : {}),
        },
        purpose: "dpv:ServiceProvision",
      });
      expect(outcome.status).toBe("executed");
    }
    const answered = regionsOf(fx.db, assetId);

    // A newer model runs over the same photograph and finds a face elsewhere.
    const upgraded = await facesService([[10, 10, 50, 50]], "fake-faces@2");
    try {
      queueAssetAsk(fx, assetId);
      await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: upgraded.config,
      });
      const after = regionsOf(fx.db, assetId);
      // Both answered rows survive, byte for byte.
      for (const row of answered)
        expect(after.find((r) => r.region_id === row.region_id)).toStrictEqual(
          row
        );
      // …and the new model's own proposal is beside them.
      const proposals = after.filter((row) => row.review_state === "proposed");
      expect(proposals).toHaveLength(1);
      expect(JSON.parse(proposals[0]!.bbox_json)).toStrictEqual({
        x: 0.01,
        y: 0.02,
        w: 0.05,
        h: 0.1,
      });
      expect(
        stampedModel(fx.db.vault, {
          targetType: "media.media_asset",
          targetId: assetId,
          variant: "faces",
        })
      ).toBe("fake-faces@2");
    } finally {
      await upgraded.close();
      fx.db.close();
    }
  });

  test("a superseded model re-derives without a new ask — a stamp is the record of the old one", async () => {
    const fx = fixture();
    const assetId = fx.addAsset(0);
    queueAssetAsk(fx, assetId);
    const old = await facesService([FACE_BOX], "fake-faces@1");
    try {
      await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, { config: old.config });
    } finally {
      await old.close();
    }
    // A second photograph arrives, never asked about. The upgrade must reach
    // the first and not the second.
    const never = fx.addAsset(1);

    const upgraded = await facesService([SECOND_BOX], "fake-faces@2");
    try {
      const result = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: upgraded.config,
      });
      expect(result.derived).toBe(1);
      expect(regionsOf(fx.db, never)).toStrictEqual([]);
      expect(
        regionsOf(fx.db, assetId).map((row) => row.review_state)
      ).toStrictEqual(["proposed"]);
    } finally {
      await upgraded.close();
      fx.db.close();
    }
  });

  test("an owner who turned enrichment off is not observable as traffic", async () => {
    const fx = fixture("off");
    fx.addAsset(0);
    queueVaultWideAsk(fx);
    const service = await facesService([FACE_BOX]);
    try {
      const result = await runCapabilitySweep(fx.db, FACES_SWEEP_SPEC, {
        config: service.config,
      });
      expect(result.status).toBe("policy");
      expect(service.probes()).toBe(0);
      expect(service.calls).toStrictEqual([]);
    } finally {
      await service.close();
      fx.db.close();
    }
  });
});
