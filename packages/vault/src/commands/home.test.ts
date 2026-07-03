import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { registerHomeCommands } from './home.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerHomeCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

function addItem(input: Record<string, unknown>): string {
  const outcome = invoke('home.add_item', input);
  expect(outcome.status).toBe('executed');
  return (outcome as { output: { item_id: string } }).output.item_id;
}

test('add_item lands an owned, undisposed asset item', () => {
  const itemId = addItem({
    name: 'Espresso machine',
    acquired_on: '2025-11-02',
    serial_no: 'EM-778',
  });
  const item = db.vault.prepare('SELECT * FROM home_asset_item WHERE item_id = ?').get(itemId);
  expect(item).toMatchObject({
    name: 'Espresso machine',
    owner_party_id: boot.ownerPartyId,
    acquired_on: '2025-11-02',
    serial_no: 'EM-778',
    disposed_on: null,
  });
});

test('update_item revises fields it was asked to and nothing else', () => {
  const itemId = addItem({ name: 'Bike' });
  const outcome = invoke('home.update_item', {
    item_id: itemId,
    name: 'Road bike',
    serial_no: 'RB-1',
  });
  expect(outcome.status).toBe('executed');
  const item = db.vault
    .prepare('SELECT name, serial_no, acquired_on FROM home_asset_item WHERE item_id = ?')
    .get(itemId);
  expect(item).toMatchObject({ name: 'Road bike', serial_no: 'RB-1', acquired_on: null });
});

test('dispose_item stamps the lifecycle date once; a second disposal is refused', () => {
  const itemId = addItem({ name: 'Old couch' });
  const outcome = invoke('home.dispose_item', { item_id: itemId });
  expect(outcome.status).toBe('executed');
  const item = db.vault
    .prepare('SELECT disposed_on FROM home_asset_item WHERE item_id = ?')
    .get(itemId) as { disposed_on: string | null };
  expect(item.disposed_on).not.toBeNull();
  const again = invoke('home.dispose_item', { item_id: itemId });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('item_exists_and_owned');
});

test('add_warranty decorates an item and refuses an inverted term', () => {
  const itemId = addItem({ name: 'Washing machine' });
  const outcome = invoke('home.add_warranty', {
    item_id: itemId,
    starts_on: '2026-01-01',
    ends_on: '2028-01-01',
    claim_uri: 'https://example.com/claims',
  });
  expect(outcome.status).toBe('executed');
  const warrantyId = (outcome as { output: { warranty_id: string } }).output.warranty_id;
  const warranty = db.vault
    .prepare('SELECT item_id, ends_on FROM home_warranty WHERE warranty_id = ?')
    .get(warrantyId);
  expect(warranty).toMatchObject({ item_id: itemId, ends_on: '2028-01-01' });
  const inverted = invoke('home.add_warranty', {
    item_id: itemId,
    starts_on: '2028-01-01',
    ends_on: '2026-01-01',
  });
  expect(inverted.status).toBe('failed');
  if (inverted.status === 'failed') expect(inverted.predicate).toContain('ends_not_before_starts');
});
