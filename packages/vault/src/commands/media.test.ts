import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerAttachmentCommands } from './attachments.js';
import { registerMediaCommands } from './media.js';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CLIP = 'data:video/mp4;base64,AAAAHGZ0eXBpc29t';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerMediaCommands(gw);
  registerAttachmentCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addAsset(input: Record<string, unknown>): { asset_id: string; content_id: string } {
  const outcome = invoke('media.add_asset', input);
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { asset_id: string; content_id: string } }).output;
}

function createAlbum(title: string): string {
  const outcome = invoke('media.create_album', { title });
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { album_id: string } }).output.album_id;
}

test('add_asset lands content item + asset, kind inferred from the media type', () => {
  const photo = addAsset({ data_uri: PIXEL, captured_at: '2026-06-01T10:00:00Z' });
  const clip = addAsset({ data_uri: CLIP });
  const photoRow = db.vault
    .prepare('SELECT kind, captured_at FROM media_media_asset WHERE asset_id = ?')
    .get(photo.asset_id) as { kind: string; captured_at: string };
  expect(photoRow).toMatchObject({ kind: 'photo', captured_at: '2026-06-01T10:00:00Z' });
  const clipRow = db.vault
    .prepare('SELECT kind FROM media_media_asset WHERE asset_id = ?')
    .get(clip.asset_id) as { kind: string };
  expect(clipRow.kind).toBe('video');
});

test('add_asset dedupes identical bytes onto one asset (content_id is UNIQUE)', () => {
  const first = addAsset({ data_uri: PIXEL });
  const second = invoke('media.add_asset', { data_uri: PIXEL });
  expect(second.status).toBe('executed');
  const output = (second as { output: { asset_id: string; deduped: number } }).output;
  expect(output.asset_id).toBe(first.asset_id);
  expect(output.deduped).toBe(1);
});

