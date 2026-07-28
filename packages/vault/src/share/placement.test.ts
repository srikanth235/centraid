// Share-by-placement (issue #599 decision 11). Two real on-disk vaults under
// one root — never mocked fs — because the load-bearing claims are filesystem
// facts: a share HARDLINKS (same inode, link count 2, zero bytes copied), each
// vault's GC unlinks only its own directory entry, and the inode is freed only
// after the last vault lets go.

import { statSync } from 'node:fs';
import path from 'node:path';
import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test } from 'vitest';
import { FsBlobStore } from '../blob/local.js';
import { readShareOrigin, shareToVault } from './placement.js';
import { casPath, closeOpenVaults, household, seedPhoto } from './placement-fixture.js';

afterEach(closeOpenVaults);
// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

test('a share projects the item into the audience vault and leaves the origin untouched', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'a');
  const originBefore = origin.vault
    .prepare('SELECT * FROM media_media_asset WHERE asset_id = ?')
    .get(photo.assetId);

  const result = shareToVault({
    origin,
    originVaultId: 'vault-priya',
    audience,
    itemType: 'media.media_asset',
    itemId: photo.assetId,
    sharedByMember: 'member-priya',
    now: () => 1_700_000_000_000,
  });

  // The audience member reads the item from THEIR vault — no query ever
  // touches the owner's vault.
  const projected = audience.vault
    .prepare(
      `SELECT a.asset_id, a.kind, a.favorite, a.width, a.place_id, a.camera_device_id,
              c.title, c.sha256, c.creator_party_id, c.origin_device_id
         FROM media_media_asset a JOIN core_content_item c ON c.content_id = a.content_id
        WHERE a.asset_id = ?`,
    )
    .get(result.itemId) as Record<string, unknown>;
  expect(projected.kind).toBe('photo');
  expect(projected.title).toBe('Photo a');
  expect(projected.sha256).toBe(photo.sha256);
  expect(projected.favorite).toBe(1);
  expect(projected.width).toBe(800);
  // Cross-vault FK columns are projected NULL — the origin's party/device
  // graph never crosses the boundary.
  expect(projected.creator_party_id).toBeNull();
  expect(projected.origin_device_id).toBeNull();
  expect(projected.camera_device_id).toBeNull();
  // The thumb rides along, so the merged grid paints without a re-derive.
  expect(
    audience.vault
      .prepare('SELECT sha256 FROM core_content_derivative WHERE content_id IS NOT NULL')
      .all(),
  ).toEqual([{ sha256: photo.thumbSha }]);
  // Both blobs are readable from the audience vault's own CAS.
  expect(audience.blobs.getSync(photo.sha256)).toEqual(photo.bytes);
  expect(audience.blobs.getSync(photo.thumbSha)).toEqual(photo.thumbBytes);

  // Provenance: where it came from, and who placed it.
  expect(readShareOrigin(audience.vault, 'media.media_asset', result.itemId)).toEqual({
    itemType: 'media.media_asset',
    itemId: result.itemId,
    originVaultId: 'vault-priya',
    originItemId: photo.assetId,
    sharedByMember: 'member-priya',
    sharedAt: 1_700_000_000_000,
  });

  // The origin is byte-for-byte where it was — sharing only READS there.
  expect(
    origin.vault.prepare('SELECT * FROM media_media_asset WHERE asset_id = ?').get(photo.assetId),
  ).toEqual(originBefore);
  expect(origin.vault.prepare('SELECT COUNT(*) AS n FROM core_share_origin').get()).toEqual({
    n: 0,
  });
  expect(origin.blobs.getSync(photo.sha256)).toEqual(photo.bytes);
});

test('reusing the origin id keeps the projection addressable by the same uuidv7', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'b');

  const result = shareToVault({
    origin,
    originVaultId: 'vault-priya',
    audience,
    itemType: 'media.media_asset',
    itemId: photo.assetId,
    sharedByMember: 'member-priya',
  });

  expect(result.itemId).toBe(photo.assetId);
  expect(
    audience.vault
      .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
      .get(photo.sha256),
  ).toEqual({ content_id: photo.contentId });
});

// ---------------------------------------------------------------------------
// Hardlink vs copy — the filesystem facts
// ---------------------------------------------------------------------------

