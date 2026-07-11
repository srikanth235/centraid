// Near-duplicate clustering (issue #352 phase 3/4) — see clusters.ts header
// for the app-plane gap this closes (media_asset_phash was unreachable from
// consent.app_view: no SQL functions, no registered logical entity).

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerMediaCommands } from '../commands/media.js';
import { recomputeDuplicateClusters } from './clusters.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerMediaCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

/** Distinct pixel data URIs so each mints its OWN asset (sha256 differs). */
const PIXELS = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
];

function addAssetVariant(index: number, phash: string): string {
  const outcome = gw.invoke(owner, {
    command: 'media.add_asset',
    input: { data_uri: PIXELS[index], phash },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  return (outcome as { status: 'executed'; output: { asset_id: string } }).output.asset_id;
}

test('assets within the hamming threshold cluster together with a deterministic id', () => {
  const a = addAssetVariant(0, 'ff00ff00');
  const b = addAssetVariant(1, 'ff00ff01'); // hamming distance 1 from a
  const c = addAssetVariant(2, '00000000'); // far from both
  const result = recomputeDuplicateClusters(db.vault);
  expect(result.clusters).toBe(1);
  expect(result.clustered).toBe(2);
  const rows = db.vault
    .prepare('SELECT asset_id, cluster_id FROM media_asset_phash WHERE asset_id IN (?, ?, ?)')
    .all(a, b, c) as { asset_id: string; cluster_id: string | null }[];
  const byId = new Map(rows.map((r) => [r.asset_id, r.cluster_id]));
  expect(byId.get(a)).not.toBeNull();
  expect(byId.get(a)).toBe(byId.get(b));
  expect(byId.get(c)).toBeNull();
  // Deterministic: the cluster id is the lowest asset_id in the group.
  expect(byId.get(a)).toBe([a, b].sort()[0]);
});

test('a trashed asset drops out of its cluster on recompute', () => {
  const a = addAssetVariant(0, 'aaaaaaaa');
  const b = addAssetVariant(1, 'aaaaaaab');
  recomputeDuplicateClusters(db.vault);
  gw.invoke(owner, {
    command: 'media.delete_asset',
    input: { asset_id: a },
    purpose: 'dpv:ServiceProvision',
  });
  const result = recomputeDuplicateClusters(db.vault);
  expect(result.clusters).toBe(0);
  const row = db.vault
    .prepare('SELECT cluster_id FROM media_asset_phash WHERE asset_id = ?')
    .get(b) as { cluster_id: string | null };
  expect(row.cluster_id).toBeNull();
});

test('the standing sweep (gateway.sweep) recomputes clusters automatically', () => {
  const a = addAssetVariant(0, 'bbbbbbbb');
  const b = addAssetVariant(1, 'bbbbbbbc');
  gw.sweep(owner);
  const rows = db.vault
    .prepare('SELECT cluster_id FROM media_asset_phash WHERE asset_id IN (?, ?)')
    .all(a, b) as { cluster_id: string | null }[];
  expect(rows.every((r) => r.cluster_id !== null)).toBe(true);
});

test('clusters are read through the registered media.asset_phash entity, no SQL function needed', () => {
  const a = addAssetVariant(0, 'cccccccc');
  const b = addAssetVariant(1, 'cccccccd');
  recomputeDuplicateClusters(db.vault);
  const rows = gw.read(owner, {
    entity: 'media.asset_phash',
    where: [{ column: 'cluster_id', op: 'not-null' }],
    purpose: 'dpv:ServiceProvision',
  }).rows;
  expect(rows.map((r) => r.asset_id).sort()).toEqual([a, b].sort());
});