test('update_asset revises capture time and caption (title on the content item)', () => {
  const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
  const outcome = invoke('media.update_asset', {
    asset_id,
    captured_at: '2025-12-25T08:00:00Z',
    title: 'Christmas morning',
  });
  expect(outcome.status).toBe('executed');
  const content = db.vault
    .prepare('SELECT title FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { title: string };
  expect(content.title).toBe('Christmas morning');
});

test('albums: entries keep positions, first photo becomes cover, cover hands off on removal', () => {
  const a = addAsset({ data_uri: PIXEL });
  const b = addAsset({ data_uri: CLIP });
  const albumId = createAlbum('Trip');
  expect(invoke('media.add_to_album', { album_id: albumId, asset_id: a.asset_id }).status).toBe(
    'executed',
  );
  expect(invoke('media.add_to_album', { album_id: albumId, asset_id: b.asset_id }).status).toBe(
    'executed',
  );
  let album = db.vault
    .prepare('SELECT cover_content_id FROM core_collection WHERE collection_id = ?')
    .get(albumId) as { cover_content_id: string };
  expect(album.cover_content_id).toBe(a.content_id);
  // Twice into the same album is a receipted refusal, not a UNIQUE throw.
  const dup = invoke('media.add_to_album', { album_id: albumId, asset_id: a.asset_id });
  expect(dup.status).toBe('failed');
  expect(
    invoke('media.remove_from_album', { album_id: albumId, asset_id: a.asset_id }).status,
  ).toBe('executed');
  album = db.vault
    .prepare('SELECT cover_content_id FROM core_collection WHERE collection_id = ?')
    .get(albumId) as { cover_content_id: string };
  expect(album.cover_content_id).toBe(b.content_id);
});

test('rename_album and delete_album curate without touching assets', () => {
  const { asset_id } = addAsset({ data_uri: PIXEL });
  const albumId = createAlbum('Trip');
  invoke('media.add_to_album', { album_id: albumId, asset_id });
  expect(invoke('media.rename_album', { album_id: albumId, title: 'Goa 2026' }).status).toBe(
    'executed',
  );
  expect(invoke('media.delete_album', { album_id: albumId }).status).toBe('executed');
  const albums = db.vault.prepare('SELECT count(*) AS n FROM core_collection').get() as {
    n: number;
  };
  expect(albums.n).toBe(0);
  const assets = db.vault.prepare('SELECT count(*) AS n FROM media_media_asset').get() as {
    n: number;
  };
  expect(assets.n).toBe(1);
});

test('delete_asset trashes the asset, leaves albums, and soft-deletes unreferenced bytes', () => {
  const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
  const albumId = createAlbum('Trip');
  invoke('media.add_to_album', { album_id: albumId, asset_id });
  const outcome = invoke('media.delete_asset', { asset_id });
  expect(outcome.status).toBe('executed');
  expect((outcome as { output: { content_released: number } }).output.content_released).toBe(1);
  const entries = db.vault.prepare('SELECT count(*) AS n FROM core_collection_entry').get() as {
    n: number;
  };
  expect(entries.n).toBe(0);
  const album = db.vault
    .prepare('SELECT cover_content_id FROM core_collection WHERE collection_id = ?')
    .get(albumId) as { cover_content_id: string | null };
  expect(album.cover_content_id).toBeNull();
  // The asset row survives in the trash with its own grace window (issue
  // #274) — restore can bring it back whole.
  const asset = db.vault
    .prepare('SELECT deleted_at, purge_at FROM media_media_asset WHERE asset_id = ?')
    .get(asset_id) as { deleted_at: string | null; purge_at: string | null };
  expect(asset.deleted_at).not.toBeNull();
  expect(asset.purge_at).not.toBeNull();
  const content = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { deleted_at: string | null; purge_at: string | null };
  expect(content.deleted_at).not.toBeNull();
  expect(content.purge_at).not.toBeNull();
  // Trash is one-way per asset: a second delete fails its precondition.
  const again = invoke('media.delete_asset', { asset_id });
  expect(again.status).toBe('failed');
});

test('update_asset toggles favorite as a starred tag on the canonical content item', () => {
  const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
  const starred = () =>
    db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_type = 'core.content_item' AND t.target_id = ?
            AND s.uri = 'https://centraid.dev/schemes/flags' AND c.notation = 'starred'`,
      )
      .get(content_id) as { n: number };
  expect(invoke('media.update_asset', { asset_id, favorite: 1 }).status).toBe('executed');
  expect(starred().n).toBe(1);
  // Re-favoriting stays a single tag (UNIQUE target+concept, delete-then-insert).
  expect(invoke('media.update_asset', { asset_id, favorite: 1 }).status).toBe('executed');
  expect(starred().n).toBe(1);
  expect(invoke('media.update_asset', { asset_id, favorite: 0 }).status).toBe('executed');
  expect(starred().n).toBe(0);
});

test('restore_asset brings a trashed asset and its bytes back; restoring live fails', () => {
  const { asset_id, content_id } = addAsset({
    data_uri: PIXEL,
    captured_at: '2026-01-01T00:00:00Z',
  });
  // Restoring a live asset is a receipted refusal.
  expect(invoke('media.restore_asset', { asset_id }).status).toBe('failed');
  invoke('media.delete_asset', { asset_id });
  const outcome = invoke('media.restore_asset', { asset_id });
  expect(outcome.status).toBe('executed');
  const asset = db.vault
    .prepare('SELECT deleted_at, captured_at FROM media_media_asset WHERE asset_id = ?')
    .get(asset_id) as { deleted_at: string | null; captured_at: string };
  expect(asset.deleted_at).toBeNull();
  expect(asset.captured_at).toBe('2026-01-01T00:00:00Z'); // metadata survives the round trip
  const content = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { deleted_at: string | null; purge_at: string | null };
  expect(content.deleted_at).toBeNull();
  expect(content.purge_at).toBeNull();
});

test('delete_asset keeps bytes another canonical row still rents', () => {
  const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
  // The same bytes also ride as an attachment on the owner party.
  const attach = invoke('core.attach', {
    subject_type: 'core.party',
    subject_id: boot.ownerPartyId,
    data_uri: PIXEL,
  });
  expect(attach.status).toBe('executed');
  const outcome = invoke('media.delete_asset', { asset_id });
  expect(outcome.status).toBe('executed');
  expect((outcome as { output: { content_released: number } }).output.content_released).toBe(0);
  const content = db.vault
    .prepare('SELECT deleted_at FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { deleted_at: string | null };
  expect(content.deleted_at).toBeNull();
});

test('re-uploading trashed bytes restores them', () => {
  const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
  invoke('media.delete_asset', { asset_id });
  const again = addAsset({ data_uri: PIXEL });
  expect(again.content_id).toBe(content_id);
  const content = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { deleted_at: string | null; purge_at: string | null };
  expect(content.deleted_at).toBeNull();
  expect(content.purge_at).toBeNull();
});

// ---------- geolocation linking (issue #352 phase 3/4) ----------

/**
 * A minimal JPEG whose APP1/EXIF block carries GPS lat/lng as degree+minute
 * rationals (seconds 0) — same construction as blob/blob.test.ts's
 * `exifJpeg`, parametrized so distinct calls can share or differ on
 * location, and `padding` diversifies the sha256 of two same-location shots
 * (trailing bytes after EOI are never walked by the EXIF/dimension parsers).
 */
function exifJpegAt(
  latDeg: number,
  latRef: 'N' | 'S',
  lonDeg: number,
  lonRef: 'E' | 'W',
  padding = 0,
): Buffer {
  const entrySize = 12;
  const ifd0At = 8;
  const gpsIfdAt = ifd0At + 2 + 1 * entrySize + 4;
  const dataAt = gpsIfdAt + 2 + 4 * entrySize + 4;
  const latAt = dataAt;
  const lonAt = latAt + 24;
  const tiff = Buffer.alloc(lonAt + 24);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(ifd0At, 4);
  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number,
    inlineAscii?: string,
  ) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (inlineAscii !== undefined) tiff.write(inlineAscii, at + 8, 'latin1');
    else tiff.writeUInt32LE(value, at + 8);
  };
  tiff.writeUInt16LE(1, ifd0At);
  entry(ifd0At + 2, 0x8825, 4, 1, gpsIfdAt);
  tiff.writeUInt16LE(4, gpsIfdAt);
  entry(gpsIfdAt + 2, 0x0001, 2, 2, 0, `${latRef}\0`);
  entry(gpsIfdAt + 2 + entrySize, 0x0002, 5, 3, latAt);
  entry(gpsIfdAt + 2 + 2 * entrySize, 0x0003, 2, 2, 0, `${lonRef}\0`);
  entry(gpsIfdAt + 2 + 3 * entrySize, 0x0004, 5, 3, lonAt);
  const rational = (at: number, values: [number, number][]) => {
    values.forEach(([num, den], i) => {
      tiff.writeUInt32LE(num, at + i * 8);
      tiff.writeUInt32LE(den, at + i * 8 + 4);
    });
  };
  rational(latAt, [
    [latDeg, 1],
    [0, 1],
    [0, 1],
  ]);
  rational(lonAt, [
    [lonDeg, 1],
    [0, 1],
    [0, 1],
  ]);
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    exifBody,
    Buffer.from([0xff, 0xd9]),
    Buffer.alloc(padding, padding % 251 || 1),
  ]);
}

function stageAndAdd(jpeg: Buffer): { asset_id: string; content_id: string } {
  const staged = gw.stageBlob(owner, { bytes: jpeg, filename: 'photo.jpg' });
  return addAsset({ staged_sha: staged.sha256 });
}

test('add_asset with EXIF GPS finds-or-creates a core.place and links it', () => {
  const { asset_id } = stageAndAdd(exifJpegAt(37, 'N', 122, 'W'));
  const asset = db.vault
    .prepare('SELECT place_id FROM media_media_asset WHERE asset_id = ?')
    .get(asset_id) as { place_id: string | null };
  expect(asset.place_id).not.toBeNull();
  const place = db.vault
    .prepare('SELECT geo_lat, geo_lng FROM core_place WHERE place_id = ?')
    .get(asset.place_id) as { geo_lat: number; geo_lng: number };
  expect(place.geo_lat).toBeCloseTo(37, 3);
  expect(place.geo_lng).toBeCloseTo(-122, 3);
});

test('two photos at the same rounded coordinates share one core.place', () => {
  const first = stageAndAdd(exifJpegAt(37, 'N', 122, 'W', 1));
  const second = stageAndAdd(exifJpegAt(37, 'N', 122, 'W', 2));
  const places = db.vault
    .prepare('SELECT place_id FROM media_media_asset WHERE asset_id IN (?, ?)')
    .all(first.asset_id, second.asset_id) as { place_id: string }[];
  expect(places[0]?.place_id).toBe(places[1]?.place_id);
  const count = db.vault.prepare('SELECT count(*) AS n FROM core_place').get() as { n: number };
  expect(count.n).toBe(1);
});

test('a photo at a different location gets a different core.place', () => {
  const first = stageAndAdd(exifJpegAt(37, 'N', 122, 'W', 1));
  const second = stageAndAdd(exifJpegAt(10, 'N', 20, 'E', 2));
  const rows = db.vault
    .prepare('SELECT place_id FROM media_media_asset WHERE asset_id IN (?, ?)')
    .all(first.asset_id, second.asset_id) as { place_id: string }[];
  expect(rows[0]?.place_id).not.toBe(rows[1]?.place_id);
});

test('a photo with no GPS gets no place', () => {
  const { asset_id } = addAsset({ data_uri: PIXEL });
  const asset = db.vault
    .prepare('SELECT place_id FROM media_media_asset WHERE asset_id = ?')
    .get(asset_id) as { place_id: string | null };
  expect(asset.place_id).toBeNull();
});

test('media.set_asset_place sets and clears an asset location explicitly', () => {
  const { asset_id } = addAsset({ data_uri: PIXEL });
  const placeId = 'test-place-1';
  db.vault
    .prepare(
      `INSERT INTO core_place (place_id, name, kind, geo_lat, geo_lng, created_at)
       VALUES (?, 'Home', 'home', 12.9, 77.6, datetime('now'))`,
    )
    .run(placeId);
  const set = invoke('media.set_asset_place', { asset_id, place_id: placeId });
  expect(set.status).toBe('executed');
  expect(
    (
      db.vault
        .prepare('SELECT place_id FROM media_media_asset WHERE asset_id = ?')
        .get(asset_id) as { place_id: string }
    ).place_id,
  ).toBe(placeId);

  const cleared = invoke('media.set_asset_place', { asset_id });
  expect(cleared.status).toBe('executed');
  expect(
    (
      db.vault
        .prepare('SELECT place_id FROM media_media_asset WHERE asset_id = ?')
        .get(asset_id) as { place_id: string | null }
    ).place_id,
  ).toBeNull();
});

test('media.set_asset_place refuses an unknown place id', () => {
  const { asset_id } = addAsset({ data_uri: PIXEL });
  const outcome = invoke('media.set_asset_place', { asset_id, place_id: 'nope' });
  expect(outcome.status).not.toBe('executed');
});