test('a same-filesystem share HARDLINKS the bytes — same inode, link count 2', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'c');
  const originStat = statSync(casPath(origin, photo.sha256));
  expect(originStat.nlink).toBe(1);

  const result = shareToVault({
    origin,
    originVaultId: 'vault-priya',
    audience,
    itemType: 'media.media_asset',
    itemId: photo.assetId,
    sharedByMember: 'member-priya',
  });

  expect(result.blobs.map((b) => b.mode)).toEqual(['linked', 'linked']);
  for (const sha of [photo.sha256, photo.thumbSha]) {
    const from = statSync(casPath(origin, sha));
    const to = statSync(casPath(audience, sha));
    // ONE inode with TWO directory entries: zero bytes copied, and the
    // filesystem's link count is the cross-vault refcount.
    expect(to.ino).toBe(from.ino);
    expect(to.dev).toBe(from.dev);
    expect(from.nlink).toBe(2);
    expect(to.nlink).toBe(2);
  }
});

test('the copy fallback yields identical bytes when the filesystem refuses to link', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'd');
  // Force the EXDEV/EPERM classification without needing a second mount.
  audience.blobs.local.linkFromSync = () => 'unsupported';

  const result = shareToVault({
    origin,
    originVaultId: 'vault-priya',
    audience,
    itemType: 'media.media_asset',
    itemId: photo.assetId,
    sharedByMember: 'member-priya',
  });

  expect(result.blobs.map((b) => b.mode)).toEqual(['copied', 'copied']);
  for (const [sha, bytes] of [
    [photo.sha256, photo.bytes],
    [photo.thumbSha, photo.thumbBytes],
  ] as const) {
    const from = statSync(casPath(origin, sha));
    const to = statSync(casPath(audience, sha));
    expect(to.ino).not.toBe(from.ino); // a separate inode — bytes were copied
    expect(from.nlink).toBe(1);
    expect(to.nlink).toBe(1);
    expect(audience.blobs.getSync(sha)).toEqual(bytes);
  }
});

test('linkFromSync classifies a refusing link as unsupported and rethrows anything else', () => {
  const root = tempDirSync('centraid-link-');
  const store = new FsBlobStore(path.join(root, 'blobs'));
  const sha = 'a'.repeat(64);
  // link(2) on a DIRECTORY is EPERM on both Linux and macOS — a real errno,
  // not a stub, exercising the "this filesystem will not link" branch.
  expect(store.linkFromSync(sha, root)).toBe('unsupported');
  expect(store.hasSync(sha)).toBe(false);
  // An unexpected errno is never swallowed into a silent byte copy.
  expect(() => store.linkFromSync('b'.repeat(64), path.join(root, 'nope'))).toThrow(/ENOENT/);
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

test('re-sharing the same item is idempotent — same member and a different member', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'e');
  const share = (member: string, at: number) =>
    shareToVault({
      origin,
      originVaultId: 'vault-priya',
      audience,
      itemType: 'media.media_asset',
      itemId: photo.assetId,
      sharedByMember: member,
      now: () => at,
    });

  const first = share('member-priya', 1_000);
  const again = share('member-priya', 2_000);
  const bySid = share('member-sid', 3_000);

  expect(again.itemId).toBe(first.itemId);
  expect(bySid.itemId).toBe(first.itemId);
  expect(again.deduped).toBe(true);
  expect(bySid.deduped).toBe(true);
  // One row, no duplicate, no error — the sha256 UNIQUE constraint does it.
  expect(audience.vault.prepare('SELECT COUNT(*) AS n FROM media_media_asset').get()).toEqual({
    n: 1,
  });
  expect(audience.vault.prepare('SELECT COUNT(*) AS n FROM core_content_item').get()).toEqual({
    n: 1,
  });
  expect(audience.vault.prepare('SELECT COUNT(*) AS n FROM core_content_derivative').get()).toEqual(
    {
      n: 1,
    },
  );
  // The FIRST placement is the record — a later sharer does not rewrite it.
  const provenance = readShareOrigin(audience.vault, 'media.media_asset', first.itemId)!;
  expect(provenance.sharedByMember).toBe('member-priya');
  expect(provenance.sharedAt).toBe(1_000);
  // Re-sharing never re-places bytes it already has.
  expect(bySid.blobs.map((b) => b.mode)).toEqual(['present', 'present']);
});
