import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerSubscriptionCommands } from './subscriptions.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let accountId: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerSubscriptionCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  accountId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
       VALUES (?, ?, 'Everyday', 'depository', 'EUR', 1)`,
    )
    .run(accountId, boot.ownerPartyId);
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:ServiceProvision' });
}

test('add_subscription records an active series with a tolerance default', () => {
  const out = invoke('finance.add_subscription', {
    account_id: accountId,
    expected_minor: 1499,
    rrule: 'FREQ=MONTHLY',
  });
  expect(out.status).toBe('executed');
  const seriesId = (out as { output: { series_id: string } }).output.series_id;
  const row = db.vault
    .prepare(
      'SELECT account_id, expected_minor, rrule, tolerance_pct, status FROM finance_recurring_series WHERE series_id = ?',
    )
    .get(seriesId);
  expect(row).toMatchObject({
    account_id: accountId,
    expected_minor: 1499,
    rrule: 'FREQ=MONTHLY',
    tolerance_pct: 10,
    status: 'active',
  });
});

test('add_subscription persists an anchor_on when given', () => {
  const out = invoke('finance.add_subscription', {
    account_id: accountId,
    expected_minor: 1499,
    rrule: 'FREQ=MONTHLY',
    anchor_on: '2026-07-15',
  });
  expect(out.status).toBe('executed');
  const seriesId = (out as { output: { series_id: string } }).output.series_id;
  const row = db.vault
    .prepare('SELECT anchor_on FROM finance_recurring_series WHERE series_id = ?')
    .get(seriesId) as { anchor_on: string | null };
  expect(row.anchor_on).toBe('2026-07-15');
});

test('add_subscription against a missing account is refused', () => {
  const out = invoke('finance.add_subscription', {
    account_id: 'no-such-account',
    expected_minor: 999,
    rrule: 'FREQ=MONTHLY',
  });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('account_exists');
});

test('update_subscription rewrites only the fields it was given', () => {
  const added = invoke('finance.add_subscription', {
    account_id: accountId,
    expected_minor: 1499,
    rrule: 'FREQ=MONTHLY',
    anchor_on: '2026-01-01',
  });
  const seriesId = (added as { output: { series_id: string } }).output.series_id;

  const out = invoke('finance.update_subscription', {
    series_id: seriesId,
    expected_minor: 1799,
    anchor_on: '2026-08-01',
  });
  expect(out.status).toBe('executed');
  const row = db.vault
    .prepare(
      'SELECT expected_minor, anchor_on, rrule, tolerance_pct, status FROM finance_recurring_series WHERE series_id = ?',
    )
    .get(seriesId);
  expect(row).toMatchObject({
    expected_minor: 1799,
    anchor_on: '2026-08-01',
    // Untouched fields keep their original values.
    rrule: 'FREQ=MONTHLY',
    tolerance_pct: 10,
    status: 'active',
  });
});

test('update_subscription on an unknown series is refused', () => {
  const out = invoke('finance.update_subscription', { series_id: 'ghost', expected_minor: 500 });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('series_exists');
});

test('update_subscription with an unknown counterparty is refused', () => {
  const added = invoke('finance.add_subscription', {
    account_id: accountId,
    expected_minor: 999,
    rrule: 'FREQ=MONTHLY',
  });
  const seriesId = (added as { output: { series_id: string } }).output.series_id;

  const out = invoke('finance.update_subscription', {
    series_id: seriesId,
    counterparty_party_id: 'no-such-party',
  });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('counterparty_exists_if_given');
});

test('set_subscription_status pauses then ends a series', () => {
  const added = invoke('finance.add_subscription', {
    account_id: accountId,
    expected_minor: 999,
    rrule: 'FREQ=WEEKLY',
  });
  const seriesId = (added as { output: { series_id: string } }).output.series_id;

  const paused = invoke('finance.set_subscription_status', {
    series_id: seriesId,
    status: 'paused',
  });
  expect(paused.status).toBe('executed');
  const ended = invoke('finance.set_subscription_status', { series_id: seriesId, status: 'ended' });
  expect(ended.status).toBe('executed');
  const row = db.vault
    .prepare('SELECT status FROM finance_recurring_series WHERE series_id = ?')
    .get(seriesId) as { status: string };
  expect(row.status).toBe('ended');
});

test('set_subscription_status on an unknown series is refused', () => {
  const out = invoke('finance.set_subscription_status', { series_id: 'ghost', status: 'paused' });
  expect(out.status).toBe('failed');
  if (out.status === 'failed') expect(out.predicate).toContain('series_exists');
});
