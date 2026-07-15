// The preview ladder's orchestration + gateway backstop (issue #405 §2). The
// raster codec is STUBBED here — the vault package is dependency-free, so the
// real jpeg-js/pngjs codec (and its own round-trip tests) live in the gateway
// package. What these tests pin is everything AROUND the codec: which items
// the backstop selects, that it stages both rungs through the existing
// staging/promote path, idempotency, unsupported-type skipping, the batch
// bound, missing-bytes accounting, and that `sweepBlobs` runs the backstop and
// reports its yield in the receipt.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerMediaCommands } from '../commands/media.js';
import { backfillPreviews, type PreviewCodec } from './preview.js';
import { shaOfBlobUri } from './store.js';

// A 1×1 PNG — appending zero bytes keeps the PNG signature (so it still sniffs
// `image/png`) while giving each item a distinct sha + distinct byte length.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// A stub codec: real JPEG magic prefix so the staged derivative sniffs back as
// `image/jpeg`, distinct output per (edge, source) so the two rungs never
// collide, and `null` for `image/gif` to exercise the unsupported-skip path.
const stubCodec: PreviewCodec = {
  downscale(source, mediaType, maxEdge) {
    if (mediaType === 'image/gif') return null;
    const body = Buffer.from(`preview-${maxEdge}-${source.length}`);
    return {
      bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), body]),
      mediaType: 'image/jpeg',
      width: maxEdge,
      height: maxEdge,
    };
  },
};

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb({ previewCodec: stubCodec });
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerMediaCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

/** Stage `bytes` as an original and claim it as a media asset — a client-less
 *  ingest, exactly the shape a Takeout import or connector produces. */
function addImage(bytes: Buffer): string {
  const staged = gw.stageBlob(owner, { bytes, filename: 'pixel.png' });
  const out = gw.invoke(owner, {
    command: 'media.add_asset',
    input: { staged_sha: staged.sha256 },
    purpose: 'dpv:ServiceProvision',
  });
  expect((out as { status: string }).status).toBe('executed');
  return (out as { output: { content_id: string } }).output.content_id;
}

/** The original blob sha behind a content item. */
function originalSha(contentId: string): string {
  const row = db.vault
    .prepare('SELECT content_uri FROM core_content_item WHERE content_id = ?')
    .get(contentId) as { content_uri: string };
  return shaOfBlobUri(row.content_uri)!;
}

function derivativeShas(contentId: string): Record<string, string> {
  const rows = db.vault
    .prepare(
      'SELECT variant, sha256 FROM core_content_derivative WHERE content_id = ? AND sha256 IS NOT NULL',
    )
    .all(contentId) as { variant: string; sha256: string }[];
  return Object.fromEntries(rows.map((r) => [r.variant, r.sha256]));
}

test('backstop stages both rungs for an image missing them, idempotent on re-run', async () => {
  const contentId = addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(1)]));
  expect(derivativeShas(contentId)).toEqual({}); // client staged nothing

  const first = await backfillPreviews(db, stubCodec);
  expect(first.scanned).toBe(1);
  expect(first.generated).toBe(2); // tiny + medium
  const rungs = derivativeShas(contentId);
  expect(Object.keys(rungs).sort()).toEqual(['preview', 'thumb']);
  // Both derivative blobs actually landed in the CAS (so they replicate).
  expect(db.blobs.hasSync(rungs.thumb!)).toBe(true);
  expect(db.blobs.hasSync(rungs.preview!)).toBe(true);

  // Second pass finds nothing missing — the backstop only fills holes.
  const second = await backfillPreviews(db, stubCodec);
  expect(second.scanned).toBe(0);
  expect(second.generated).toBe(0);
});

test('a client-supplied rung is never overwritten — the backstop only fills the gap', async () => {
  const contentId = addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(2)]));
  // Simulate a client thumb that beat the sweep: stage it directly.
  const clientThumb = gw.stageBlob(owner, {
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
    variant: 'thumb',
    variantOf: originalSha(contentId),
  });
  const before = derivativeShas(contentId);
  expect(before.thumb).toBe(clientThumb.sha256);

  const result = await backfillPreviews(db, stubCodec);
  expect(result.generated).toBe(1); // only the missing medium rung
  const after = derivativeShas(contentId);
  expect(after.thumb).toBe(clientThumb.sha256); // untouched — client wins
  expect(after.preview).toBeDefined();
});

test('unsupported media type is skipped whole (null codec result), counted once', async () => {
  const contentId = addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(3)]));
  // Force this item to read as a gif so the stub declines it.
  db.vault
    .prepare("UPDATE core_content_item SET media_type = 'image/gif' WHERE content_id = ?")
    .run(contentId);

  const result = await backfillPreviews(db, stubCodec);
  expect(result.scanned).toBe(1);
  expect(result.generated).toBe(0);
  expect(result.skippedUnsupported).toBe(1);
  expect(derivativeShas(contentId)).toEqual({});
});

test('a non-image content item is never scanned (media_type filter)', async () => {
  const contentId = addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(4)]));
  db.vault
    .prepare("UPDATE core_content_item SET media_type = 'application/pdf' WHERE content_id = ?")
    .run(contentId);
  const result = await backfillPreviews(db, stubCodec);
  expect(result.scanned).toBe(0);
});

test('batch bound caps items per pass; the remainder drains on the next pass', async () => {
  for (let i = 0; i < 3; i += 1) addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(i + 5)]));
  const first = await backfillPreviews(db, stubCodec, { limit: 2 });
  expect(first.scanned).toBe(2);
  expect(first.generated).toBe(4);
  const second = await backfillPreviews(db, stubCodec, { limit: 2 });
  expect(second.scanned).toBe(1); // only the third remained
  expect(second.generated).toBe(2);
  const third = await backfillPreviews(db, stubCodec, { limit: 2 });
  expect(third.scanned).toBe(0);
});

test('an original absent from both tiers is reported as missing, not crashed', async () => {
  const contentId = addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(9)]));
  db.blobs.deleteLocalSync(originalSha(contentId)); // no remote tier → gone everywhere
  const result = await backfillPreviews(db, stubCodec);
  expect(result.scanned).toBe(1);
  expect(result.missingBytes).toBe(1);
  expect(result.generated).toBe(0);
});

test('sweepBlobs runs the backstop and reports the yield in its receipt', async () => {
  addImage(Buffer.concat([PNG_BYTES, Buffer.alloc(20)]));
  const sweep = await gw.sweepBlobs(owner);
  const receipt = db.journal
    .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
    .get(sweep.receiptId) as { detail_json: string };
  const detail = JSON.parse(receipt.detail_json) as { previewsGenerated: number };
  expect(detail.previewsGenerated).toBe(2); // tiny + medium for the one image
});
