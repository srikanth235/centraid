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
    .prepare('SELECT cover_asset_id FROM media_album WHERE album_id = ?')
    .get(albumId) as { cover_asset_id: string };
  expect(album.cover_asset_id).toBe(a.asset_id);
  // Twice into the same album is a receipted refusal, not a UNIQUE throw.
  const dup = invoke('media.add_to_album', { album_id: albumId, asset_id: a.asset_id });
  expect(dup.status).toBe('failed');
  expect(
    invoke('media.remove_from_album', { album_id: albumId, asset_id: a.asset_id }).status,
  ).toBe('executed');
  album = db.vault
    .prepare('SELECT cover_asset_id FROM media_album WHERE album_id = ?')
    .get(albumId) as { cover_asset_id: string };
  expect(album.cover_asset_id).toBe(b.asset_id);
});

test('rename_album and delete_album curate without touching assets', () => {
  const { asset_id } = addAsset({ data_uri: PIXEL });
  const albumId = createAlbum('Trip');
  invoke('media.add_to_album', { album_id: albumId, asset_id });
  expect(invoke('media.rename_album', { album_id: albumId, title: 'Goa 2026' }).status).toBe(
    'executed',
  );
  expect(invoke('media.delete_album', { album_id: albumId }).status).toBe('executed');
  const albums = db.vault.prepare('SELECT count(*) AS n FROM media_album').get() as { n: number };
  expect(albums.n).toBe(0);
  const assets = db.vault.prepare('SELECT count(*) AS n FROM media_media_asset').get() as {
    n: number;
  };
  expect(assets.n).toBe(1);
});

test('delete_asset removes the meaning rows and soft-deletes unreferenced bytes', () => {
  const { asset_id, content_id } = addAsset({ data_uri: PIXEL });
  const albumId = createAlbum('Trip');
  invoke('media.add_to_album', { album_id: albumId, asset_id });
  const outcome = invoke('media.delete_asset', { asset_id });
  expect(outcome.status).toBe('executed');
  expect((outcome as { output: { content_released: number } }).output.content_released).toBe(1);
  const entries = db.vault.prepare('SELECT count(*) AS n FROM media_album_entry').get() as {
    n: number;
  };
  expect(entries.n).toBe(0);
  const album = db.vault
    .prepare('SELECT cover_asset_id FROM media_album WHERE album_id = ?')
    .get(albumId) as { cover_asset_id: string | null };
  expect(album.cover_asset_id).toBeNull();
  const content = db.vault
    .prepare('SELECT deleted_at, purge_at FROM core_content_item WHERE content_id = ?')
    .get(content_id) as { deleted_at: string | null; purge_at: string | null };
  expect(content.deleted_at).not.toBeNull();
  expect(content.purge_at).not.toBeNull();
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
