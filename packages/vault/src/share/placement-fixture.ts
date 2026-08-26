// Shared fixture for the share-by-placement tests (#599 decision 11).
// Two real on-disk vaults under one root - never mocked fs - because the
// load-bearing claims are filesystem facts (inode identity, link counts,
// per-vault GC). Kept out of placement.test.ts for the 500-line file cap.

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { sweepLocalOrphans } from "../blob/local-orphan-sweep.js";
import { blobUriFor } from "../blob/store.js";
import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";

const open: VaultDb[] = [];

/** Close every vault opened by household(); call from each test file's afterEach. */
export function closeOpenVaults(): void {
  while (open.length > 0) open.pop()?.close();
}
export interface Household {
  root: string;
  origin: VaultDb;
  originBoot: BootstrapResult;
  audience: VaultDb;
  audienceBoot: BootstrapResult;
}

/** Two vaults side by side under ONE gateway root — the deployed topology. */
export function household(): Household {
  const root = tempDirSync("centraid-share-");
  const originDir = path.join(root, "vaults", "priya");
  const audienceDir = path.join(root, "vaults", "family");
  mkdirSync(originDir, { recursive: true });
  mkdirSync(audienceDir, { recursive: true });
  const origin = openVaultDb({ dir: originDir });
  const audience = openVaultDb({ dir: audienceDir });
  open.push(origin, audience);
  return {
    root,
    origin,
    originBoot: bootstrapVault(origin, {
      ownerName: "Priya",
      vaultId: "vault-priya",
    }),
    audience,
    audienceBoot: bootstrapVault(audience, {
      ownerName: "Family",
      vaultId: "vault-family",
    }),
  };
}

export interface SeededPhoto {
  assetId: string;
  contentId: string;
  sha256: string;
  thumbSha: string;
  bytes: Buffer;
  thumbBytes: Buffer;
}

/** A photo as Photos actually stores one: content item + thumb + media asset. */
export function seedPhoto(
  db: VaultDb,
  boot: BootstrapResult,
  label: string
): SeededPhoto {
  const bytes = Buffer.from(`original-bytes-${label}`);
  const thumbBytes = Buffer.from(`thumb-bytes-${label}`);
  const original = db.blobs.ingestSync(bytes);
  const thumb = db.blobs.ingestSync(thumbBytes);
  const now = nowIso();
  const contentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(original.sha256),
      original.sha256,
      original.byteSize,
      `Photo ${label}`,
      boot.ownerPartyId,
      boot.deviceId,
      now
    );
  db.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
       VALUES (?, ?, 'thumb', ?, 'image/jpeg', ?, NULL, ?)`
    )
    .run(uuidv7(), contentId, thumb.sha256, thumb.byteSize, now);
  const assetId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO media_asset
         (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id,
          place_id, camera_device_id, width, height, duration_s, exif_json,
          favorite, archived_at, deleted_at, purge_at)
       VALUES (?, ?, 'photo', ?, NULL, NULL, NULL, ?, 800, 600, NULL, NULL, 1, NULL, NULL, NULL)`
    )
    .run(assetId, contentId, now, boot.deviceId);
  return {
    assetId,
    contentId,
    sha256: original.sha256,
    thumbSha: thumb.sha256,
    bytes,
    thumbBytes,
  };
}

export function casPath(db: VaultDb, sha: string): string {
  const file = db.blobs.localPathSync(sha);
  expect(file, `expected ${sha} to be resident in ${db.dir}`).not.toBeNull();
  return file!;
}

/**
 * Two passes of the packaged local orphan sweep (`blob/local-orphan-sweep.ts`):
 * the first tombstones (a freshly-found orphan is HELD, never deleted on
 * sight), the second finds the grace elapsed and unlinks. Returns what the
 * second pass reclaimed.
 */
export function reclaimOrphans(db: VaultDb): string[] {
  expect(
    sweepLocalOrphans(db, { graceWindowMs: 0, now: 1_000 }).deleted
  ).toEqual([]);
  return sweepLocalOrphans(db, { graceWindowMs: 0, now: 2_000 }).deleted;
}
