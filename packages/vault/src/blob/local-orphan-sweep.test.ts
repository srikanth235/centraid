// The packaged local orphan reclaim (issue #599 decision 11). Real vaults on
// real disk — the load-bearing claims are filesystem facts (which directory
// entry goes, which inode survives), so nothing here is mocked.

import { statSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { shareToVault, unshareFromVault } from '../share/placement.js';
import { casPath, closeOpenVaults, household, seedPhoto } from '../share/placement-fixture.js';
import { sweepLocalOrphans } from './local-orphan-sweep.js';

afterEach(closeOpenVaults);

const DAY = 24 * 60 * 60 * 1000;

test('an unshared blob is held for the grace window, then reclaimed', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'sweep-a');
  const shared = shareToVault({
    origin,
    originVaultId: 'vault-priya',
    audience,
    itemType: 'media.media_asset',
    itemId: photo.assetId,
    sharedByMember: 'member-priya',
  });
  unshareFromVault({ audience, itemType: 'media.media_asset', itemId: shared.itemId });

  // First sight tombstones, never deletes — the grace clock starts here.
  const first = sweepLocalOrphans(audience, { graceWindowMs: 3 * DAY, now: 1_000 });
  expect(first.deleted).toEqual([]);
  expect(first.graceHeld.sort()).toEqual([photo.sha256, photo.thumbSha].sort());
  expect(audience.blobs.hasSync(photo.sha256)).toBe(true);

  // Inside the window it is still held, and the clock does NOT reset.
  expect(
    sweepLocalOrphans(audience, { graceWindowMs: 3 * DAY, now: 1_000 + 2 * DAY }).deleted,
  ).toEqual([]);

  const reclaimed = sweepLocalOrphans(audience, {
    graceWindowMs: 3 * DAY,
    now: 1_000 + 4 * DAY,
  });
  expect(reclaimed.deleted.sort()).toEqual([photo.sha256, photo.thumbSha].sort());
  expect(audience.blobs.hasSync(photo.sha256)).toBe(false);
});

test('a live blob is never reclaimed, however long the sweep runs', () => {
  const { origin, originBoot } = household();
  const photo = seedPhoto(origin, originBoot, 'sweep-b');

  for (const now of [1_000, 1_000 + 400 * DAY]) {
    const pass = sweepLocalOrphans(origin, { graceWindowMs: 0, now });
    expect(pass.deleted).toEqual([]);
    expect(pass.graceHeld).toEqual([]);
  }
  expect(origin.blobs.getSync(photo.sha256)).toEqual(photo.bytes);
});

test('a caller-supplied extra root pins bytes the live model has already dropped', () => {
  const { origin, originBoot } = household();
  const photo = seedPhoto(origin, originBoot, 'sweep-c');
  origin.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(photo.assetId);
  origin.vault
    .prepare('DELETE FROM core_content_derivative WHERE content_id = ?')
    .run(photo.contentId);
  origin.vault.prepare('DELETE FROM core_content_item WHERE content_id = ?').run(photo.contentId);

  const pinned = new Set([photo.sha256]);
  sweepLocalOrphans(origin, { graceWindowMs: 0, now: 1_000, extraLiveRoots: pinned });
  const second = sweepLocalOrphans(origin, {
    graceWindowMs: 0,
    now: 2_000,
    extraLiveRoots: pinned,
  });

  expect(second.deleted).toEqual([photo.thumbSha]);
  expect(origin.blobs.getSync(photo.sha256)).toEqual(photo.bytes);
});

test('reclaiming one vault never takes bytes another vault still links', () => {
  const { origin, originBoot, audience } = household();
  const photo = seedPhoto(origin, originBoot, 'sweep-d');
  shareToVault({
    origin,
    originVaultId: 'vault-priya',
    audience,
    itemType: 'media.media_asset',
    itemId: photo.assetId,
    sharedByMember: 'member-priya',
  });
  const sharedIno = statSync(casPath(audience, photo.sha256)).ino;

  // The owner deletes the photo from their own library; their sweep now sees
  // the bytes as orphaned HERE and unlinks their own directory entry.
  origin.vault.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(photo.assetId);
  origin.vault
    .prepare('DELETE FROM core_content_derivative WHERE content_id = ?')
    .run(photo.contentId);
  origin.vault.prepare('DELETE FROM core_content_item WHERE content_id = ?').run(photo.contentId);
  sweepLocalOrphans(origin, { graceWindowMs: 0, now: 1_000 });
  const reclaimed = sweepLocalOrphans(origin, { graceWindowMs: 0, now: 2_000 });

  expect(reclaimed.deleted.sort()).toEqual([photo.sha256, photo.thumbSha].sort());
  expect(origin.blobs.hasSync(photo.sha256)).toBe(false);
  // The family's copy reads exactly as before — same inode, still one link.
  expect(audience.blobs.getSync(photo.sha256)).toEqual(photo.bytes);
  expect(statSync(casPath(audience, photo.sha256)).ino).toBe(sharedIno);
  expect(sweepLocalOrphans(audience, { graceWindowMs: 0, now: 2_000 }).deleted).toEqual([]);
});
