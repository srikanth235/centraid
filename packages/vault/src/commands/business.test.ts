import { beforeEach, expect, test } from 'vitest';
import { bootstrapVault, type BootstrapResult } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { createGateway, Gateway } from '../gateway/gateway.js';
import type { Credential } from '../gateway/types.js';
import { uuidv7 } from '../ids.js';
import { registerBusinessCommands } from './business.js';

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let partyId: string;

beforeEach(() => {
  db = openVaultDb();
  boot = bootstrapVault(db, { ownerName: 'Priya' });
  gw = createGateway(db);
  registerBusinessCommands(gw);
  owner = { kind: 'device', deviceId: boot.deviceId, deviceKey: boot.deviceKey };
  partyId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'org', 'Acme Studio GmbH', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '0')`,
    )
    .run(partyId);
});

function invoke(command: string, input: Record<string, unknown>) {
  return gw.invoke(owner, { command, input, purpose: 'dpv:Billing' });
}

/** The draft-invoice output shape asserted across the invoice tests. */
interface InvoiceDraft extends Record<string, unknown> {
  invoice_id: string;
  number: string;
  total_minor: number;
  line_count: number;
}

function expectExecuted<T extends Record<string, unknown> = Record<string, unknown>>(
  command: string,
  input: Record<string, unknown>,
): T {
  const outcome = invoke(command, input);
  expect(outcome.status).toBe('executed');
  return (outcome as { output: T }).output;
}

function addClient(extra: Record<string, unknown> = {}): string {
  return expectExecuted<{ client_id: string }>('business.add_client', {
    party_id: partyId,
    currency: 'EUR',
    default_rate_minor: 9000, // €90.00/h
    ...extra,
  }).client_id;
}

function addProject(clientId: string, name = 'Website relaunch'): string {
  return expectExecuted<{ project_id: string }>('business.add_project', {
    client_id: clientId,
    name,
  }).project_id;
}

function logTime(
  projectId: string,
  extra: Record<string, unknown> = {},
): { entry_id: string; activity_id: string } {
  return expectExecuted<{ entry_id: string; activity_id: string }>('business.log_time', {
    project_id: projectId,
    started_at: '2026-07-01T09:00:00Z',
    ended_at: '2026-07-01T11:30:00Z', // 2.5h
    ...extra,
  });
}

/** A posted incoming payment the mark-paid flow can link against. */
function seedCreditTxn(amountMinor: number, currency = 'EUR'): string {
  const accountId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
       VALUES (?, ?, 'Business Giro', 'depository', ?, 1)`,
    )
    .run(accountId, boot.ownerPartyId, currency);
  const txnId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status, description)
       VALUES (?, ?, '2026-07-15T10:00:00Z', ?, ?, 'credit', 'posted', 'ACME STUDIO INVOICE')`,
    )
    .run(txnId, accountId, amountMinor, currency);
  return txnId;
}

test('add_client enrolls a party once; a second enrollment is refused', () => {
  const clientId = addClient();
  const row = db.vault.prepare('SELECT * FROM business_client WHERE client_id = ?').get(clientId);
  expect(row).toMatchObject({
    party_id: partyId,
    status: 'active',
    currency: 'EUR',
    default_rate_minor: 9000,
    payment_terms_days: 30,
  });
  const again = invoke('business.add_client', { party_id: partyId, currency: 'EUR' });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('party_not_already_a_client');
});

test('update_client moves a lead through the pipeline and revises the rate', () => {
  const clientId = addClient({ status: 'lead', default_rate_minor: 8000 });
  const won = invoke('business.update_client', {
    client_id: clientId,
    status: 'active',
    default_rate_minor: 9500,
  });
  expect(won.status).toBe('executed');
  const row = db.vault
    .prepare('SELECT status, default_rate_minor FROM business_client WHERE client_id = ?')
    .get(clientId);
  expect(row).toMatchObject({ status: 'active', default_rate_minor: 9500 });

  const ghost = invoke('business.update_client', { client_id: 'nope', status: 'past' });
  expect(ghost.status).toBe('failed');
  if (ghost.status === 'failed') expect(ghost.predicate).toContain('client_exists');
});

test('add_project needs a real client and a fresh name', () => {
  const missing = invoke('business.add_project', { client_id: 'ghost', name: 'X' });
  expect(missing.status).toBe('failed');
  const clientId = addClient();
  addProject(clientId, 'Brand refresh');
  const dup = invoke('business.add_project', { client_id: clientId, name: 'Brand refresh' });
  expect(dup.status).toBe('failed');
  if (dup.status === 'failed') expect(dup.predicate).toContain('project_name_unused_for_client');
});

test('log_time lands a canonical work activity plus an unbilled entry with the client default rate', () => {
  const clientId = addClient();
  const projectId = addProject(clientId);
  const { entry_id, activity_id } = logTime(projectId, { note: 'wireframes' });
  const entry = db.vault
    .prepare('SELECT * FROM business_time_entry WHERE entry_id = ?')
    .get(entry_id);
  expect(entry).toMatchObject({
    activity_id,
    project_id: projectId,
    billable: 1,
    rate_minor: 9000, // inherited from the client
    invoice_line_id: null,
  });
  const activity = db.vault
    .prepare(
      `SELECT a.started_at, a.ended_at, c.notation FROM core_activity a
        JOIN core_concept c ON c.concept_id = a.kind_concept_id WHERE a.activity_id = ?`,
    )
    .get(activity_id);
  expect(activity).toMatchObject({ notation: 'work' });
  // The session remark is a memo annotation on the canonical activity
  // (issue #274), never an activity column.
  const memo = db.vault
    .prepare(
      `SELECT body_text FROM knowledge_annotation
        WHERE target_type = 'core.activity' AND target_id = ?`,
    )
    .get(activity_id) as { body_text: string };
  expect(memo.body_text).toBe('wireframes');
});

test('log_time refuses inactive projects and inverted intervals', () => {
  const clientId = addClient();
  const proposed = expectExecuted<{ project_id: string }>('business.add_project', {
    client_id: clientId,
    name: 'Maybe later',
    status: 'proposed',
  }).project_id;
  const early = invoke('business.log_time', {
    project_id: proposed,
    started_at: '2026-07-01T09:00:00Z',
    ended_at: '2026-07-01T10:00:00Z',
  });
  expect(early.status).toBe('failed');
  if (early.status === 'failed') expect(early.predicate).toContain('project_exists_and_active');

  const projectId = addProject(clientId);
  const inverted = invoke('business.log_time', {
    project_id: projectId,
    started_at: '2026-07-01T11:00:00Z',
    ended_at: '2026-07-01T09:00:00Z',
  });
  expect(inverted.status).toBe('failed');
  if (inverted.status === 'failed') expect(inverted.predicate).toContain('interval_is_positive');
});

test('create_draft_invoice bills unbilled entries, totals reconcile, entries get marked', () => {
  const clientId = addClient();
  const projectId = addProject(clientId);
  const e1 = logTime(projectId); // 2.5h × €90 = €225.00
  const e2 = logTime(projectId, {
    started_at: '2026-07-02T09:00:00Z',
    ended_at: '2026-07-02T10:00:00Z', // 1h × €90 = €90.00
  });
  const out = expectExecuted<InvoiceDraft>('business.create_draft_invoice', {
    client_id: clientId,
    entry_ids: [e1.entry_id, e2.entry_id],
    due_on: '2099-08-01',
  });
  expect(out.line_count).toBe(2);
  expect(out.total_minor).toBe(22500 + 9000);
  expect(out.number).toMatch(/^INV-\d{4}-0001$/);
  const invoice = db.vault
    .prepare('SELECT status, total_minor, currency FROM business_invoice WHERE invoice_id = ?')
    .get(out.invoice_id);
  expect(invoice).toMatchObject({ status: 'draft', total_minor: 31500, currency: 'EUR' });
  const billed = db.vault
    .prepare(
      'SELECT count(*) AS n FROM business_time_entry WHERE entry_id IN (?, ?) AND invoice_line_id IS NOT NULL',
    )
    .get(e1.entry_id, e2.entry_id) as { n: number };
  expect(billed.n).toBe(2);
  // qty_scaled convention: hours × 100, with the paired scale stored (issue
  // #441 A3): qty_scale = 2, and amount_minor never negative.
  const lines = db.vault
    .prepare(
      'SELECT qty_scaled, qty_scale, amount_minor FROM business_invoice_line WHERE invoice_id = ? ORDER BY qty_scaled',
    )
    .all(out.invoice_id) as { qty_scaled: number; qty_scale: number; amount_minor: number }[];
  expect(lines.map((l) => l.qty_scaled)).toEqual([100, 250]);
  expect(lines.map((l) => l.qty_scale)).toEqual([2, 2]);
  expect(lines.every((l) => l.amount_minor >= 0)).toBe(true);
});

test('business_invoice_line carries a NOT NULL qty_scale and CHECKs its scale + amount (issue #441 A3)', () => {
  const cols = db.vault.prepare("PRAGMA table_info('business_invoice_line')").all() as {
    name: string;
    notnull: number;
  }[];
  const qtyScale = cols.find((c) => c.name === 'qty_scale');
  expect(qtyScale).toBeDefined();
  expect(qtyScale?.notnull).toBe(1);

  const ddl = (
    db.vault
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='business_invoice_line'")
      .get() as { sql: string }
  ).sql;
  expect(ddl).toContain('CHECK (qty_scale BETWEEN 0 AND 9)');
  expect(ddl).toContain('CHECK (amount_minor >= 0)');
});

test('double-billing a time entry is a receipted refusal that rolls everything back', () => {
  const clientId = addClient();
  const projectId = addProject(clientId);
  const e1 = logTime(projectId);
  expectExecuted('business.create_draft_invoice', {
    client_id: clientId,
    entry_ids: [e1.entry_id],
    due_on: '2099-08-01',
  });
  const again = invoke('business.create_draft_invoice', {
    client_id: clientId,
    entry_ids: [e1.entry_id],
    due_on: '2099-08-01',
  });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.reason).toContain('already invoiced');
  // The rolled-back attempt left no second invoice behind.
  const invoices = db.vault.prepare('SELECT count(*) AS n FROM business_invoice').get() as {
    n: number;
  };
  expect(invoices.n).toBe(1);
});

test('invoice numbers are sequential per year', () => {
  const clientId = addClient();
  const projectId = addProject(clientId);
  const e1 = logTime(projectId);
  const e2 = logTime(projectId, {
    started_at: '2026-07-02T09:00:00Z',
    ended_at: '2026-07-02T10:00:00Z',
  });
  const first = expectExecuted<InvoiceDraft>('business.create_draft_invoice', {
    client_id: clientId,
    entry_ids: [e1.entry_id],
    due_on: '2099-08-01',
  });
  const second = expectExecuted<InvoiceDraft>('business.create_draft_invoice', {
    client_id: clientId,
    entry_ids: [e2.entry_id],
    due_on: '2099-08-01',
  });
  expect(second.number.endsWith('-0002')).toBe(true);
  expect(first.number.slice(0, -4)).toBe(second.number.slice(0, -4));
});

test('send_invoice moves draft → sent once; a second send is refused', () => {
  const clientId = addClient();
  const projectId = addProject(clientId);
  const e1 = logTime(projectId);
  const { invoice_id } = expectExecuted<InvoiceDraft>('business.create_draft_invoice', {
    client_id: clientId,
    entry_ids: [e1.entry_id],
    due_on: '2099-08-01',
  });
  const sent = expectExecuted('business.send_invoice', { invoice_id });
  expect(sent.status).toBe('sent');
  const again = invoke('business.send_invoice', { invoice_id });
  expect(again.status).toBe('failed');
  if (again.status === 'failed') expect(again.predicate).toContain('invoice_is_draft');
});

test('mark_invoice_paid links a plausible posted credit and refuses implausible ones', () => {
  const clientId = addClient();
  const projectId = addProject(clientId);
  const e1 = logTime(projectId); // €225.00
  const { invoice_id, total_minor } = expectExecuted<InvoiceDraft>(
    'business.create_draft_invoice',
    {
      client_id: clientId,
      entry_ids: [e1.entry_id],
      due_on: '2099-08-01',
    },
  );

  // Paying a draft is refused — only sent/overdue invoices settle.
  const tooEarly = invoke('business.mark_invoice_paid', {
    invoice_id,
    txn_id: seedCreditTxn(total_minor),
  });
  expect(tooEarly.status).toBe('failed');

  expectExecuted('business.send_invoice', { invoice_id });

  // A partial payment is not "paid".
  const short = invoke('business.mark_invoice_paid', {
    invoice_id,
    txn_id: seedCreditTxn(total_minor - 1),
  });
  expect(short.status).toBe('failed');
  if (short.status === 'failed') expect(short.predicate).toContain('transaction_plausibly_settles');

  // Currency must match.
  const wrongCurrency = invoke('business.mark_invoice_paid', {
    invoice_id,
    txn_id: seedCreditTxn(total_minor, 'INR'),
  });
  expect(wrongCurrency.status).toBe('failed');

  // The real settlement (overpayment allowed).
  const txnId = seedCreditTxn(total_minor + 500);
  const paid = expectExecuted('business.mark_invoice_paid', { invoice_id, txn_id: txnId });
  expect(paid.status).toBe('paid');
  const row = db.vault
    .prepare('SELECT status, paid_txn_id FROM business_invoice WHERE invoice_id = ?')
    .get(invoice_id);
  expect(row).toMatchObject({ status: 'paid', paid_txn_id: txnId });
});
