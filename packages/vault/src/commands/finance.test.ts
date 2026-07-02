import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerFinanceCommands } from './finance.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let txnId: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerFinanceCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  const accountId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
       VALUES (?, ?, 'HDFC Savings', 'depository', 'INR', 1)`,
    )
    .run(accountId, boot.ownerPartyId);
  txnId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, description)
       VALUES (?, ?, '2026-07-01T10:00:00Z', 420000, 'INR', 'debit', 'posted', 'BIGBASKET ORDER 4417')`,
    )
    .run(txnId, accountId);
});

test('categorize_txn changes classification, never the amount', () => {
  const groceries = boot.concepts['groceries'] as string;
  const outcome = gw.invoke(owner, {
    command: 'finance.categorize_txn',
    input: { txn_id: txnId, category_concept_id: groceries },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const txn = db.vault
    .prepare('SELECT category_concept_id, amount_minor FROM core_transaction WHERE txn_id = ?')
    .get(txnId);
  expect(txn).toMatchObject({ category_concept_id: groceries, amount_minor: 420000 });
  // Provenance records the reclassification.
  const prov = db.journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance
        WHERE entity_type='core.transaction' AND entity_id=? AND prov_activity='command.finance.categorize_txn'`,
    )
    .get(txnId) as { n: number };
  expect(prov.n).toBe(1);
});

test('split_txn: the ₹4,200 order that was groceries + a gift (Σ holds)', () => {
  const outcome = gw.invoke(owner, {
    command: 'finance.split_txn',
    input: {
      txn_id: txnId,
      splits: [
        { amount_minor: 300000, category_concept_id: boot.concepts['groceries'] as string },
        {
          amount_minor: 120000,
          category_concept_id: boot.concepts['gifts'] as string,
          memo: 'birthday hamper',
        },
      ],
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const sum = db.vault
    .prepare('SELECT SUM(amount_minor) AS s, count(*) AS n FROM finance_txn_split WHERE txn_id = ?')
    .get(txnId);
  expect(sum).toMatchObject({ s: 420000, n: 2 });
});

test('split_txn Σ-invariant: splits that do not sum to the parent roll back entirely', () => {
  const outcome = gw.invoke(owner, {
    command: 'finance.split_txn',
    input: {
      txn_id: txnId,
      splits: [{ amount_minor: 999, category_concept_id: boot.concepts['groceries'] as string }],
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('failed');
  if (outcome.status === 'failed') expect(outcome.predicate).toContain('splits_sum_to_parent');
  // Rollback proof: nothing landed.
  const splits = db.vault.prepare('SELECT count(*) AS n FROM finance_txn_split').get() as {
    n: number;
  };
  expect(splits.n).toBe(0);
  const inv = db.journal
    .prepare(`SELECT count(*) AS n FROM agent_command_invocation WHERE status='rolled_back'`)
    .get() as { n: number };
  expect(inv.n).toBe(1);
});

test('re-splitting replaces the previous decomposition (still Σ-checked)', () => {
  const groceries = boot.concepts['groceries'] as string;
  gw.invoke(owner, {
    command: 'finance.split_txn',
    input: { txn_id: txnId, splits: [{ amount_minor: 420000, category_concept_id: groceries }] },
    purpose: 'dpv:ServiceProvision',
  });
  gw.invoke(owner, {
    command: 'finance.split_txn',
    input: {
      txn_id: txnId,
      splits: [
        { amount_minor: 400000, category_concept_id: groceries },
        { amount_minor: 20000, category_concept_id: boot.concepts['transport'] as string },
      ],
    },
    purpose: 'dpv:ServiceProvision',
  });
  const splits = db.vault
    .prepare('SELECT count(*) AS n FROM finance_txn_split WHERE txn_id = ?')
    .get(txnId) as {
    n: number;
  };
  expect(splits.n).toBe(2);
});

test('set_budget upserts on (owner, category, period, starts_on)', () => {
  const groceries = boot.concepts['groceries'] as string;
  const first = gw.invoke(owner, {
    command: 'finance.set_budget',
    input: {
      category_concept_id: groceries,
      period: 'month',
      limit_minor: 1500000,
      currency: 'INR',
      starts_on: '2026-07-01',
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(first.status).toBe('executed');
  const second = gw.invoke(owner, {
    command: 'finance.set_budget',
    input: {
      category_concept_id: groceries,
      period: 'month',
      limit_minor: 1200000,
      currency: 'INR',
      starts_on: '2026-07-01',
    },
    purpose: 'dpv:ServiceProvision',
  });
  expect(second.status).toBe('executed');
  const budgets = db.vault.prepare('SELECT limit_minor FROM finance_budget').all();
  expect(budgets).toEqual([{ limit_minor: 1200000 }]);
});

test('flag_anomaly tags the transaction once; a second flag is refused', () => {
  const outcome = gw.invoke(owner, {
    command: 'finance.flag_anomaly',
    input: { txn_id: txnId, reason: 'amount 3x the recurring series expectation', confidence: 0.9 },
    purpose: 'dpv:ServiceProvision',
  });
  expect(outcome.status).toBe('executed');
  const tag = db.vault
    .prepare(
      `SELECT t.confidence, c.notation FROM core_tag t JOIN core_concept c ON c.concept_id = t.concept_id
        WHERE t.target_type = 'core.transaction' AND t.target_id = ?`,
    )
    .get(txnId);
  expect(tag).toMatchObject({ notation: 'anomaly', confidence: 0.9 });
  const again = gw.invoke(owner, {
    command: 'finance.flag_anomaly',
    input: { txn_id: txnId, reason: 'still weird' },
    purpose: 'dpv:ServiceProvision',
  });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('not_already_flagged');
});
