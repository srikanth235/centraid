// Runtime schema gate for ingest publisher payloads (issue #374 Tier 3).
// publishers.ts/enrich-publishers.ts used to trust a staged payload's shape
// on nothing but a compile-time `as unknown as X` cast. csv.ts happens to
// hand off real JS numbers today, so this seam is dormant — these tests
// hand-craft StageCandidates the way a FUTURE connector could (a decimal
// STRING amount, a payload missing a required field) to prove
// assertPayload rejects them before any SQL runs, the same way a declared
// command's input schema violation would.

import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import type { Identity } from '../gateway/types.js';
import { PUBLISHERS } from './publishers.js';
import { applyBatchTx, ensureConnectionTx, stageBatchTx, type StageCandidate } from './staging.js';

let db: VaultDb;
let owner: Identity;

beforeEach(() => {
  db = openVaultDb();
  const boot: BootstrapResult = bootstrapVault(db, { ownerName: 'Priya' });
  owner = {
    kind: 'owner-device',
    callerId: boot.deviceId,
    provAgentKind: 'owner',
    partyId: boot.ownerPartyId,
    mayAct: true,
  };
});

/** Stage + immediately publish one hand-built candidate — bypasses every
 * file parser so the payload shape is exactly what the test asserts. */
function publishOne(candidate: StageCandidate) {
  const connectionId = ensureConnectionTx(db.vault, { kind: 'test', label: 'schema-gate' });
  const now = new Date().toISOString();
  const { batchId } = stageBatchTx(
    db.vault,
    connectionId,
    [candidate],
    PUBLISHERS,
    now,
    db.sealKey,
  );
  return applyBatchTx(db.vault, batchId, PUBLISHERS, owner.partyId ?? '', now, db.sealKey);
}

test('valid transaction payload still publishes exactly as before', () => {
  const result = publishOne({
    entityType: 'core.transaction',
    externalId: 'txn-ok-1',
    payload: {
      externalId: 'txn-ok-1',
      postedAt: '2026-07-01T00:00:00Z',
      description: 'Groceries',
      amountMinor: 184250,
      currency: 'INR',
      direction: 'debit',
      accountName: 'HDFC Savings',
    },
  });
  expect(result.failed).toEqual([]);
  expect(result.created).toBe(1);
  const txn = db.vault
    .prepare('SELECT amount_minor, currency, direction FROM core_transaction WHERE external_id = ?')
    .get('txn-ok-1');
  expect(txn).toMatchObject({ amount_minor: 184250, currency: 'INR', direction: 'debit' });
});

test('valid party payload still publishes exactly as before', () => {
  const result = publishOne({
    entityType: 'core.party',
    externalId: 'email:ravi@example.com',
    payload: {
      fn: 'Ravi Kumar',
      sortName: 'Kumar, Ravi',
      bday: '1988-03-12',
      identifiers: [{ scheme: 'email', value: 'ravi@example.com', label: null }],
    },
  });
  expect(result.failed).toEqual([]);
  expect(result.created).toBe(1);
  const party = db.vault
    .prepare('SELECT display_name, sort_name FROM core_party WHERE display_name = ?')
    .get('Ravi Kumar');
  expect(party).toMatchObject({ display_name: 'Ravi Kumar', sort_name: 'Kumar, Ravi' });
});

test('a decimal-string amount is rejected before any SQL executes', () => {
  const before = db.vault.prepare('SELECT count(*) AS n FROM core_transaction').get() as {
    n: number;
  };
  const result = publishOne({
    entityType: 'core.transaction',
    externalId: 'txn-bad-amount',
    payload: {
      externalId: 'txn-bad-amount',
      postedAt: '2026-07-01T00:00:00Z',
      description: 'Groceries',
      // A future connector staging a decimal STRING — the exploitable seam
      // this gate exists for. Must fail schema validation, not reach SQLite.
      amountMinor: '19.99',
      currency: 'INR',
      direction: 'debit',
      accountName: 'HDFC Savings',
    },
  });
  expect(result.created).toBe(0);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]).toMatchObject({ externalId: 'txn-bad-amount' });
  expect(result.failed[0]!.error).toMatch(/TransactionPayload payload failed schema validation/);
  expect(result.failed[0]!.error).toMatch(/amountMinor/);
  const after = db.vault.prepare('SELECT count(*) AS n FROM core_transaction').get() as {
    n: number;
  };
  expect(after.n).toBe(before.n); // nothing landed
});

test('a payload missing a required field is rejected', () => {
  // `identifiers` stays present and valid so the domain-native probe (which
  // reads it directly, ahead of any write) resolves cleanly to "no match" —
  // isolating the assertion to create()'s runtime gate, the seam this suite
  // covers (issue #374 Tier 3 scopes the gate to WRITE paths).
  const result = publishOne({
    entityType: 'core.party',
    externalId: 'email:missing@example.com',
    payload: {
      sortName: null,
      bday: null,
      identifiers: [{ scheme: 'email', value: 'missing@example.com', label: null }],
      // `fn` omitted entirely.
    },
  });
  expect(result.created).toBe(0);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]!.error).toMatch(/PartyPayload payload failed schema validation/);
  expect(result.failed[0]!.error).toMatch(/missing required "fn"/);
  // Nothing landed beyond the owner party bootstrapVault already minted.
  const parties = db.vault.prepare('SELECT count(*) AS n FROM core_party').get() as { n: number };
  expect(parties.n).toBe(1);
});

test('locker.item payload missing a required field is rejected', () => {
  const result = publishOne({
    entityType: 'locker.item',
    externalId: 'login:test:user',
    payload: {
      title: 'Test Login',
      url: null,
      username: 'user',
      password: 'hunter2',
      otpSeed: null,
      // `notes` omitted entirely.
    },
  });
  expect(result.created).toBe(0);
  expect(result.failed).toHaveLength(1);
  expect(result.failed[0]!.error).toMatch(/LockerItemPayload payload failed schema validation/);
  expect(result.failed[0]!.error).toMatch(/missing required "notes"/);
  const item = db.vault
    .prepare('SELECT count(*) AS n FROM locker_item WHERE title = ?')
    .get('Test Login') as { n: number };
  expect(item.n).toBe(0);
});
