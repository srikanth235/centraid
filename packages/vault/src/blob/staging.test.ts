// The SYNCHRONOUS ingress door's display rungs (#1011). `stageBlobBytes` is
// the seam behind the JSON `POST /_vault/blobs` route, `gateway.stageBlob` and
// the file-drop / camera-roll import stager; it was the one door that never
// called the shared preview contributor, so a camera-roll import landed
// `media_asset` rows with no thumb and every recognition recipe read "not
// ready" until the hours-apart sweep. The codec is STUBBED — the vault package
// carries no raster codec, so the real one lives in the gateway package.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Identity } from "../gateway/types.js";
import { PUBLISHERS } from "../ingest/publishers.js";
import { stageFile } from "../ingest/stage-file.js";
import { publishBatch } from "../ingest/staging.js";
import type { PreviewCodec } from "./preview.js";
import { stageBlobBytes } from "./staging.js";

/** A JPEG with nothing in it but a unique comment — enough to sniff as
 *  `image/jpeg`, and enough for two of them to hash differently. */
function jpeg(marker: string): Buffer {
  const text = Buffer.from(marker, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
    length,
    text,
    Buffer.from([0xff, 0xd9]),
  ]);
}

// A real 1×1 PNG stands in for a raster encoder: `contributeIngressPreviews`
// stages its rungs with `validateDerivative: true`, so the derivative
// validator actually decodes what the codec hands it (the same stand-in
// `direct-transfers.test.ts` uses). These tests are about the door, not pixels.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const stubCodec: PreviewCodec = {
  downscale: (_source, mediaType) =>
    mediaType.startsWith("image/")
      ? {
          bytes: ONE_PIXEL_PNG,
          mediaType: "image/png",
          width: 1,
          height: 1,
        }
      : null,
  perceptualHash: () => "0".repeat(16),
  thumbhash: () => Buffer.from("thumbhash").toString("base64"),
};

/** The contribution is fire-and-forget; drain the microtask/immediate queue. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function stagedVariants(db: VaultDb, parentSha: string): string[] {
  return (
    db.vault
      .prepare(
        "SELECT variant FROM blob_staging WHERE variant_of = ? ORDER BY variant"
      )
      .all(parentSha) as { variant: string }[]
  ).map((row) => row.variant);
}

describe("stageBlobBytes contributes display rungs at ingest", () => {
  let db: VaultDb;
  let owner: Identity;

  beforeEach(() => {
    db = openVaultDb({ previewCodec: stubCodec });
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    owner = {
      kind: "owner-device",
      callerId: boot.deviceId,
      provAgentKind: "owner",
      partyId: boot.ownerPartyId,
      mayAct: true,
    };
  });

  test("an eligible original gets the full ladder staged beside it", async () => {
    const staged = stageBlobBytes(db, {
      bytes: jpeg("camera-roll"),
      filename: "IMG_0001.jpg",
    });
    expect(staged.mediaType).toBe("image/jpeg");
    await settle();
    expect(stagedVariants(db, staged.sha256)).toStrictEqual([
      "phash",
      "preview",
      "thumb",
      "thumbhash",
    ]);
  });

  test("a derivative upload contributes nothing — no recursion", async () => {
    const parent = stageBlobBytes(db, {
      bytes: jpeg("parent"),
      filename: "IMG_0002.jpg",
    });
    await settle();
    const thumb = db.vault
      .prepare(
        "SELECT sha256 FROM blob_staging WHERE variant_of = ? AND variant = 'thumb'"
      )
      .get(parent.sha256) as { sha256: string };
    // The staged thumb is itself a perfectly good `image/png`; it must not
    // father a ladder of its own.
    expect(stagedVariants(db, thumb.sha256)).toStrictEqual([]);
  });

  test("a non-image contributes nothing", async () => {
    const staged = stageBlobBytes(db, {
      bytes: Buffer.from("plain notes, no pixels", "utf8"),
      filename: "notes.txt",
    });
    await settle();
    expect(staged.mediaType.startsWith("image/")).toBe(false);
    expect(stagedVariants(db, staged.sha256)).toStrictEqual([]);
  });

  test("a client-supplied thumb is never regenerated", async () => {
    const bytes = jpeg("client-thumbed");
    const parent = stageBlobBytes(db, { bytes, filename: "IMG_0003.jpg" });
    const mineHash = Buffer.from("client!!!").toString("base64");
    const mine = stageBlobBytes(db, {
      bytes: Buffer.from(mineHash),
      mediaType: "application/x-thumbhash",
      variant: "thumbhash",
      variantOf: parent.sha256,
    });
    await settle();
    const row = db.vault
      .prepare(
        "SELECT inline_content FROM blob_staging WHERE variant_of = ? AND variant = 'thumbhash'"
      )
      .get(parent.sha256) as { inline_content: string };
    expect(row.inline_content).toBe(mineHash);
    expect(mine.sha256).toBeTruthy();
  });

  test("import of a photograph leaves derivatives with no sweep", async () => {
    const staged = stageFile(db, owner, {
      filename: "lena.jpg",
      data: jpeg("camera-roll-import"),
    });
    expect(staged.staged.create).toBe(1);
    const published = publishBatch(db, owner, staged.batchId, PUBLISHERS);
    expect(published.failed).toStrictEqual([]);
    expect(published.created).toBe(1);
    // The contribution is still in flight while `media.add_asset` claims the
    // sha: the late rows must land on the CLAIMED content item, not orphan in
    // `blob_staging`.
    await settle();

    const asset = db.vault
      .prepare("SELECT asset_id, content_id FROM media_asset")
      .get() as { asset_id: string; content_id: string };
    const rows = db.vault
      .prepare(
        `SELECT variant FROM core_content_derivative
          WHERE content_id = ?
            AND CASE WHEN variant IN ('phash','thumbhash')
                     THEN text_content IS NOT NULL ELSE sha256 IS NOT NULL END
          ORDER BY variant`
      )
      .all(asset.content_id) as { variant: string }[];
    expect(rows.map((r) => r.variant)).toStrictEqual([
      "phash",
      "preview",
      "thumb",
      "thumbhash",
    ]);
  });
});
