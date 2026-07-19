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

test('add_item and update_item carry room and value; place must exist, price names a currency', () => {
  const placeId = 'place-kitchen';
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_place (place_id, name, kind, created_at) VALUES (?, 'Kitchen', 'venue', ?)`,
    )
    .run(placeId, now);

  const itemId = addItem({
    name: 'Espresso machine',
    place_id: placeId,
    purchase_price_minor: 64900,
    purchase_currency: 'EUR',
  });
  const item = db.vault
    .prepare(
      'SELECT place_id, purchase_price_minor, purchase_currency FROM home_asset_item WHERE item_id = ?',
    )
    .get(itemId);
  expect(item).toMatchObject({
    place_id: placeId,
    purchase_price_minor: 64900,
    purchase_currency: 'EUR',
  });

  // Moving rooms and revaluing later both work through update_item.
  const bare = addItem({ name: 'Bookshelf' });
  const moved = invoke('home.update_item', {
    item_id: bare,
    place_id: placeId,
    purchase_price_minor: 12000,
    purchase_currency: 'EUR',
  });
  expect(moved.status).toBe('executed');

  // A phantom room is refused, receipted.
  const ghost = invoke('home.update_item', { item_id: bare, place_id: 'nowhere' });
  expect(ghost.status).toBe('failed');

  // A price with no currency anywhere is refused.
  const naked = invoke('home.add_item', { name: 'TV', purchase_price_minor: 50000 });
  expect(naked.status).toBe('failed');
});

test('a bound purchase is a faithful transaction projection and cannot drift', () => {
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
       VALUES ('home-account', ?, 'Card', 'credit', 'EUR', 0)`,
    )
    .run(boot.ownerPartyId);
  db.vault
    .prepare(
      `INSERT INTO core_transaction
         (txn_id, account_id, posted_at, amount_minor, currency, direction, status, description)
       VALUES ('home-purchase', 'home-account', ?, -64900, 'EUR', 'debit', 'posted', 'Espresso machine')`,
    )
    .run(now);

  const bound = addItem({ name: 'Espresso machine', acquired_txn_id: 'home-purchase' });
  expect(
    db.vault
      .prepare(
        'SELECT acquired_txn_id, purchase_price_minor, purchase_currency FROM home_asset_item WHERE item_id = ?',
      )
      .get(bound),
  ).toMatchObject({
    acquired_txn_id: 'home-purchase',
    purchase_price_minor: 64900,
    purchase_currency: 'EUR',
  });

  const unbound = addItem({
    name: 'Grinder',
    purchase_price_minor: 1000,
    purchase_currency: 'EUR',
  });
  expect(
    invoke('home.update_item', { item_id: unbound, acquired_txn_id: 'home-purchase' }).status,
  ).toBe('executed');
  expect(() =>
    db.vault
      .prepare("UPDATE core_transaction SET currency = 'USD' WHERE txn_id = 'home-purchase'")
      .run(),
  ).toThrow(/bound to an asset purchase/);
  expect(() =>
    db.vault
      .prepare('UPDATE home_asset_item SET purchase_price_minor = 1 WHERE item_id = ?')
      .run(bound),
  ).toThrow(/must agree with its transaction/);
});

test('complete_maintenance stamps last_done_on; a missing plan is refused', () => {
  const itemId = addItem({ name: 'Boiler' });
  const planId = 'plan-descale';
  db.vault
    .prepare(
      `INSERT INTO home_maintenance_plan (plan_id, item_id, name, rrule, last_done_on, instructions_content_id, current_task_id)
       VALUES (?, ?, 'Descale', 'FREQ=MONTHLY', NULL, NULL, NULL)`,
    )
    .run(planId, itemId);
  const outcome = invoke('home.complete_maintenance', { plan_id: planId, done_on: '2026-07-03' });
  expect(outcome.status).toBe('executed');
  const plan = db.vault
    .prepare('SELECT last_done_on FROM home_maintenance_plan WHERE plan_id = ?')
    .get(planId) as { last_done_on: string };
  expect(plan.last_done_on).toBe('2026-07-03');
  expect(
    invoke('home.complete_maintenance', { plan_id: 'ghost', done_on: '2026-07-03' }).status,
  ).toBe('failed');
});
